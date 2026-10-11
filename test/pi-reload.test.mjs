import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PiHost, PiError } from '../src/main/piHost.ts'

class Child extends EventEmitter {
  sent = []
  killed = false
  exitOnKill = true
  checkpointFails = false
  resumeFails = false
  silent = false
  postMessage(message) {
    this.sent.push(message)
    if (this.silent) return
    if (message.command === 'checkpoint' && this.checkpointFails) return queueMicrotask(() => this.emit('message', { id: message.id, type: 'error', code: 'failed', error: 'close failed' }))
    if (message.command === 'resume' && this.resumeFails) return queueMicrotask(() => this.emit('message', { id: message.id, type: 'error', code: 'closed', error: 'storage is closed' }))
    if (message.command === 'checkpoint' || message.command === 'resume') queueMicrotask(() => this.emit('message', { id: message.id, type: 'done' }))
  }
  kill() {
    this.killed = true
    if (this.exitOnKill) queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

// 假时钟：退避、超时、稳定计时都要逐步推进，不能真等。
function fakeClock() {
  const timers = new Map()
  let id = 0
  const clock = {
    value: 0,
    now: () => clock.value,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: clock.value + ms }); return key },
    clearTimeout: key => timers.delete(key),
    timers,
    async advance(ms) {
      const end = clock.value + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        clock.value = next[1].at
        next[1].fn()
        await tick()
      }
      clock.value = end
    },
  }
  return clock
}

function harness(options = {}) {
  const children = []
  const events = []
  const clock = options.clock ?? fakeClock()
  const host = new PiHost(() => {
    const child = new Child()
    children.push(child)
    options.onFork?.(child, children.length)
    return child
  }, event => events.push(event), { clock })
  const ready = (index = children.length - 1) => children[index].emit('message', { type: 'ready' })
  const last = child => child.sent.at(-1)
  return { host, children, events, clock, ready, last }
}

test('Pi replacement waits for readiness, rejects dead requests, and ignores an old process exit', async () => {
  const { host, children, ready, last } = harness()
  const initialized = host.init()
  ready()
  await initialized
  try {
    const replacement = host.restart()
    await tick()
    assert.equal(children[0].killed, false, 'Keep the old process until the replacement is ready')
    ready()
    await replacement
    assert.equal(children[0].killed, true)
    children[0].emit('exit', 0)
    assert.equal(host.error, '')
    const reply = host.request('model.list', { sessionId: 'one' })
    await tick()
    children[1].emit('message', { id: last(children[1]).id, type: 'done', current: 'new worker' })
    assert.equal((await reply).current, 'new worker')
    const interrupted = host.request('session.load', { sessionId: 'one' })
    const rejected = assert.rejects(interrupted, error => error instanceof PiError && error.code === 'worker_exit' && /exited/.test(error.message))
    await tick()
    children[1].emit('exit', 1)
    await rejected
    assert.equal(children.length, 2, 'A crash must not replay a command on the spot')
  } finally { host.dispose() }
})

test('failed Pi replacement leaves the old process usable', async () => {
  const children = []
  const host = new PiHost(() => {
    const child = new Child()
    children.push(child)
    queueMicrotask(() => child.emit('message', children.length === 1 ? { type: 'ready' } : { type: 'ready', error: 'bad extension' }))
    return child
  })
  await host.init()
  try {
    await assert.rejects(host.restart(), /bad extension/)
    assert.deepEqual(children[0].sent.map(message => message.command), ['checkpoint', 'resume'], 'The old worker reopens its storage after a failed replacement')
    assert.equal(children[0].killed, false)
    assert.equal(children[1].killed, true)
    assert.equal(host.error, '')
    await host.request('checkpoint')
  } finally { host.dispose() }
})

test('a replacement that fails while the old worker cannot resume either marks the worker down and respawns it', async () => {
  const { host, children, events, clock, ready } = harness({
    onFork: (child, count) => {
      if (count === 1) child.resumeFails = true
      if (count === 2) queueMicrotask(() => child.emit('message', { type: 'ready', error: 'bad extension' }))
    },
  })
  const initialized = host.init()
  ready()
  await initialized
  try {
    await assert.rejects(host.restart(), /bad extension/)
    assert.deepEqual(children[0].sent.map(message => message.command), ['checkpoint', 'resume'])
    assert.equal(children[0].killed, true, 'a worker that cannot take its storage back is not left in place answering closed')
    assert.deepEqual(events.map(event => event.name), ['worker.ready', 'worker.down'], 'the floor is told the worker is gone')
    assert.ok(host.error)
    assert.equal(children.length, 2, 'the respawn waits out the backoff')
    await clock.advance(1000)
    await tick()
    assert.equal(children.length, 3)
    ready()
    await tick()
    assert.equal(events.at(-1).name, 'worker.ready')
    assert.equal(host.error, '')
  } finally { host.dispose() }
})

test('a checkpoint that fails retires the old worker and waits for its exit before the replacement starts', async () => {
  const forks = []
  const { host, children, ready, events } = harness({ onFork: (child, count) => { forks.push(count); if (count === 1) { child.checkpointFails = true; child.exitOnKill = false } } })
  const initialized = host.init()
  ready()
  await initialized
  try {
    const replacement = host.restart()
    await tick()
    await tick()
    assert.equal(children[0].killed, true, 'a worker that did not confirm checkpoint is killed')
    assert.deepEqual(forks, [1], 'two workers must never hold the storage at once: no replacement before the old one has exited')
    children[0].emit('exit', 137)
    await tick()
    assert.deepEqual(forks, [1, 2])
    ready()
    await replacement
    assert.equal(children[0].sent.some(message => message.command === 'resume'), false)
    assert.deepEqual(events.map(event => event.name), ['worker.ready', 'worker.down', 'worker.ready'], 'the retired worker counts as a crash for the floor')
  } finally { host.dispose() }
})

test('worker events reach the host only from the adopted process and keep their payload', async () => {
  const children = []
  const events = []
  const host = new PiHost(() => {
    const child = new Child()
    children.push(child)
    queueMicrotask(() => child.emit('message', { type: 'ready' }))
    return child
  }, event => events.push(event))
  await host.init()
  try {
    children[0].emit('message', { type: 'event', name: 'task.report-ready', sessionId: 'one', id: 'r1' })
    await host.restart()
    children[0].emit('message', { type: 'event', name: 'task.report-ready', sessionId: 'stale', id: 'r0' })
    children[1].emit('message', { type: 'event', name: 'task.report-ready', sessionId: 'two', id: 'r2' })
    assert.deepEqual(events.filter(event => event.name === 'task.report-ready').map(event => [event.sessionId, event.id]), [['one', 'r1'], ['two', 'r2']])
  } finally { host.dispose() }
})

test('a Pi child that exits during the ready handshake is never adopted', async () => {
  const { host, children, events } = harness({ onFork: child => queueMicrotask(() => { child.emit('message', { type: 'ready' }); child.emit('exit', 1) }) })
  try {
    await host.init()
    assert.match(host.error, /exited/)
    assert.equal(events.some(event => event.name === 'worker.ready'), false)
    assert.equal(children.length, 1)
  } finally { host.dispose() }
})

test('parameters travel nested so that a report id cannot overwrite the packet id', async () => {
  const { host, ready, children } = harness()
  const initialized = host.init()
  ready()
  await initialized
  try {
    host.request('report.deliver', { sessionId: 'one', id: 'r1', turnId: 't1' }).catch(() => {})
    host.request('session.list').catch(() => {})
    await tick()
    const [deliver, list] = children[0].sent
    assert.deepEqual(deliver.params, { sessionId: 'one', id: 'r1', turnId: 't1' })
    assert.equal(deliver.command, 'report.deliver')
    assert.notEqual(deliver.id, 'r1', 'the packet id stays the correlation id')
    assert.match(deliver.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(list.params, {}, 'commands without parameters still carry an empty params object')
    assert.deepEqual(Object.keys(deliver).sort(), ['command', 'id', 'params'])
  } finally { host.dispose() }
})

test('error replies keep their code, aborted is a reply rather than a failure, and done carries the result', async () => {
  const { host, ready, children, last } = harness()
  const initialized = host.init()
  ready()
  await initialized
  try {
    const answer = async (command, reply) => {
      const pending = host.request(command, { sessionId: 'one' })
      await tick()
      children[0].emit('message', { id: last(children[0]).id, ...reply })
      return pending
    }
    await assert.rejects(answer('chat.submit', { type: 'error', code: 'busy', error: 'Conversation is busy' }), error => error instanceof PiError && error.code === 'busy' && error.message === 'Conversation is busy')
    await assert.rejects(answer('session.load', { type: 'error', error: 'boom' }), error => error.code === 'failed', 'a worker that sends no code is "failed"')
    assert.equal((await answer('chat.submit', { type: 'aborted' })).type, 'aborted')
    assert.deepEqual(await answer('session.list', { type: 'done', currentId: 'one', sessions: [] }), { id: last(children[0]).id, type: 'done', currentId: 'one', sessions: [] })
  } finally { host.dispose() }
})

test('commands time out per kind: 15 s to accept a turn, 30 s for checkpoint and delete, 60 s by default', async () => {
  const { host, ready, clock, children } = harness()
  const initialized = host.init()
  ready()
  await initialized
  children[0].silent = true
  try {
    for (const [command, limit] of [['chat.submit', 15_000], ['report.deliver', 15_000], ['checkpoint', 30_000], ['session.delete', 30_000], ['model.list', 20_000], ['model.set', 20_000], ['memory.list', 60_000], ['session.list', 60_000]]) {
      let outcome = 'pending'
      const request = host.request(command, { sessionId: 's', turnId: `turn-${command}` }).then(() => 'done', error => error.code)
      request.then(value => { outcome = value })
      await tick()
      await clock.advance(limit - 1)
      await tick()
      assert.equal(outcome, 'pending', `${command} must still be waiting at ${limit - 1} ms`)
      await clock.advance(1)
      await tick()
      assert.equal(outcome, 'timeout', command)
    }
  } finally { host.dispose() }
})

test('events and exits are announced: worker.ready on adoption, worker.down then turn.error for accepted turns only', async () => {
  const { host, children, events, ready, last } = harness()
  const initialized = host.init()
  ready()
  await initialized
  assert.deepEqual(events.map(event => event.name), ['worker.ready'])
  try {
    const submit = (turnId, sessionId = 'one') => host.request('chat.submit', { sessionId, turnId, text: 'hi' })
    const accepted = submit('accepted')
    await tick()
    children[0].emit('message', { id: last(children[0]).id, type: 'done', requestId: 'turn:accepted' })
    await accepted
    const finished = submit('finished')
    await tick()
    children[0].emit('message', { id: last(children[0]).id, type: 'done' })
    await finished
    children[0].emit('message', { type: 'event', name: 'turn.done', sessionId: 'one', turnId: 'finished', kind: 'user', text: '' })
    const unacknowledged = submit('unacknowledged')
    const rejected = assert.rejects(unacknowledged, error => error.code === 'worker_exit')
    const report = host.request('report.deliver', { sessionId: 'two', id: 'r1', turnId: 'report-turn' })
    await tick()
    children[0].emit('message', { id: last(children[0]).id, type: 'done', status: 'started' })
    await report
    const refused = host.request('report.deliver', { sessionId: 'two', id: 'r2', turnId: 'refused-turn' })
    await tick()
    children[0].emit('message', { id: last(children[0]).id, type: 'done', status: 'already' })
    await refused
    events.length = 0
    children[0].emit('exit', 9)
    await rejected
    assert.deepEqual(events.map(event => event.name), ['worker.down', 'turn.error', 'turn.error'])
    const errors = events.filter(event => event.name === 'turn.error')
    assert.deepEqual(errors.map(event => [event.turnId, event.kind, event.sessionId, event.code]).sort(), [['accepted', 'user', 'one', 'worker_exit'], ['report-turn', 'report', 'two', 'worker_exit']])
    assert.match(errors[0].error, /exited \(9\)/)
  } finally { host.dispose() }
})

test('a crashed worker is restarted with 1, 2, 4, 8 and 16 second backoff, then left alone until a command asks', async () => {
  const { host, children, events, clock, ready } = harness({ onFork: (child, count) => { if (count > 1 && count < 7) queueMicrotask(() => child.emit('exit', 1)) } })
  const initialized = host.init()
  ready()
  await initialized
  try {
    children[0].emit('exit', 1)
    assert.equal(children.length, 1, 'the first retry waits one second')
    for (const [attempt, delay] of [[2, 1000], [3, 2000], [4, 4000], [5, 8000], [6, 16000]]) {
      await clock.advance(delay - 1)
      assert.equal(children.length, attempt - 1, `attempt ${attempt} is not early`)
      await clock.advance(1)
      await tick()
      assert.equal(children.length, attempt, `attempt ${attempt} after ${delay} ms`)
    }
    await clock.advance(120_000)
    assert.equal(children.length, 6, 'five failed retries end the automatic restarts')
    assert.ok(host.error)
    assert.equal(events.filter(event => event.name === 'worker.down').length, 1)
    children[5].exitOnKill = true
    // 下一条命令惰性重拉，并重新给一轮预算。
    const lazy = host.request('session.list')
    await tick()
    assert.equal(children.length, 7)
    children[6].emit('message', { type: 'ready' })
    await tick()
    children[6].emit('message', { id: children[6].sent.at(-1).id, type: 'done', sessions: [] })
    await lazy
    assert.equal(events.at(-1).name, 'worker.ready')
  } finally { host.dispose() }
})

test('a worker that stayed up for a minute starts the backoff over', async () => {
  const { host, children, clock, ready } = harness()
  const initialized = host.init()
  ready()
  await initialized
  try {
    children[0].emit('exit', 1)
    await clock.advance(1000)
    await tick()
    assert.equal(children.length, 2)
    ready()
    await tick()
    await clock.advance(60_000)
    children[1].emit('exit', 1)
    await clock.advance(999)
    assert.equal(children.length, 2)
    await clock.advance(1)
    await tick()
    assert.equal(children.length, 3, 'after a stable minute the next crash retries after one second again')
  } finally { host.dispose() }
})

test('a worker that fails to come up at startup is retried in the background', async () => {
  const { host, children, clock } = harness({ onFork: (child, count) => { if (count === 1) queueMicrotask(() => child.emit('message', { type: 'ready', error: 'lock held' })) } })
  await host.init()
  try {
    assert.match(host.error, /lock held/)
    await clock.advance(1000)
    await tick()
    assert.equal(children.length, 2)
    children[1].emit('message', { type: 'ready' })
    await tick()
    assert.equal(host.error, '')
  } finally { host.dispose() }
})

test('abort never starts a worker, and dispose settles everything and stops the retries', async () => {
  const { host, children, clock, ready } = harness()
  await host.abort('one')
  assert.equal(children.length, 0)
  const initialized = host.init()
  ready()
  await initialized
  children[0].silent = true
  const pending = host.request('session.list').then(() => 'done', error => error.code)
  await tick()
  host.dispose()
  assert.equal(await pending, 'closed')
  assert.equal(children[0].killed, true)
  await clock.advance(60_000)
  assert.equal(children.length, 1)

  const crashed = harness()
  const started = crashed.host.init()
  crashed.ready()
  await started
  crashed.children[0].emit('exit', 1)
  crashed.host.dispose()
  await crashed.clock.advance(60_000)
  assert.equal(crashed.children.length, 1, 'a disposed host never restarts the worker')
})
