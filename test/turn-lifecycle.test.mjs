import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { PresentationText } from '../src/shared/presentation.ts'
import { sameTurn, isTurnKey } from '../src/shared/voice.ts'

function runtime() {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('class AppRuntime {'), source.indexOf('\nlet runtime: AppRuntime'))
  const js = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const calls = [], prompts = []
  const Runtime = vm.runInNewContext(js + '\nAppRuntime', {
    path, randomUUID, process: { env: {} }, MODULE_DIR: '/fixture', projectRoot: () => '/fixture',
    app: { getPath: () => '/fixture' }, jsonFile: () => ({}), safeStorage: { isEncryptionAvailable: () => false },
    PresentationText, sameTurn, isTurnKey,
    SessionStore: class { sessions = [{ id: 'one', title: 'One', messages: [] }, { id: 'two', title: 'Two', messages: [] }]; save() {} },
    SceneHost: class { async start() {}; close() {} },
    PiHost: class {
      async init() {}
      prompt(id, text, callbacks) { return new Promise((resolve, reject) => prompts.push({ id, text, callbacks, resolve, reject })) }
      async abort(id) { calls.push(['abort', id]) }
    },
    SpeechBridge: class { start() { calls.push(['listen']); return { ok: true } }; stop() { calls.push(['stop-listening']) } },
    FishTts: class { configured = true; start() {}; push() {}; finish() {}; abort() {} },
  })
  const app = new Runtime()
  app.emit = (method, params) => calls.push([method, params])
  return { app, calls, prompts }
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
