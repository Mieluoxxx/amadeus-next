import assert from 'node:assert/strict'
import test from 'node:test'
import { Floor, BUSY_RETRIES, BUSY_RETRY_MS, DEFER_BACKOFF_MS, REPORT_DEBOUNCE_MS, SETTLE_MS } from '../src/main/floor.ts'

// 假时钟 + 记录所有副作用；回合的生命周期由测试手动推进，和 AppRuntime 的 activeTurn 一一对应。
function harness(overrides = {}) {
  const clock = { value: 1_000_000 }
  const timers = new Map()
  let timerId = 0
  const log = []
  const delivered = []
  const world = {
    turn: null,
    gates: { blocked: false, sceneReady: true, proactive: true, sessionId: 's1' },
    micOk: true,
    ...overrides,
  }
  const advance = ms => {
    const end = clock.value + ms
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      timers.delete(next[0])
      clock.value = next[1].at
      next[1].fn()
    }
    clock.value = end
  }
  const floor = new Floor({
    clock: {
      now: () => clock.value,
      setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: clock.value + ms }); return id },
      clearTimeout: id => timers.delete(id),
    },
    gates: () => world.gates,
    turn: () => world.turn,
    speechStart: () => { log.push('start'); return world.micOk ? { ok: true } : { ok: false, error: 'no mic' } },
    speechStop: () => { log.push('stop') },
    speechFinish: manual => { log.push(`finish:${manual}`); return { ok: true } },
    deliver: report => { log.push(`deliver:${report.id}`); delivered.push(report); world.turn = { kind: 'report', piDone: false, drained: false } },
    flushReload: () => { log.push('flush') },
  })
  const count = name => log.filter(entry => entry === name).length
  const userTurn = () => { world.turn = { kind: 'user', piDone: false, drained: false } }
  const endTurn = () => { world.turn = { ...world.turn, piDone: true, drained: true }; floor.pump() }
  const report = (id, sessionId = 's1') => ({ sessionId, id, title: id, status: 'done' })
  return { floor, world, log, delivered, count, advance, timers, userTurn, endTurn, report, clock }
}

test('row 1: asr.start opens the mic when gates pass, otherwise only records the intent', () => {
  const t = harness({ gates: { blocked: false, sceneReady: false, proactive: true, sessionId: 's1' } })
  assert.deepEqual(t.floor.asrStart(), { ok: true })
  assert.equal(t.floor.state(), 'idle')
  assert.equal(t.count('start'), 0, 'a scene that is not ready keeps the mic closed')
  t.world.gates = { ...t.world.gates, sceneReady: true }
  t.floor.wake()
  assert.equal(t.count('start'), 1)
  assert.equal(t.floor.state(), 'armed')
})

test('row 1: a failed mic start reports the error and clears the intent', () => {
  const t = harness({ micOk: false })
  assert.deepEqual(t.floor.asrStart(), { ok: false, error: 'no mic' })
  assert.equal(t.floor.listeningEnabled, false)
  assert.equal(t.floor.state(), 'idle')
})

test('rows 2 to 4: partial text means hearing; an automatic final starts a turn, a manual final stays a draft', () => {
  const t = harness()
  t.floor.asrStart()
  assert.equal(t.floor.recognized('', false, false), 'forward')
  assert.equal(t.floor.state(), 'armed', 'an empty partial is not speech')
  t.floor.recognized('你好', false, false)
  assert.equal(t.floor.state(), 'hearing')
  assert.equal(t.floor.recognized('你好', true, false), 'turn')
  assert.equal(t.floor.state(), 'idle', 'the recogniser is finished once the final arrives')
  assert.equal(t.floor.listeningEnabled, true, 'the intent survives so the mic can come back after the reply')

  const manual = harness()
  manual.floor.asrStart()
  manual.floor.recognized('草稿', false, false)
  assert.equal(manual.floor.recognized('草稿', true, true), 'forward')
  assert.equal(manual.floor.listeningEnabled, false)
  assert.equal(manual.floor.state(), 'idle')
})

test('a final is dropped while a reply is running or a reload is pending', () => {
  for (const setup of [
    t => t.userTurn(),
    t => { t.world.gates = { ...t.world.gates, blocked: true } },
  ]) {
    const t = harness()
    t.floor.asrStart()
    setup(t)
    assert.equal(t.floor.recognized('说话', true, false), 'drop')
  }
  const quiet = harness()
  quiet.floor.asrStart()
  assert.equal(quiet.floor.recognized('   ', true, false), 'drop', 'a blank final starts nothing')
  const off = harness()
  assert.equal(off.floor.recognized('说话', true, false), 'drop', 'without the listening intent a late final is ignored')
})

test('row 5: errors and no-speech turn the listening intent off, and a quiet idle status only ends recognition', () => {
  for (const [status, reason] of [['error'], ['idle', 'no-speech']]) {
    const t = harness()
    t.floor.asrStart()
    t.floor.recognized('你', false, false)
    t.floor.status(status, reason)
    assert.equal(t.floor.listeningEnabled, false, status)
    assert.equal(t.floor.state(), 'idle', status)
  }
  const t = harness()
  t.floor.asrStart()
  t.floor.status('idle')
  assert.equal(t.floor.listeningEnabled, true)
  assert.equal(t.floor.state(), 'idle')
  t.floor.status('listening')
  assert.equal(t.floor.state(), 'armed')
  t.floor.status('processing')
  assert.equal(t.floor.state(), 'armed', 'processing is not the end of recognition')
})

test('row 6: asr.stop finishes manually and keeps waiting for the final result', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.recognized('半句', false, false)
  assert.deepEqual(t.floor.asrStop(), { ok: true })
  assert.equal(t.count('finish:true'), 1)
  assert.equal(t.floor.listeningEnabled, false)
  assert.equal(t.floor.state(), 'hearing', 'a requested finish is still hearing until the result arrives')
  assert.equal(t.floor.recognized('半句话', true, true), 'forward')
  assert.equal(t.floor.state(), 'idle')
})

test('rows 7 and 8: typed input preempts any state, clears the draft and silences the mic', () => {
  for (const prepare of ['idle', 'armed', 'hearing', 'settling']) {
    const t = harness()
    t.floor.asrStart()
    if (prepare === 'hearing') t.floor.recognized('x', false, false)
    if (prepare === 'settling') { t.floor.stopMic(); t.floor.playbackEnded() }
    t.floor.setComposing(true)
    t.floor.preempt()
    assert.equal(t.floor.composing, false, prepare)
    assert.notEqual(t.floor.state(), 'armed', prepare)
    assert.notEqual(t.floor.state(), 'hearing', prepare)
    assert.equal(t.log.at(-1), 'stop', prepare)
    assert.equal(t.floor.listeningEnabled, true, `${prepare}: preempting keeps the listening intent`)
  }
})

test('rows 11 to 13 and 16: the mic returns one second after playback ends, not after the model does', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.preempt()
  t.userTurn()
  assert.equal(t.floor.state(), 'responding')
  t.world.turn.piDone = true
  t.floor.pump()
  assert.equal(t.floor.state(), 'responding', 'the model finishing is not enough while audio is still playing')
  t.floor.playbackEnded()
  t.world.turn.drained = true
  t.floor.pump()
  assert.equal(t.floor.state(), 'settling')
  t.advance(SETTLE_MS - 1)
  assert.equal(t.count('start'), 1, 'only the initial open so far')
  t.advance(1)
  assert.equal(t.count('start'), 2)
  assert.equal(t.floor.state(), 'armed')
})

test('a playback error skips the settle buffer and goes straight back to idle', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.preempt()
  t.userTurn()
  t.world.turn.piDone = true
  t.world.turn.drained = true
  t.floor.pump()
  assert.equal(t.floor.state(), 'armed', 'no buffer without a successful playback, the mic reopens at once')
})

test('rule 2: the recogniser is never open while a turn is running', () => {
  const t = harness()
  t.userTurn()
  t.floor.asrStart()
  assert.equal(t.count('start'), 0)
  t.floor.pump()
  assert.equal(t.count('start'), 0)
  assert.equal(t.floor.state(), 'responding')
})

test('row 17: an idle floor delivers a ready report at once, and only for the current session', () => {
  const t = harness()
  t.floor.reportReady(t.report('r-other', 's2'))
  assert.equal(t.count('deliver:r-other'), 0, 'reports for other sessions only wait')
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.count('deliver:r1'), 1)
  assert.equal(t.floor.state(), 'responding')
  t.world.gates = { ...t.world.gates, sessionId: 's2' }
  t.endTurn()
  t.floor.reportResult(t.report('r1'), 'started')
  t.floor.wake()
  assert.equal(t.count('deliver:r-other'), 1, 'switching to that session lets its report speak')
})

test('row 17: every gate holds a report back and releasing it lets the report through', () => {
  const closed = [
    ['scene', t => { t.world.gates = { ...t.world.gates, sceneReady: false } }, t => { t.world.gates = { ...t.world.gates, sceneReady: true } }],
    ['blocked', t => { t.world.gates = { ...t.world.gates, blocked: true } }, t => { t.world.gates = { ...t.world.gates, blocked: false } }],
    ['proactive off', t => { t.world.gates = { ...t.world.gates, proactive: false } }, t => { t.world.gates = { ...t.world.gates, proactive: true } }],
    ['draft', t => t.floor.setComposing(true), t => t.floor.setComposing(false)],
    ['worker down', t => t.floor.workerDown(), t => t.floor.workerUp()],
  ]
  for (const [name, close, open] of closed) {
    const t = harness()
    close(t)
    t.floor.reportReady(t.report('r1'))
    t.floor.wake()
    assert.equal(t.count('deliver:r1'), 0, name)
    open(t)
    // worker 重启会清空缓存，汇报由新 worker 重放。
    if (name === 'worker down') t.floor.reportReady(t.report('r1'))
    else if (name !== 'draft') t.floor.wake()
    assert.equal(t.count('deliver:r1'), 1, name)
  }
})

test('row 18: an armed floor lets a report in only after 500 ms without a word, then switches the mic off', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.floor.state(), 'armed')
  t.advance(REPORT_DEBOUNCE_MS - 1)
  assert.equal(t.count('deliver:r1'), 0)
  t.advance(1)
  assert.equal(t.count('deliver:r1'), 1)
  assert.equal(t.log.lastIndexOf('stop') < t.log.indexOf('deliver:r1'), true, 'the mic is closed before the report speaks')
  assert.equal(t.floor.state(), 'responding')
})

test('row 18: speech inside the debounce window cancels the interruption', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.reportReady(t.report('r1'))
  t.advance(300)
  t.floor.recognized('等一下', false, false)
  t.advance(2000)
  assert.equal(t.count('deliver:r1'), 0)
  assert.equal(t.floor.state(), 'hearing')
})

test('row 19: a hearing floor queues the report and never talks over the owner', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.recognized('我想问', false, false)
  t.floor.reportReady(t.report('r1'))
  t.advance(10_000)
  assert.equal(t.count('deliver:r1'), 0)
  assert.equal(t.floor.pendingCount('s1'), 1)
  // 主人说完 -> 起用户回合 -> 回合结束后汇报才排到。
  assert.equal(t.floor.recognized('我想问个问题', true, false), 'turn')
  t.floor.preempt()
  t.userTurn()
  t.floor.playbackEnded()
  t.endTurn()
  assert.equal(t.count('deliver:r1'), 0, 'the settle buffer comes first')
  t.advance(SETTLE_MS)
  assert.equal(t.count('deliver:r1'), 1)
})

test('rule 4: typed input preempts a report; the interrupted report is not redelivered', () => {
  const t = harness()
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.count('deliver:r1'), 1)
  t.floor.reportResult(t.report('r1'), 'started')
  t.floor.preempt()
  t.world.turn = null
  t.floor.pump()
  t.advance(60_000)
  assert.equal(t.count('deliver:r1'), 1, 'a started report is final even when the owner cut it off')
})

test('row 20: a busy refusal retries after a second, five times at most, then waits for an outside event', () => {
  const t = harness()
  t.floor.reportReady(t.report('r1'))
  for (let attempt = 1; attempt <= BUSY_RETRIES + 1; attempt++) {
    assert.equal(t.count('deliver:r1'), attempt, `attempt ${attempt}`)
    t.world.turn = null
    t.floor.reportResult(t.report('r1'), 'busy')
    t.floor.pump()
    if (attempt <= BUSY_RETRIES) {
      t.advance(BUSY_RETRY_MS - 1)
      assert.equal(t.count('deliver:r1'), attempt, 'not before one second')
      t.advance(1)
    }
  }
  t.advance(60_000)
  assert.equal(t.count('deliver:r1'), BUSY_RETRIES + 1, 'no hot loop after the retries are used up')
  assert.equal(t.floor.pendingCount('s1'), 1, 'the report is still pending')
  t.floor.wake()
  assert.equal(t.count('deliver:r1'), BUSY_RETRIES + 2, 'an outside event gives it a fresh round')
})

test('row 21: a deferred report backs off 1, 2, 4, 8, 16, then 30 seconds instead of being redelivered at once', () => {
  assert.deepEqual(DEFER_BACKOFF_MS, [1000, 2000, 4000, 8000, 16000, 30000])
  const t = harness()
  t.floor.reportReady(t.report('r1'))
  let delivered = 1
  for (const delay of [...DEFER_BACKOFF_MS, 30_000, 30_000]) {
    assert.equal(t.count('deliver:r1'), delivered)
    t.world.turn = null
    t.floor.reportResult(t.report('r1'), 'deferred')
    t.floor.pump()
    assert.equal(t.count('deliver:r1'), delivered, 'a deferral is not retried on the spot')
    t.advance(delay - 1)
    assert.equal(t.count('deliver:r1'), delivered, `not before ${delay} ms`)
    t.advance(1)
    delivered++
  }
  assert.equal(t.count('deliver:r1'), delivered)
  assert.equal(t.floor.pendingCount('s1'), 1, 'the report is kept throughout')
})

test('row 21: a deferral holds back every report, an outside event retries early, and a worker restart starts the backoff over', () => {
  const t = harness()
  t.floor.reportReady(t.report('r1'))
  t.floor.reportReady(t.report('r2'))
  t.world.turn = null
  t.floor.reportResult(t.report('r1'), 'deferred')
  t.floor.pump()
  t.advance(999)
  assert.equal(t.count('deliver:r2'), 0, 'with the worker unavailable no other report is tried either')
  t.floor.wake()
  assert.equal(t.count('deliver:r1'), 2, 'an outside event retries before the timer')
  t.world.turn = null
  t.floor.reportResult(t.report('r1'), 'deferred')
  t.advance(1999)
  assert.equal(t.count('deliver:r1'), 2, 'a repeated deferral waits longer')
  t.advance(1)
  assert.equal(t.count('deliver:r1'), 3)
  t.world.turn = null
  t.floor.reportResult(t.report('r1'), 'started')
  t.floor.reportResult(t.report('r2'), 'started')

  const restarted = harness()
  restarted.floor.reportReady(restarted.report('r1'))
  for (let attempt = 0; attempt < 3; attempt++) {
    restarted.world.turn = null
    restarted.floor.reportResult(restarted.report('r1'), 'deferred')
    restarted.floor.wake()
  }
  restarted.world.turn = null
  restarted.floor.workerDown()
  restarted.floor.workerUp()
  restarted.floor.reportReady(restarted.report('r1'))
  const before = restarted.count('deliver:r1')
  restarted.world.turn = null
  restarted.floor.reportResult(restarted.report('r1'), 'deferred')
  restarted.advance(1000)
  assert.equal(restarted.count('deliver:r1'), before + 1, 'a fresh worker gets a one second backoff again')
})

test('row 21: already and missing reports are dropped, an aborted one waits for the next idle', () => {
  for (const outcome of ['already', 'missing', 'dropped']) {
    const t = harness()
    t.floor.reportReady(t.report('r1'))
    t.world.turn = null
    t.floor.reportResult(t.report('r1'), outcome)
    t.floor.pump()
    assert.equal(t.floor.pendingCount('s1'), 0, outcome)
    assert.equal(t.count('deliver:r1'), 1, outcome)
  }
  const aborted = harness()
  aborted.floor.reportReady(aborted.report('r1'))
  aborted.world.turn = null
  aborted.floor.reportResult(aborted.report('r1'), 'aborted')
  assert.equal(aborted.floor.pendingCount('s1'), 1)
  aborted.floor.pump()
  assert.equal(aborted.count('deliver:r1'), 2, 'delivered again at the next idle pump')
  const deferred = harness()
  deferred.floor.reportReady(deferred.report('r1'))
  deferred.world.turn = null
  deferred.floor.workerDown()
  deferred.floor.reportResult(deferred.report('r1'), 'deferred')
  assert.equal(deferred.floor.pendingCount('s1'), 1)
})

test('only one report is in flight at a time and duplicates of the same id are ignored', () => {
  const t = harness()
  t.floor.reportReady(t.report('r1'))
  t.floor.reportReady(t.report('r2'))
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.floor.pendingCount('s1'), 2)
  assert.equal(t.count('deliver:r1'), 1)
  assert.equal(t.count('deliver:r2'), 0, 'the second waits for the first')
  t.floor.reportResult(t.report('r1'), 'started')
  t.floor.playbackEnded()
  t.endTurn()
  t.advance(SETTLE_MS)
  assert.equal(t.count('deliver:r2'), 1, 'one at a time, through the settle buffer')
})

test('a needs_input report is spoken like any other, and the next round of the same task is its own report', () => {
  const t = harness()
  t.floor.reportReady({ ...t.report('t_01'), status: 'needs_input' })
  assert.deepEqual(t.delivered.map(item => [item.id, item.status]), [['t_01', 'needs_input']], 'the status reaches the host untouched')
  t.floor.reportResult(t.report('t_01'), 'started')
  t.floor.playbackEnded()
  t.endTurn()
  t.advance(SETTLE_MS)
  // 续接之后的汇报 id 是 `<task_id>.<round>`，与第一轮的 id 不同，不会被当成重复。
  t.floor.reportReady({ ...t.report('t_01.2'), status: 'done' })
  assert.deepEqual(t.delivered.map(item => [item.id, item.status]), [['t_01', 'needs_input'], ['t_01.2', 'done']])
})

test('row 22: a queued reload is flushed on every pump except while the owner is speaking', () => {
  const t = harness()
  t.floor.pump()
  assert.equal(t.count('flush'), 1)
  t.floor.asrStart()
  t.floor.recognized('说', false, false)
  const before = t.count('flush')
  t.floor.pump()
  assert.equal(t.count('flush'), before, 'a hearing floor does not cut the owner off for a reload')
  t.floor.preempt()
  t.floor.pump()
  assert.equal(t.count('flush'), before + 1)
})

test('priority: a blocked floor neither opens the mic nor speaks a report', () => {
  const t = harness({ gates: { blocked: true, sceneReady: true, proactive: true, sessionId: 's1' } })
  t.floor.asrStart()
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.count('start'), 0)
  assert.equal(t.count('deliver:r1'), 0)
  t.world.gates = { ...t.world.gates, blocked: false }
  t.floor.wake()
  assert.equal(t.count('deliver:r1'), 1, 'the report goes first')
  assert.equal(t.count('start'), 0, 'and the mic stays closed while it speaks')
})

test('row 23: losing the scene closes the mic; outside a reload it also drops the listening intent', () => {
  const t = harness()
  t.floor.asrStart()
  t.world.gates = { ...t.world.gates, sceneReady: false }
  t.floor.sceneLost(true)
  assert.equal(t.floor.listeningEnabled, true)
  assert.equal(t.floor.state(), 'idle')
  t.floor.sceneLost(false)
  assert.equal(t.floor.listeningEnabled, false)
})

test('row 10: closing the window ends listening, drafts and pending recovery timers', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.preempt()
  t.userTurn()
  t.floor.playbackEnded()
  t.endTurn()
  assert.equal(t.timers.size, 1, 'a recovery timer is pending')
  t.floor.setComposing(true)
  t.floor.windowClosed()
  assert.equal(t.timers.size, 0)
  assert.equal(t.floor.listeningEnabled, false)
  assert.equal(t.floor.composing, false)
})

test('worker restarts clear the report cache, which the worker rebuilds by replaying', () => {
  const t = harness()
  t.floor.workerDown()
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.floor.pendingCount('s1'), 1)
  t.floor.workerUp()
  assert.equal(t.floor.pendingCount('s1'), 0)
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.count('deliver:r1'), 1, 'the replay is delivered normally')
})

test('deleting a session drops its reports, including one already in flight', () => {
  const t = harness()
  t.floor.reportReady(t.report('r1'))
  t.floor.reportReady(t.report('r2', 's2'))
  t.floor.dropSession('s1')
  assert.equal(t.floor.pendingCount('s1'), 0)
  assert.equal(t.floor.pendingCount('s2'), 1)
  t.world.turn = null
  t.world.gates = { ...t.world.gates, sessionId: 's2' }
  t.floor.wake()
  assert.equal(t.count('deliver:r2'), 1, 'a dropped in-flight report does not block the next one')
})

test('dispose cancels every timer', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.reportReady(t.report('r1'))
  assert.ok(t.timers.size > 0)
  t.floor.dispose()
  assert.equal(t.timers.size, 0)
  t.floor.pump()
  assert.equal(t.count('deliver:r1'), 0)
})

test('recognition ending lets a report that waited on hearing speak; a plain idle never reopens the mic by itself', () => {
  const t = harness()
  t.floor.asrStart()
  t.floor.recognized('说到一半', false, false)
  t.floor.reportReady(t.report('r1'))
  assert.equal(t.count('deliver:r1'), 0)
  t.floor.status('error')
  assert.equal(t.count('deliver:r1'), 1, 'the recogniser failing frees the floor')

  const quiet = harness()
  quiet.floor.asrStart()
  const opened = quiet.count('start')
  quiet.floor.status('idle')
  assert.equal(quiet.count('start'), opened, 'a recogniser that keeps ending at once must not spin')
  assert.equal(quiet.floor.state(), 'idle')
})

test('a settle buffer schedules one resume timer only when something is waiting for it', () => {
  const idle = harness()
  idle.floor.playbackEnded()
  idle.floor.pump()
  assert.equal(idle.timers.size, 0, 'no listening intent and no report: nothing to wake up for')
  idle.floor.reportReady(idle.report('r1'))
  assert.equal(idle.timers.size, 1)
  idle.floor.pump()
  idle.floor.pump()
  assert.equal(idle.timers.size, 1, 'repeated pumps replace the timer instead of stacking them')
  idle.advance(SETTLE_MS)
  assert.equal(idle.count('deliver:r1'), 1)
})
