import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { EventEmitter } from 'node:events'
import { encode, decode } from '@msgpack/msgpack'
import { FishTts } from '../src/main/fishTts.ts'

test('the Pixi frame driver reports cycles even when a render tick skips over frame zero', () => {
  const source = readFileSync(new URL('../resources/render/web/renderer.js', import.meta.url), 'utf8')
  const start = source.indexOf('    _startIdleTicker() {')
  const end = source.indexOf('\n    _notifyCycleComplete(', start)
  let tick, cycles = 0
  const Driver = vm.runInNewContext('(class {' + source.slice(start, end) + '})', {
    app: { ticker: { deltaMS: 68, add: callback => { tick = callback } } }, console: { log() {} },
  })
  const driver = new Driver()
  Object.assign(driver, { _idleAnimationEnabled: true, _held: false, _transitionQueue: [], _currentEmotion: 'loop', _frameIdx: 119,
    _frameIntervals: { loop: 17 }, _clipConfigs: {}, _mouthConfigs: {}, _getEmotionFrames: () => Array(120).fill(true),
    _showFrame() {}, _notifyCycleComplete: () => { cycles++ },
  })
  driver._startIdleTicker(); tick()
  assert.equal(driver._frameIdx, 3)
  assert.equal(cycles, 1)
})

test('the actual audio processor drains only consumed samples and rejects old generations', () => {
  const messages = []
  let Processor
  const source = readFileSync(new URL('../src/scene/audioWorklet.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const sandbox = { exports: {}, ArrayBuffer, Float32Array, sampleRate: 24000, currentTime: 0,
    AudioWorkletProcessor: class { port = { postMessage: value => messages.push(value) } },
    registerProcessor: (_name, type) => { Processor = type },
  }
  vm.runInNewContext(js, sandbox)
  const processor = new Processor()
  const send = value => processor.port.onmessage({ data: value })
  const output = new Float32Array(128)
  const render = () => { processor.process([], [[output]]); sandbox.currentTime += 128 / 24000 }
  send({ type: 'reset', generation: 1 })
  send({ type: 'pcm', generation: 1, buffer: new Float32Array(200).fill(0.5).buffer })
  render()
  assert.equal(messages.at(-1).type, 'playing')
  assert.equal(messages.at(-1).rms, 0.5)
  render()
  render()
  assert.equal(messages.at(-1).type, 'buffering')
  assert.equal(messages.at(-1).rms, 0)
  assert.equal(messages.at(-1).seconds, 200 / 24000)
  send({ type: 'pcm', generation: 1, buffer: new Float32Array(256).fill(0.25).buffer })
  send({ type: 'end', generation: 1 })
  render()
  assert.equal(messages.at(-1).type, 'playing', 'network finish does not finish queued audio')
  render()
  assert.equal(messages.at(-1).type, 'ended')
  assert.equal(messages.at(-1).seconds, 456 / 24000)
  send({ type: 'reset', generation: 2 })
  send({ type: 'pcm', generation: 1, buffer: new Float32Array(128).fill(1).buffer })
  render()
  assert.ok(output.every(sample => sample === 0))
})

class Socket extends EventEmitter {
  readyState = 0
  sent = []
  send(bytes) { this.sent.push(decode(bytes)) }
  open() { this.readyState = 1; this.emit('open') }
  close() { this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
}

test('Fish flushes text and stop after a late open, forwards empty alignment corrections, and ignores an old socket', () => {
  const sockets = [], events = []
  const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture' }), event => events.push(event), () => {
    const socket = new Socket(); sockets.push(socket); return socket
  })
  const key = { sessionId: 'session', turnId: 'turn', generation: 1 }
  try {
    fish.start(key)
    fish.push('Hello')
    fish.finish()
    sockets[0].open()
    assert.deepEqual(sockets[0].sent.map(value => value.event), ['start', 'text', 'stop'])
    sockets[0].emit('message', encode({ event: 'audio', audio: new Uint8Array(0), content: 'Hello', chunk_seq: 0, chunk_audio_offset_sec: 0, alignment: { segments: [{ text: 'Hello', start: 0, end: 1 }] } }))
    assert.equal(events.at(-1).alignment.content, 'Hello')
    sockets[0].emit('message', encode({ event: 'finish', reason: 'stop' }))
    assert.equal(events.at(-1).type, 'input-ended')
    fish.start({ ...key, generation: 2 })
    const count = events.length
    sockets[0].emit('message', encode({ event: 'finish', reason: 'error' }))
    assert.equal(events.length, count)
    sockets[1].open()
    sockets[1].close()
    assert.equal(events.at(-1).type, 'error')
    assert.equal(events.at(-1).generation, 2)
  } finally { fish.abort() }
})
