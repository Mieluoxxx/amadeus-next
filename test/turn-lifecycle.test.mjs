import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { AppRuntime } from '../src/main/appRuntime.ts'
import { SessionStore } from '../src/main/sessionStore.ts'
import { SpeechBridge } from '../src/main/speechBridge.ts'

function runtime(env = {}, clock = { value: Date.now() }, emote = {}) {
  const calls = [], prompts = [], timers = new Map()
  let timerId = 0
  // Fake clock so the conversation-idle timer can be stepped without waiting.
  const advance = ms => {
    const end = clock.value + ms
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, timer] = next
      timers.delete(id)
      clock.value = timer.at
      timer.fn()
    }
    clock.value = end
  }
  let emitFish
  const fakes = {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    timestampedSessionTitle: () => '新对话-2026-01-01-00-00',
    SessionStore: class { sessions = [{ id: 'one', title: 'One', messages: [] }, { id: 'two', title: 'Two', messages: [] }]; save() {} },
    SceneHost: class { url = 'http://127.0.0.1:1234/render/web/wallpaper_engine.html'; async start() {}; setEmoteAssets(...args) { calls.push(['emote-assets', ...args]) }; reload() { calls.push(['reload-scene']) }; close() {} },
    // 模型烘焙是原生工具调用：被测类只依赖它的返回值。
    ensureBakedModel: async () => ({ psb: '/fixture/model.psb', meta: '/fixture/model.meta.json' }),
    verifyEmoteRuntime: async () => {}, importEmoteAssets: async () => {},
    ...emote,
    PiHost: class {
      async init() {}
      prompt(id, text, callbacks) { return new Promise((resolve, reject) => prompts.push({ id, text, callbacks, resolve, reject })) }
      async abort(id) { calls.push(['abort', id]) }
      async request(command) { calls.push(['pi-control', command]); return {} }
      async restart() { calls.push(['restart-pi']) }
      dispose() {}
    },
    SpeechBridge: class { start(locale) { calls.push(['listen', locale]); return { ok: true } }; stop() { calls.push(['stop-listening']) }; finish(manual) { calls.push(['finish-listening', manual]); return { ok: true } }; dispose() { calls.push(['dispose-speech']) } },
    FishTts: class { configured = true; constructor(_config, emit) { emitFish = emit }; start() {}; push() {}; finish() {}; abort() {} },
  }
  const app = new AppRuntime({
    env, root: '/fixture', moduleDir: '/fixture', userData: '/fixture',
    clock: {
      now: () => clock.value,
      setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: clock.value + ms }); return id },
      clearTimeout: id => timers.delete(id),
    },
    store: new fakes.SessionStore(),
    settings: { read: () => ({}), write() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    dialog: fakes.dialog,
    exit: code => calls.push(['exit', code]),
    timestampedSessionTitle: fakes.timestampedSessionTitle,
    verifyEmoteRuntime: fakes.verifyEmoteRuntime, ensureBakedModel: fakes.ensureBakedModel, importEmoteAssets: fakes.importEmoteAssets,
    createScene: () => new fakes.SceneHost(),
    createPi: () => new fakes.PiHost(),
    createSpeech: () => new fakes.SpeechBridge(),
    createTts: (config, emit) => new fakes.FishTts(config, emit),
  })
  app.emit = (method, params) => calls.push([method, params])
  return { app, calls, prompts, timers, advance, emitFish: event => emitFish(event) }
}

test('a default-titled session is stamped only when its first message is sent', async () => {
  const { app, calls } = runtime({}, undefined, {
    SessionStore: class { sessions = [{ id: 'blank', title: '新对话', messages: [] }]; save() {} },
    timestampedSessionTitle: () => '新对话-2026-09-30-01-00',
  })
  await app.init()
  assert.equal((await app.request('chat.send', { text: '你好' })).ok, true)
  const titled = calls.find(([method]) => method === 'session.titled')
  assert.ok(titled, 'the first message must emit session.titled')
  assert.equal(titled[1].session_id, 'blank')
  assert.equal(titled[1].title, '新对话-2026-09-30-01-00')
  assert.equal((await app.request('session.list')).sessions[0].title, '新对话-2026-09-30-01-00')
  await app.request('chat.send', { text: '再说一次' })
  assert.equal(calls.filter(([method]) => method === 'session.titled').length, 1, 'an already stamped session must not be renamed again')
})

test('missing character resources do not block application initialization and can be retried', async () => {
  let missing = true, bakes = 0
  const { app, calls } = runtime({}, undefined, {
    ensureBakedModel: async () => { bakes++; if (missing) throw new Error('缺少模型包'); return { psb: '/cache/generation/model.psb' } },
  })
  await app.init()
  assert.equal(bakes, 0, 'window startup must not bake the character')
  assert.equal((await app.request('session.list')).sessions.length, 2)
  const failed = await app.request('wallpaper.start')
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /缺少模型包/)
  assert.equal(failed.retryable, false)
  missing = false
  assert.equal((await app.request('wallpaper.start')).status, 'ready')
  assert.equal(calls.some(([type]) => type === 'emote-assets'), true)
  assert.equal((await app.request('emote.import')).cancelled, true)
})

test('resource import owns a copy, blocks overlapping operations, and keeps the previous root on failure', async () => {
  let fail = true, releaseDialog, selected
  const { app, calls } = runtime({}, undefined, {
    dialog: { showOpenDialog: () => new Promise(resolve => { releaseDialog = () => resolve({ canceled: false, filePaths: ['/external/emote'] }) }) },
    importEmoteAssets: async (source, destination) => { selected = [source, destination]; if (fail) throw new Error('invalid resources'); return { psb: '/cache/model.psb' } },
  })
  await app.init()
  const first = app.request('emote.import')
  assert.equal((await app.request('emote.import')).ok, false)
  assert.equal((await app.request('chat.send', { text: 'wait' })).ok, false)
  releaseDialog()
  assert.match((await first).error, /invalid resources/)
  assert.equal(calls.some(([type]) => type === 'emote-assets'), false)
  fail = false
  const next = app.request('emote.import')
  releaseDialog()
  assert.equal((await next).ok, true)
  assert.deepEqual(selected, ['/external/emote', '/fixture/emote'])
  assert.equal(calls.find(([type]) => type === 'emote-assets')[1], '/fixture/emote')
})

test('ASR waits one second after playback drain; repeated or stale events cannot bypass the delay', async () => {
  const { app, calls, prompts, advance } = runtime()
  await app.init()
  await app.request('scene.ready')
  await app.request('asr.start')
  await app.request('chat.send', { text: 'hello', turn_id: 'first' })
  const first = calls.find(([method, value]) => method === 'voice.event' && value.type === 'begin')[1]
  prompts[0].callbacks.onText('Hello [EMO preset=smile]there')
  prompts[0].resolve('unused')
  await new Promise(resolve => setImmediate(resolve))
  advance(5000)
  assert.equal(calls.filter(([type]) => type === 'listen').length, 1)
  await app.request('voice.playback', { ...first, type: 'ended' })
  assert.equal(calls.filter(([type]) => type === 'listen').length, 1, 'audio completion must not reopen the microphone immediately')
  advance(500)
  await app.request('scene.ready')
  await app.request('asr.start')
  await app.request('voice.playback', { ...first, type: 'ended' })
  advance(499)
  assert.equal(calls.filter(([type]) => type === 'listen').length, 1)
  advance(1)
  assert.equal(calls.filter(([type]) => type === 'listen').length, 2)
  await app.request('chat.send', { text: 'again', turn_id: 'second' })
  const before = calls.filter(([type]) => type === 'listen').length
  await app.request('voice.playback', { ...first, type: 'ended' })
  advance(1000)
  assert.equal(calls.filter(([type]) => type === 'listen').length, before)
  assert.ok(calls.some(([type, value]) => type === 'chat.complete' && value.full_text === 'Hello there'))
  prompts[1].resolve('done')
  await new Promise(resolve => setImmediate(resolve))
})

test('ASR cooldown is measured from playback completion, even if Pi finishes later', async () => {
  for (const modelDelay of [500, 1500]) {
    const { app, calls, prompts, advance } = runtime()
    await app.init()
    await app.request('scene.ready')
    await app.request('asr.start')
    await app.request('chat.send', { text: 'hello' })
    await app.request('voice.playback', { ...app.activeTurn, type: 'ended' })
    advance(modelDelay)
    assert.equal(calls.filter(([type]) => type === 'listen').length, 1, 'Pi still owns the turn')
    prompts[0].resolve('done')
    await new Promise(resolve => setImmediate(resolve))
    if (modelDelay < 1000) {
      advance(1000 - modelDelay - 1)
      assert.equal(calls.filter(([type]) => type === 'listen').length, 1)
      advance(1)
    }
    assert.equal(calls.filter(([type]) => type === 'listen').length, 2, 'do not add a second delay after Pi completion')
    app.dispose()
  }
})

test('pending microphone recovery is cancelled when the turn or listening context changes', async () => {
  for (const action of ['new-turn', 'mic-off', 'session', 'new-session', 'scene-lost', 'closed', 'dispose', 'asr-error', 'no-speech']) {
    const { app, calls, prompts, timers, advance } = runtime()
    const window = new EventEmitter()
    window.webContents = new EventEmitter()
    app.attach(window)
    await app.init()
    await app.request('scene.ready')
    await app.request('asr.start')
    await app.request('chat.send', { text: 'hello' })
    prompts[0].resolve('done')
    await new Promise(resolve => setImmediate(resolve))
    await app.request('voice.playback', { ...app.activeTurn, type: 'ended' })
    const pending = app.listeningResumeTimer
    assert.ok(timers.has(pending), action)
    advance(500)
    if (action === 'new-turn') await app.request('chat.send', { text: 'again' })
    else if (action === 'mic-off') await app.request('asr.stop')
    else if (action === 'session') await app.request('session.load', { session_id: 'two' })
    else if (action === 'new-session') await app.request('session.create')
    else if (action === 'scene-lost') await app.request('scene.lost')
    else if (action === 'closed') window.emit('closed')
    else if (action === 'asr-error') app.onSpeech('asr.status', { status: 'error', error: 'fixture' })
    else if (action === 'no-speech') app.onSpeech('asr.status', { status: 'idle', reason: 'no-speech' })
    else app.dispose()
    assert.equal(timers.has(pending), false, action)
    advance(2000)
    assert.equal(calls.filter(([type]) => type === 'listen').length, 1, action)
    app.dispose()
  }
})

test('manual ASR finish stays in the draft while automatic finals start exactly one reply', async () => {
  for (const manual of [true, false]) {
    const { app, calls, prompts } = runtime()
    await app.init()
    await app.request('asr.start')
    app.onSpeech('asr.recognized', { text: '语音', is_final: false })
    assert.equal(prompts.length, 0, 'partial speech must not start a reply')
    if (manual) {
      await app.request('asr.stop')
      assert.ok(calls.some(([type, value]) => type === 'finish-listening' && value === true))
    }
    app.onSpeech('asr.recognized', { text: '语音测试', is_final: true, ...(manual ? { source: 'manual' } : {}) })
    const final = calls.findLast(([method, value]) => method === 'asr.recognized' && value.is_final)[1]
    assert.equal(final.source, manual ? 'manual' : 'wake')
    assert.equal(prompts.length, manual ? 0 : 1)
    if (!manual) {
      app.onSpeech('asr.recognized', { text: '重复回调', is_final: true })
      assert.equal(prompts.length, 1)
      prompts[0].resolve('done')
      await new Promise(resolve => setImmediate(resolve))
    }
    app.dispose()
  }
})

test('a quiet no-speech result disables listening without reporting a failure or restarting the microphone', async () => {
  const { app, calls } = runtime()
  await app.init()
  await app.request('asr.start')
  app.onSpeech('asr.status', { status: 'idle', reason: 'no-speech' })
  assert.equal(app.listeningEnabled, false)
  const listens = calls.filter(([type]) => type === 'listen').length
  await app.request('scene.ready')
  assert.equal(calls.filter(([type]) => type === 'listen').length, listens)
  assert.equal(calls.some(([type, value]) => type === 'asr.status' && value.status === 'error'), false)
  app.dispose()
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
    const { app, calls, prompts, advance } = runtime()
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
    advance(1000)
    assert.equal(calls.filter(([type]) => type === 'listen').at(-1)[1], 'zh-CN')
  }
})

test('resource reload waits for Pi and playback, coalesces requests, and preserves listening across a new scene handshake', async () => {
  const { app, calls, prompts, advance } = runtime()
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
  assert.equal(calls.filter(([type]) => type === 'listen').length, 1, 'reload must not skip the post-playback pause')
  advance(1000)
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
  const children = [], writes = [], events = []
  const bridge = new SpeechBridge((...event) => events.push(event), {
    platform: 'darwin', locateHelper: () => '/fixture/AmadeusSpeechRecognizer', pauseMs: 1500, clock: { setTimeout, clearTimeout },
    spawnHelper() {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stdin = { writable: true, write: text => writes.push(JSON.parse(text)) }
      child.kill = () => {}
      children.push(child)
      return child
    },
  })
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
  const root = mkdtempSync(path.join(os.tmpdir(), 'amadeus-history-'))
  try {
    const file = path.join(root, 'history.json')
    writeFileSync(file, JSON.stringify([{ id: 'one', title: 'Legacy', messages: [{ role: 'user', text: 'keep me' }] }, { id: 'two', title: 'Two', messages: [] }]))
    const store = new SessionStore(file)
    store.currentId = 'two'
    store.save()
    const restored = new SessionStore(file)
    assert.equal(restored.currentId, 'two')
    assert.equal(restored.sessions[0].messages[0].text, 'keep me')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('development main reload exits for the launcher only after model and playback finish', async () => {
  const { app, calls, prompts } = runtime({ AMADEUS_NEXT_DEV: '1' })
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

test('disposing the runtime cancels its conversation-idle timer', async () => {
  const { app, calls, timers, advance } = runtime()
  await app.init()
  assert.equal(timers.size, 1)
  app.dispose()
  app.dispose()
  const before = calls.length
  advance(180_000)
  assert.equal(calls.length, before, 'a disposed runtime must not emit idle events')
  assert.equal(timers.size, 0, 'dispose must cancel the timer, not just suppress its callback')
})

test('idle stills need 3 quiet minutes and never appear while a reply is running', async () => {
  const { app, calls, timers, advance, prompts } = runtime()
  await app.init()
  const idleEvents = () => calls.filter(([method, value]) => method === 'voice.event' && value.type === 'conversation-idle')
  assert.equal(timers.size, 1, 'startup schedules one idle deadline')
  const settle = () => new Promise(resolve => setImmediate(resolve))

  advance(179_999)
  assert.equal(idleEvents().length, 0)

  await app.request('chat.send', { text: 'hello', turn_id: 'one' })
  assert.equal(timers.size, 0, 'a running reply cancels the idle deadline')
  advance(600_000)
  assert.equal(idleEvents().length, 0, 'a running reply keeps the E-mote foreground past the deadline')

  prompts[0].resolve('done')
  await settle()
  assert.equal(timers.size, 1)
  assert.equal(idleEvents().length, 0, 'finishing the reply restarts the clock')

  advance(179_999)
  assert.equal(idleEvents().length, 0, 'idle must wait three full minutes after the reply ends')
  advance(1)
  assert.deepEqual(idleEvents().map(([, value]) => value.active), [true])
  assert.equal(timers.size, 0, 'entering idle leaves no timer running')
  advance(600_000)
  assert.equal(idleEvents().length, 1, 'idle does not keep waking or broadcasting')

  await app.request('chat.send', { text: 'again', turn_id: 'two' })
  assert.deepEqual(idleEvents().map(([, value]) => value.active), [true, false], 'a new message ends the idle show at once')
  assert.equal(timers.size, 0)

  prompts[1].resolve('done')
  await settle()
  advance(180_000)
  assert.deepEqual(idleEvents().at(-1)[1].active, true)

  // A new scene starts blank and never sees the edge again, so the handshake resends the current state.
  const before = idleEvents().length
  await app.request('scene.ready', { token: 'next' })
  assert.equal(idleEvents().length, before + 1)
  assert.equal(idleEvents().at(-1)[1].active, true)
  assert.equal(timers.size, 0, 'a scene handshake does not restart the idle deadline')
})

test('idle countdown starts after both Pi and playback finish, in either order', async () => {
  for (const playbackFirst of [false, true]) {
    const { app, timers, advance, prompts } = runtime()
    await app.init()
    await app.request('scene.ready')
    await app.request('chat.send', { text: 'hello' })
    const turn = { ...app.activeTurn }
    const finishPi = async () => { prompts[0].resolve('done'); await new Promise(resolve => setImmediate(resolve)) }
    const finishPlayback = () => app.request('voice.playback', { ...turn, type: 'ended' })
    await (playbackFirst ? finishPlayback() : finishPi())
    assert.equal(timers.size, 0, 'finishing only one half must not schedule idle')
    advance(600_000)
    assert.equal(app.idleActive, false)
    await (playbackFirst ? finishPi() : finishPlayback())
    assert.equal(timers.size, 1)
    advance(179_999)
    assert.equal(app.idleActive, false)
    advance(1)
    assert.equal(app.idleActive, true)
    assert.equal(timers.size, 0)
  }
})

test('idle deadlines recover from interruptions and failures but never rearm after disposal', async () => {
  for (const ending of ['abort', 'session', 'pi-error', 'playback-error', 'fish-error', 'scene-lost', 'dispose']) {
    const { app, timers, advance, prompts, emitFish } = runtime()
    await app.init()
    await app.request('scene.ready')
    await app.request('chat.send', { text: 'hello' })
    const turn = { ...app.activeTurn }
    const settle = () => new Promise(resolve => setImmediate(resolve))
    if (['playback-error', 'fish-error', 'scene-lost'].includes(ending)) {
      prompts[0].resolve('done')
      await settle()
    }
    advance(600_000)
    assert.equal(timers.size, 0, ending)
    if (ending === 'abort') await app.request('chat.abort')
    else if (ending === 'session') await app.request('session.load', { session_id: 'two' })
    else if (ending === 'pi-error') prompts[0].reject(new Error('Pi failed'))
    else if (ending === 'playback-error') await app.request('voice.playback', { ...turn, type: 'error' })
    else if (ending === 'fish-error') emitFish({ ...turn, type: 'error', error: 'Fish failed' })
    else if (ending === 'scene-lost') await app.request('scene.lost')
    else app.dispose()
    await settle()
    advance(1000)
    const deadlines = [...timers.keys()]
    prompts[0].resolve('late completion')
    await settle()
    assert.deepEqual([...timers.keys()], deadlines, `${ending}: late completion must not restart idle`)
    assert.equal(timers.size, ending === 'dispose' ? 0 : 1, ending)
    advance(178_999)
    assert.equal(app.idleActive, false, ending)
    advance(1)
    assert.equal(app.idleActive, ending !== 'dispose', ending)
    assert.equal(timers.size, 0, ending)
  }
})
