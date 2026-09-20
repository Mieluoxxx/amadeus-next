import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import vm from 'node:vm'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { PresentationText } from '../src/shared/presentation.ts'
import { sameTurn, isTurnKey } from '../src/shared/voice.ts'

function runtime(env = {}) {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('class AppRuntime {'), source.indexOf('\nlet runtime: AppRuntime'))
  const js = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const calls = [], prompts = []
  let emitFish
  const Runtime = vm.runInNewContext(js + '\nAppRuntime', {
    path, randomUUID, setTimeout, clearTimeout, process: { env }, MODULE_DIR: '/fixture', projectRoot: () => '/fixture',
    app: { getPath: () => '/fixture', exit: code => calls.push(['exit', code]) }, jsonFile: () => ({}), safeStorage: { isEncryptionAvailable: () => false },
    mkdirSync() {}, writeFileSync() {},
    PresentationText, sameTurn, isTurnKey, URL,
    SessionStore: class { sessions = [{ id: 'one', title: 'One', messages: [] }, { id: 'two', title: 'Two', messages: [] }]; save() {} },
    SceneHost: class { async start() {}; reload() { calls.push(['reload-scene']) }; close() {} },
    PiHost: class {
      async init() {}
      prompt(id, text, callbacks) { return new Promise((resolve, reject) => prompts.push({ id, text, callbacks, resolve, reject })) }
      async abort(id) { calls.push(['abort', id]) }
      async request(command) { calls.push(['pi-control', command]); return {} }
      async restart() { calls.push(['restart-pi']) }
      dispose() {}
    },
    SpeechBridge: class { start(locale) { calls.push(['listen', locale]); return { ok: true } }; stop() { calls.push(['stop-listening']) }; dispose() { calls.push(['dispose-speech']) } },
    FishTts: class { configured = true; constructor(_config, emit) { emitFish = emit }; start() {}; push() {}; finish() {}; abort() {} },
  })
  const app = new Runtime()
  app.emit = (method, params) => calls.push([method, params])
  return { app, calls, prompts, emitFish: event => emitFish(event) }
}

test('ASR resumes only after both Pi completion and playback drain; stale acknowledgements cannot release a new turn', async () => {
  const { app, calls, prompts } = runtime()
  await app.init()
  await app.request('scene.ready')
  await app.request('asr.start')
  await app.request('chat.send', { text: 'hello', turn_id: 'first' })
  const first = calls.find(([method, value]) => method === 'voice.event' && value.type === 'begin')[1]
  prompts[0].callbacks.onText('Hello [EMO preset=smile]there')
  prompts[0].resolve('unused')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(([type]) => type === 'listen').length, 1)
  await app.request('voice.playback', { ...first, type: 'ended' })
  assert.equal(calls.filter(([type]) => type === 'listen').length, 2)
  await app.request('chat.send', { text: 'again', turn_id: 'second' })
  const before = calls.filter(([type]) => type === 'listen').length
  await app.request('voice.playback', { ...first, type: 'ended' })
  assert.equal(calls.filter(([type]) => type === 'listen').length, before)
  assert.ok(calls.some(([type, value]) => type === 'chat.complete' && value.full_text === 'Hello there'))
  prompts[1].resolve('done')
  await new Promise(resolve => setImmediate(resolve))
})

test('session switching cancels audio and suppresses all late text/tool/completion events', async () => {
  const { app, calls, prompts } = runtime()
  await app.init()
  await app.request('scene.ready')
  await app.request('chat.send', { text: 'hello', turn_id: 'old' })
  await app.request('session.load', { session_id: 'two' })
  const count = calls.length
  prompts[0].callbacks.onText('late')
  prompts[0].callbacks.onTool('read', true)
  prompts[0].resolve('late')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, count)
  assert.ok(calls.some(([type, value]) => type === 'abort' && value === 'one'))
  assert.equal(app.activeTurn, null)
})

test('both settings endpoints apply recognition language live without interrupting an active turn', async () => {
  for (const method of ['system.set_config', 'desktop.settings.update']) {
    const { app, calls, prompts } = runtime()
    await app.init()
    await app.request('scene.ready')
    await app.request('asr.start')
    await app.request(method, { values: { asr_language: 'en-US' } })
    assert.equal(calls.filter(([type]) => type === 'listen').at(-1)[1], 'en-US')
    const snapshot = await app.request('system.get_config')
    assert.equal(snapshot.values.voice_configuration.find(group => group.id === 'asr_local').fields[0].value, 'en-US')
    const listens = calls.filter(([type]) => type === 'listen').length
    await app.request(method, { values: { asr_language: 'en-US' } })
    assert.equal(calls.filter(([type]) => type === 'listen').length, listens, 'Unchanged language must not restart recognition')
    await app.request('chat.send', { text: 'hello', turn_id: 'first' })
    await app.request(method, { values: { asr_language: 'zh-CN' } })
    assert.equal(calls.filter(([type]) => type === 'listen').length, listens, 'Language changes must not resume the microphone during a reply')
    assert.equal(calls.some(([type]) => type === 'abort'), false, 'Saving must not abort Pi')
    prompts[0].resolve('done')
    await new Promise(resolve => setImmediate(resolve))
    await app.request('voice.playback', { ...app.activeTurn, type: 'ended' })
    assert.equal(calls.filter(([type]) => type === 'listen').at(-1)[1], 'zh-CN')
  }
})

test('resource reload waits for Pi and playback, coalesces requests, and preserves listening across a new scene handshake', async () => {
  const { app, calls, prompts } = runtime()
  app.attach({ on() {}, isDestroyed: () => false, webContents: { on() {} } })
  await app.init()
  await app.request('scene.ready', { token: 'old' })
  await app.request('asr.start')
  await app.request('chat.send', { text: 'hello', turn_id: 'first' })
  const turn = calls.find(([type, value]) => type === 'voice.event' && value.type === 'begin')[1]
  assert.equal((await app.request('runtime.reload', { targets: ['pi', 'scene'] })).ok, true)
  await app.request('runtime.reload', { targets: ['scene'] })
  assert.equal((await app.request('chat.send', { text: 'must not run' })).ok, false)
  assert.equal(calls.some(([type]) => type === 'pi-control'), false)
  prompts[0].resolve('done')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(([type]) => type === 'reload-scene'), false, 'Pi completion alone must not interrupt playback')
  await app.request('voice.playback', { ...turn, type: 'ended' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(([type]) => type === 'reload-scene').length, 1)
  assert.equal(calls.some(([type]) => type === 'abort'), false)
  assert.equal((await app.request('scene.ready', { token: 'old' })).ok, false, 'A stale handshake cannot finish reload')
  await app.request('scene.lost', { token: 'old' })
  await app.request('scene.ready', { token: 'new' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await app.request('runtime.status')).status, 'ready')
  assert.equal(calls.filter(([type]) => type === 'listen').length, 2)
  assert.equal(prompts.length, 1, 'Reload must never replay a prompt')
})

test('reload rejects unknown/development targets and calibration updates do not reset a turn', async () => {
  const { app, calls, prompts } = runtime()
  await app.init()
  assert.equal((await app.request('runtime.reload', { targets: ['main'] })).ok, false)
  assert.equal((await app.request('dev.reload', { targets: ['main'] })).ok, false)
  assert.equal((await app.request('runtime.reload', { targets: ['unknown'] })).ok, false)
  await app.request('chat.send', { text: 'hello' })
  const start = calls.length
  await app.request('system.set_config', { values: { mouth_gain: 12, voice_sync_offset_ms: 150 } })
  const events = calls.slice(start).filter(([type]) => type === 'voice.event').map(([, value]) => value)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'calibration')
  assert.equal(events[0].calibration.mouthGain, 12)
  assert.equal(events[0].calibration.syncOffsetMs, 150)
  assert.equal((await app.request('desktop.settings.update', { values: { mouth_gain: 'bad' } })).ok, false)
  assert.equal((await app.request('system.get_config')).values.mouth_gain, 12)
  assert.equal(calls.some(([type]) => type === 'abort'), false)
  prompts[0].resolve('done')
  await new Promise(resolve => setImmediate(resolve))
})

test('unexpected scene loss stops speech but does not cancel or replay the running Pi turn', async () => {
  const { app, calls, prompts } = runtime()
  await app.init()
  await app.request('scene.ready', { token: 'first' })
  await app.request('chat.send', { text: 'keep working', turn_id: 'ongoing' })
  prompts[0].callbacks.onText('before ')
  await app.request('scene.lost', { token: 'first' })
  prompts[0].callbacks.onText('after')
  const ready = await app.request('scene.ready', { token: 'second' })
  assert.equal(ready.key.turnId, 'ongoing')
  assert.equal(ready.text, 'before after')
  assert.equal(calls.some(([type]) => type === 'abort'), false)
  prompts[0].resolve('before after')
  await new Promise(resolve => setImmediate(resolve))
  const payload = await app.request('session.list')
  assert.equal(payload.messages.at(-1).text, 'before after')
})

test('speech helper replacement resets listening and ignores the retired helper exit', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('class SpeechBridge {'), source.indexOf('class AppRuntime {'))
  const children = [], writes = [], events = []
  const Bridge = vm.runInNewContext(ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nSpeechBridge', {
    path, MODULE_DIR: '/fixture', existsSync: () => true, process: { platform: 'darwin', env: {} },
    spawn() {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stdin = { writable: true, write: text => writes.push(JSON.parse(text)) }
      child.kill = () => {}
      children.push(child)
      return child
    },
  })
  const bridge = new Bridge((...event) => events.push(event))
  assert.equal(bridge.start('zh-CN').ok, true)
  bridge.dispose()
  assert.equal(bridge.start('en-US').ok, true)
  assert.equal(children.length, 2)
  assert.equal(writes.at(-1).locale, 'en-US')
  children[0].emit('exit', 0)
  children[0].stdout.emit('data', Buffer.from('{"type":"error","recognition_id":3,"error":"old"}\n'))
  bridge.start('en-US')
  assert.equal(children.length, 2, 'A late exit must not clear the new helper')
  assert.equal(events.length, 0)
  bridge.dispose()
})

test('the selected desktop session survives restart and legacy history remains readable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'salieri-history-'))
  try {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const block = source.slice(source.indexOf('class SessionStore {'), source.indexOf('class SpeechBridge {'))
    const Store = vm.runInNewContext(ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nSessionStore', { path, readFileSync, writeFileSync, mkdirSync })
    const file = path.join(root, 'history.json')
    writeFileSync(file, JSON.stringify([{ id: 'one', title: 'Legacy', messages: [{ role: 'user', text: 'keep me' }] }, { id: 'two', title: 'Two', messages: [] }]))
    const store = new Store(file)
    store.currentId = 'two'
    store.save()
    const restored = new Store(file)
    assert.equal(restored.currentId, 'two')
    assert.equal(restored.sessions[0].messages[0].text, 'keep me')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('development main reload exits for the launcher only after model and playback finish', async () => {
  const { app, calls, prompts } = runtime({ SALIERI_NEXT_DEV: '1' })
  await app.init()
  await app.request('scene.ready')
  await app.request('chat.send', { text: 'finish first', turn_id: 'active' })
  const turn = calls.find(([type, value]) => type === 'voice.event' && value.type === 'begin')[1]
  assert.equal((await app.request('dev.reload', { targets: ['main'] })).status, 'queued')
  prompts[0].resolve('done')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(([type]) => type === 'exit'), false)
  await app.request('voice.playback', { ...turn, type: 'ended' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.filter(([type]) => type === 'exit'), [['exit', 75]])
  assert.equal(calls.some(([type]) => type === 'abort'), false)
})

test('Fish failure diagnostics reach both error channels while text chat continues', async () => {
  const { app, calls, prompts, emitFish } = runtime()
  await app.init()
  await app.request('scene.ready')
  await app.request('chat.send', { text: 'hello', turn_id: 'billing' })
  const turn = calls.find(([type, value]) => type === 'voice.event' && value.type === 'begin')[1]
  const diagnostic = { provider: 'fish', phase: 'handshake', code: 'payment_required', httpStatus: 402 }
  emitFish({ ...turn, type: 'error', error: 'Fish API payment required (HTTP 402)', diagnostic })
  assert.deepEqual(calls.find(([type]) => type === 'tts.error')[1].diagnostic, diagnostic)
  assert.deepEqual(calls.find(([type, value]) => type === 'voice.event' && value.type === 'error')[1].diagnostic, diagnostic)
  prompts[0].callbacks.onText('Text remains available')
  prompts[0].resolve('Text remains available')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(([type]) => type === 'chat.error'), false)
  assert.equal((await app.request('session.list')).messages.at(-1).text, 'Text remains available')
})

test('the network proxy setting is validated, persisted, and replaces only the Pi worker', async () => {
  const { app, calls } = runtime()
  await app.init()
  const stored = () => calls.filter(([type]) => type === 'desktop.settings.update')
  assert.equal((await app.request('system.set_config', { values: { network_proxy: 'socks5://127.0.0.1:1080' } })).ok, false)
  assert.equal((await app.request('system.set_config', { values: { network_proxy: '127.0.0.1:7890' } })).ok, false)
  assert.equal(stored().length, 0, 'a rejected address must not be stored')
  const applied = await app.request('system.set_config', { values: { network_proxy: ' http://127.0.0.1:7890 ' } })
  assert.equal(applied.ok, true)
  assert.equal(applied.values.network_proxy, 'http://127.0.0.1:7890')
  assert.equal(calls.some(([type]) => type === 'chat.interrupted'), false)
  // The worker starts with the address in its environment; Pi's transport reads
  // it at process start and needs the opt-in flag to use it at all.
  const env = app.piEnv()
  assert.equal(env.NODE_USE_ENV_PROXY, '1')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  // The worker reads the address from its environment, so it is replaced at the
  // next safe boundary instead of being reconfigured in place.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(([type]) => type === 'restart-pi'), true)
  // Clearing the address is a valid change too and reaches the same path.
  assert.equal((await app.request('system.set_config', { values: { network_proxy: '' } })).ok, true)
  assert.equal(app.piEnv().HTTP_PROXY, undefined)
})
