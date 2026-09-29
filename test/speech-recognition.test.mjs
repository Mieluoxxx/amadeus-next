import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { asrDraftOutcome } from '../src/renderer/components/scene/sceneStreamState.ts'

const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const speech = main.slice(main.indexOf('class SpeechBridge {'), main.indexOf('class AppRuntime {'))
const js = ts.transpileModule(speech, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function bridge() {
  const child = new EventEmitter(), writes = [], events = [], timers = new Map()
  let nextId = 0
  child.stdout = new EventEmitter()
  child.stdin = { writable: true, write: text => writes.push(JSON.parse(text)) }
  child.kill = () => {}
  const Bridge = vm.runInNewContext(js + '\nSpeechBridge', {
    path, MODULE_DIR: '/fixture', existsSync: () => true, process: { platform: 'darwin', env: {} }, spawn: () => child,
    setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => timers.delete(id),
  })
  const instance = new Bridge((method, value) => events.push({ method, ...value }))
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

test('ASR errors are visible and manual finals preserve the typed draft', () => {
  const source = readFileSync(new URL('../src/renderer/components/scene/useSceneSession.ts', import.meta.url), 'utf8')
  const start = source.indexOf("    unsubscribers.push(subscribe('asr.recognized'")
  const end = source.indexOf('    return () => {', start)
  assert.ok(start >= 0 && end > start)
  const handlers = new Map(), state = { listening: true, error: '', draft: '原有草稿', messages: [] }
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    unsubscribers: [], subscribe(name, fn) { handlers.set(name, fn); return () => {} },
    asrDraftOutcome, draftRef: { current: state.draft }, activeSessionRef: { current: 'fixture' }, crypto: { randomUUID: () => 'fixture' },
    setAsrListening: value => { state.listening = value }, setOperationError: value => { state.error = value },
    setMessages: update => { state.messages = update(state.messages) }, updateDraft: value => { state.draft = value },
  })
  handlers.get('asr.status')({ status: 'error', error: 'Speech recognition unavailable' })
  assert.equal(state.listening, false)
  assert.match(state.error, /Speech recognition unavailable/)
  handlers.get('asr.status')({ status: 'listening' })
  assert.equal(state.listening, true, 'automatic microphone restart must reach the UI')
  handlers.get('asr.recognized')({ text: '语音测试', source: 'manual', is_final: true })
  assert.equal(state.draft, '原有草稿 语音测试')
  assert.equal(state.messages.length, 0, 'manual finish must not auto-submit')
})

test('microphone start rejection does not leave the UI listening silently', async () => {
  const source = readFileSync(new URL('../src/renderer/components/scene/useSceneSession.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const toggleMic = useCallback(')
  const end = source.indexOf('  const selectModel =', start)
  assert.ok(start >= 0 && end > start)
  let listening = false, error = ''
  const toggle = vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\ntoggleMic', {
    connected: true, asrListening: false, useCallback: fn => fn,
    send: async () => ({ ok: false, error: 'Speech helper unavailable' }),
    setAsrListening: value => { listening = value }, setOperationError: value => { error = value },
  })
  await toggle()
  assert.equal(listening, false)
  assert.match(error, /Speech helper unavailable/)
})

test('native finish keeps the recognition generation alive without recording audio', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('../native/SpeechRecognizer.swift', import.meta.url), 'utf8')
  const service = source.slice(0, source.indexOf('\nlet service = SpeechService()'))
  const probe = `${service}
extension SpeechService {
    func verifyFinish() {
        running = true
        let previousGeneration = generation
        finish()
        precondition(running && generation == previousGeneration, "finish must still accept the final result")
        stop()
        precondition(!running && generation != previousGeneration, "cancel must invalidate late results")
    }
}
SpeechService().verifyFinish()
`
  execFileSync('swift', ['-e', probe], { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
})
