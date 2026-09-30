import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { SpeechBridge } from '../src/main/speechBridge.ts'

function bridge() {
  const child = new EventEmitter(), writes = [], events = [], timers = new Map()
  let nextId = 0
  child.stdout = new EventEmitter()
  child.stdin = { writable: true, write: text => writes.push(JSON.parse(text)) }
  child.kill = () => {}
  const instance = new SpeechBridge((method, value) => events.push({ method, ...value }), {
    platform: 'darwin', locateHelper: () => '/fixture/AmadeusSpeechRecognizer', spawnHelper: () => child, pauseMs: 1500,
    clock: {
      setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, ms }); return id },
      clearTimeout: id => timers.delete(id),
    },
  })
  instance.start('zh-CN')
  const receive = value => child.stdout.emit('data', Buffer.from(JSON.stringify({ recognition_id: writes.findLast(item => item.command === 'start').recognition_id, ...value }) + '\n'))
  const fire = () => {
    assert.equal(timers.size, 1)
    const [id, timer] = [...timers][0]
    timers.delete(id)
    timer.fn()
  }
  return { instance, writes, events, timers, receive, fire }
}

test('stable partial speech ends audio once, then waits for the real final transcript', () => {
  const { writes, events, timers, receive, fire } = bridge()
  receive({ type: 'recognized', text: '语音', is_final: false })
  assert.equal(timers.size, 1, 'partial recognition must schedule an utterance boundary')
  assert.equal([...timers.values()][0].ms, 1500)
  const first = [...timers.keys()][0]
  receive({ type: 'recognized', text: '语音测试', is_final: false })
  assert.equal(timers.has(first), false, 'new words postpone the boundary')
  const updated = [...timers.keys()][0]
  receive({ type: 'recognized', text: '语音测试', is_final: false })
  assert.equal([...timers.keys()][0], updated, 'duplicate partials must not postpone forever')
  fire()
  assert.equal(writes.at(-1).command, 'finish')
  assert.equal(events.some(event => event.is_final), false, 'a partial must never be submitted as final')
  receive({ type: 'recognized', text: '语音测试。', is_final: true })
  assert.equal(events.filter(event => event.is_final).length, 1)
  assert.equal(events.at(-1).text, '语音测试。')
  assert.equal(timers.size, 0)
})

test('manual finish preserves the final for the draft, but cancellation rejects stale speech', () => {
  const { instance, writes, events, receive, timers } = bridge()
  instance.finish(true)
  assert.equal(writes.at(-1).command, 'finish')
  receive({ type: 'recognized', text: '保留文字', is_final: true })
  assert.equal(events.at(-1).source, 'manual')
  assert.equal(timers.size, 0)
  instance.start('zh-CN')
  receive({ type: 'recognized', text: '旧回合', is_final: false })
  instance.stop()
  const count = events.length
  receive({ type: 'recognized', text: '旧回合', is_final: true })
  assert.equal(events.length, count)
  assert.equal(timers.size, 0)
})

test('a listening refresh during finalization cannot cancel the pending transcript', () => {
  const { instance, writes, receive, events, fire } = bridge()
  receive({ type: 'recognized', text: '继续等待', is_final: false })
  fire()
  const count = writes.length
  instance.start('zh-CN')
  assert.equal(writes.length, count)
  receive({ type: 'recognized', text: '继续等待。', is_final: true })
  assert.equal(events.at(-1).text, '继续等待。')
  assert.equal(events.at(-1).is_final, true)
})

test('empty final results end quietly without an error or a submitted message', () => {
  const { receive, events, timers } = bridge()
  receive({ type: 'recognized', text: '   ', is_final: true })
  assert.equal(events.at(-1).status, 'idle')
  assert.equal(events.at(-1).reason, 'no-speech')
  assert.equal(events.some(event => event.error || event.method === 'asr.recognized'), false)
  assert.equal(timers.size, 0)
})

test('no-speech errors are quiet across locales while real recognition failures remain visible', () => {
  for (const [failure, quiet] of [
    [{ domain: 'kAFAssistantErrorDomain', code: 1110, error: 'No speech detected' }, true],
    [{ domain: 'kAFAssistantErrorDomain', code: 1110, error: '未检测到语音' }, true],
    [{ error: 'No speech detected' }, true],
    [{ domain: 'kAFAssistantErrorDomain', code: 1700, error: 'Not authorized' }, false],
    [{ domain: 'OtherDomain', code: 1110, error: 'Device failed' }, false],
  ]) {
    const { receive, events, timers } = bridge()
    receive({ type: 'status', status: 'listening' })
    receive({ type: 'error', ...failure })
    assert.equal(events.at(-1).status, quiet ? 'idle' : 'error')
    assert.equal(events.at(-1).error, quiet ? undefined : failure.error)
    if (quiet) assert.equal(events.at(-1).reason, 'no-speech')
    assert.equal(timers.size, 0)
  }
})

test('finalization timeout and disposal cancel pending speech timers', () => {
  const { instance, events, receive, timers, fire } = bridge()
  receive({ type: 'recognized', text: '测试', is_final: false })
  fire()
  fire()
  assert.equal(events.at(-1).status, 'error')
  assert.match(events.at(-1).error, /final|timed out/i)
  assert.equal(timers.size, 0)
  instance.start('zh-CN')
  receive({ type: 'recognized', text: '测试', is_final: false })
  instance.dispose()
  assert.equal(timers.size, 0)
})

test('a microphone without transcription times out visibly instead of listening forever', () => {
  const { events, writes, receive, timers, fire } = bridge()
  receive({ type: 'status', status: 'listening' })
  assert.equal(timers.size, 1)
  assert.equal([...timers.values()][0].ms, 30000)
  fire()
  assert.equal(writes.at(-1).command, 'stop')
  assert.equal(events.at(-1).status, 'error')
  assert.match(events.at(-1).error, /transcription/i)
  assert.equal(timers.size, 0)
})
