import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { encode, decode } from '@msgpack/msgpack'
import { FishTts } from '../src/main/fishTts.ts'

function audioWorkletHarness() {
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
  const output = new Float32Array(128)
  const render = () => { processor.process([], [[output]]); sandbox.currentTime += 128 / 24000 }
  const renderUntil = (type, limit = 400) => {
    for (let i = 0; i < limit; i++) { render(); if (messages.at(-1)?.type === type) return }
    assert.fail(`playback never reported ${type}`)
  }
  return { messages, output, render, renderUntil, send: value => processor.port.onmessage({ data: value }) }
}

test('the actual audio processor drains only consumed samples and rejects old generations', () => {
  const { messages, output, render, renderUntil, send } = audioWorkletHarness()
  send({ type: 'reset', generation: 1 })
  send({ type: 'pcm', generation: 1, buffer: new Float32Array(24000).fill(0.5).buffer })
  render()
  assert.equal(messages.at(-1).type, 'playing')
  assert.equal(messages.at(-1).rms, 0.5)
  renderUntil('buffering')
  assert.equal(messages.at(-1).rms, 0)
  assert.equal(messages.at(-1).seconds, 1)
  send({ type: 'pcm', generation: 1, buffer: new Float32Array(256).fill(0.25).buffer })
  send({ type: 'end', generation: 1 })
  render()
  assert.equal(messages.at(-1).type, 'playing', 'network finish does not finish queued audio')
  renderUntil('ended')
  assert.equal(messages.at(-1).seconds, 24256 / 24000)
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

test('Fish uses hot settings on the next synthesis without mixing an in-flight connection', () => {
  const config = { FISH_API_KEY: 'old-key', FISH_API_MODEL: 's2-pro', FISH_VOICE_ID: 'old-voice' }
  const connections = []
  const fish = new FishTts(() => config, () => {}, (_url, options) => {
    const socket = new Socket()
    connections.push({ socket, headers: options.headers })
    return socket
  })
  const key = { sessionId: 'session', turnId: 'turn', generation: 1 }
  try {
    fish.start(key)
    Object.assign(config, { FISH_API_KEY: 'new-key', FISH_API_MODEL: 's1', FISH_VOICE_ID: 'new-voice' })
    assert.equal(connections[0].socket.readyState, 0, 'Saving settings must not close the current connection')
    connections[0].socket.open()
    assert.equal(connections[0].headers.Authorization, 'Bearer old-key')
    assert.equal(connections[0].headers.model, 's2-pro')
    assert.equal(connections[0].socket.sent[0].request.reference_id, 'old-voice')
    fish.start({ ...key, generation: 2 })
    connections[1].socket.open()
    assert.equal(connections[1].headers.Authorization, 'Bearer new-key')
    assert.equal(connections[1].headers.model, 's1')
    assert.equal(connections[1].socket.sent[0].request.reference_id, 'new-voice')
    config.FISH_API_MODEL = 's2.1-pro-free'
    fish.start({ ...key, generation: 3 })
    connections[2].socket.open()
    assert.equal(connections[2].headers.model, 's2.1-pro-free', 'The free model must be sent verbatim, not replaced by a paid default')
    config.FISH_API_KEY = null
    assert.equal(fish.configured, false)
    fish.start({ ...key, generation: 4 })
    assert.equal(connections.length, 3, 'Clearing the key disables new synthesis immediately')
  } finally { fish.abort() }
})

test('Fish exposes rejected handshake status and an actionable reason without leaking credentials or retrying', async t => {
  for (const [status, code, reason] of [
    [200, 'upgrade_rejected', /upgrade/i], [302, 'redirect_rejected', /redirect/i],
    [400, 'invalid_request', /parameters/i], [401, 'authentication', /API key/i],
    [402, 'payment_required', /balance|billing/i], [403, 'permission_denied', /access/i],
    [404, 'endpoint_not_found', /endpoint/i], [405, 'method_not_allowed', /method/i],
    [407, 'proxy_authentication', /proxy/i], [408, 'request_timeout', /timeout|timed out/i],
    [413, 'request_too_large', /size/i], [415, 'unsupported_media', /format/i],
    [422, 'invalid_request', /parameters/i], [426, 'upgrade_required', /upgrade/i],
    [429, 'rate_limit', /rate limit/i], [500, 'server_error', /server/i],
    [502, 'gateway_error', /gateway/i], [503, 'service_unavailable', /unavailable/i],
    [504, 'gateway_timeout', /gateway/i], [418, 'handshake_rejected', /handshake/i],
  ]) {
    await t.test(`HTTP ${status}`, async () => {
      const secret = 'fixture-do-not-disclose'
      let requests = 0
      const server = createServer((_request, response) => {
        requests++
        response.writeHead(status, { 'Retry-After': '15' })
        response.end(`Do not show this response body: ${secret}`)
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const events = []
      let report
      const reported = new Promise(resolve => { report = resolve })
      const fish = new FishTts(() => ({ FISH_API_KEY: secret }), event => { events.push(event); report(event) }, (_url, options) =>
        new WebSocket(`ws://127.0.0.1:${server.address().port}`, options))
      try {
        fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 })
        fish.push('never synthesize this')
        const event = await reported
        assert.equal(event.type, 'error')
        assert.match(event.error, new RegExp(`HTTP ${status}`))
        assert.match(event.error, reason)
        assert.equal(event.diagnostic.provider, 'fish')
        assert.equal(event.diagnostic.phase, 'handshake')
        assert.equal(event.diagnostic.code, code)
        assert.equal(event.diagnostic.httpStatus, status)
        if (status === 429) assert.equal(event.diagnostic.retryAfterSeconds, 15)
        assert.ok(!event.error.includes(secret))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(events.length, 1, 'The following error/close must not overwrite the HTTP diagnosis')
        assert.equal(requests, 1, 'Rejected synthesis must not be retried automatically')
      } finally {
        fish.abort()
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
    })
  }
})

test('Fish preserves safe network error codes but never exposes raw error messages', () => {
  for (const [networkCode, code] of [
    ['ENOTFOUND', 'dns_not_found'], ['EAI_AGAIN', 'dns_temporary'],
    ['ECONNREFUSED', 'connection_refused'], ['ECONNRESET', 'connection_reset'],
    ['EPIPE', 'connection_reset'], ['ENETUNREACH', 'network_unreachable'], ['EHOSTUNREACH', 'host_unreachable'],
    ['ETIMEDOUT', 'network_timeout'], ['CERT_HAS_EXPIRED', 'tls_expired'],
    ['ESOCKETTIMEDOUT', 'network_timeout'], ['CERT_REVOKED', 'tls_revoked'],
    ['CERT_NOT_YET_VALID', 'tls_not_yet_valid'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_hostname'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_untrusted'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_untrusted'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_untrusted'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls_untrusted'],
    ['UNABLE_TO_GET_ISSUER_CERT', 'tls_untrusted'], ['CERT_UNTRUSTED', 'tls_untrusted'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls_handshake'], ['WS_ERR_INVALID_UTF8', 'websocket_protocol'],
    ['HPE_INVALID_HEADER_TOKEN', 'invalid_http_response'], ['', 'network_unknown'],
  ]) {
    const socket = new Socket(), events = []
    const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture-secret' }), event => events.push(event), () => socket)
    try {
      fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 })
      socket.emit('error', Object.assign(new Error('Authorization: Bearer fixture-secret'), { code: networkCode }))
      assert.equal(events[0].diagnostic.code, code)
      assert.equal(events[0].diagnostic.phase, 'handshake')
      if (networkCode) assert.equal(events[0].diagnostic.networkCode, networkCode)
      assert.ok(!events[0].error.includes('fixture-secret'))
      assert.equal(events.length, 1)
    } finally { fish.abort() }
  }
})

test('Fish reports configuration and synchronous construction failures without throwing into text chat', t => {
  for (const [config, connect, code] of [
    [{}, () => assert.fail('Missing credentials must not connect'), 'missing_key'],
    [{ FISH_API_KEY: 'fixture\r\nsecret' }, () => assert.fail('Invalid headers must not connect'), 'invalid_header'],
    [{ FISH_API_KEY: {} }, () => assert.fail('Invalid config must not connect'), 'invalid_configuration'],
    [{ FISH_API_KEY: 'fixture-secret' }, () => { throw new Error('fixture-secret') }, 'connection_setup'],
  ]) {
    const events = []
    const fish = new FishTts(() => config, event => events.push(event), connect)
    t.after(() => fish.abort())
    assert.doesNotThrow(() => fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 }))
    assert.equal(events.length, 1)
    assert.equal(events[0].diagnostic.code, code)
    assert.equal(events[0].diagnostic.phase, 'configuration')
    assert.ok(!JSON.stringify(events).includes('fixture-secret'))
    fish.abort()
  }
})

test('Fish classifies start/text/stop send failures, including async writes, without duplicate events', async t => {
  for (const kind of ['start', 'text', 'stop']) {
    for (const asynchronous of [false, true]) {
      const socket = new Socket(), events = []
      socket.send = (bytes, callback) => {
        if (decode(bytes).event !== kind) return
        const error = Object.assign(new Error('Authorization: Bearer fixture-secret'), { code: 'EPIPE' })
        if (asynchronous) queueMicrotask(() => callback(error))
        else throw error
      }
      const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture-secret' }), event => events.push(event), () => socket)
      t.after(() => fish.abort())
      fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 })
      assert.doesNotThrow(() => { socket.open(); fish.push('hello'); fish.finish() })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(events.length, 1)
      assert.equal(events[0].diagnostic.code, 'send_failed')
      assert.equal(events[0].diagnostic.event, kind)
      assert.equal(events[0].diagnostic.phase, kind === 'stop' ? 'completion' : 'synthesis')
      fish.abort()
    }
  }
})

test('Fish late write callbacks cannot fail a replacement stream', async t => {
  const sockets = [], events = []
  const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture-secret' }), event => events.push(event), () => {
    const socket = new Socket()
    socket.send = (_bytes, callback) => queueMicrotask(() => callback(new Error('fixture-secret')))
    sockets.push(socket)
    return socket
  })
  t.after(() => fish.abort())
  fish.start({ sessionId: 'session', turnId: 'one', generation: 1 })
  sockets[0].open()
  fish.start({ sessionId: 'session', turnId: 'two', generation: 2 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.length, 0)
  sockets[1].open()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.length, 1)
  assert.equal(events[0].generation, 2)
  assert.equal(events[0].diagnostic.code, 'send_failed')
  assert.ok(!events[0].error.includes('fixture-secret'))
  fish.abort()
})

test('Fish distinguishes decode, payload, audio and finish failures; unknown events remain forward-compatible', t => {
  for (const [bytes, code] of [
    [new Uint8Array([0xc1]), 'decode_failed'], [encode(null), 'invalid_event'],
    [encode({ event: 42 }), 'invalid_event'], [encode({ event: '' }), 'invalid_event'], [encode({ event: 'audio', audio: 'bad' }), 'invalid_audio'],
    [encode({ event: 'finish', reason: 'unexpected' }), 'invalid_finish'],
  ]) {
    const socket = new Socket(), events = []
    const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture-secret' }), event => events.push(event), () => socket)
    t.after(() => fish.abort())
    fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 })
    socket.open()
    socket.emit('message', encode({ event: 'future-event' }))
    assert.equal(events.length, 0)
    socket.emit('message', bytes)
    assert.equal(events[0].diagnostic.code, code)
    assert.equal(events[0].diagnostic.phase, 'synthesis')
    fish.abort()
  }
})

test('Fish service errors retain bounded, credential-redacted details rather than becoming network failures', t => {
  for (const event of ['error', 'finish']) {
    const socket = new Socket(), events = []
    const secret = 'fixture/+secret='
    const fish = new FishTts(() => ({ FISH_API_KEY: secret }), value => events.push(value), () => socket)
    t.after(() => fish.abort())
    fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 })
    socket.open()
    socket.emit('message', encode({ event, reason: 'error', message: `Voice was not found. ${secret} ${encodeURIComponent(secret)} Authorization: Bearer other-secret api_key="third-secret" https://user:url-secret@example.com/?token=query-secret Basic YmFzaWMtc2VjcmV0\n` + 'x'.repeat(1000) }))
    assert.equal(events.length, 1)
    assert.equal(events[0].diagnostic.code, 'service_error')
    assert.equal(events[0].diagnostic.event, event)
    assert.match(events[0].diagnostic.detail, /Voice was not found/)
    assert.ok(events[0].diagnostic.detail.length <= 320)
    assert.ok(!JSON.stringify(events).includes(secret))
    assert.ok(!JSON.stringify(events).includes(encodeURIComponent(secret)))
    assert.doesNotMatch(JSON.stringify(events), /other-secret|third-secret|url-secret|query-secret|YmFzaWMtc2VjcmV0/)
    fish.abort()
  }
})

test('Fish distinguishes close reasons and never treats close 1000 alone as synthesis completion', t => {
  for (const [closeCode, code] of [[1000, 'closed_without_finish'], [1001, 'peer_going_away'], [1002, 'protocol_close'], [1003, 'unsupported_frame'],
    [1005, 'close_without_status'], [1006, 'abnormal_close'], [1007, 'invalid_frame_data'], [1008, 'policy_close'],
    [1009, 'frame_too_large'], [1011, 'server_close'], [1012, 'service_restart'], [1013, 'service_overloaded'], [1015, 'tls_handshake'], [4001, 'connection_closed']]) {
    const socket = new Socket(), events = []
    const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture-secret' }), event => events.push(event), () => socket)
    t.after(() => fish.abort())
    fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 })
    socket.open()
    fish.finish()
    socket.emit('close', closeCode, Buffer.from('fixture-secret'))
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.equal(events[0].diagnostic.code, code)
    assert.equal(events[0].diagnostic.closeCode, closeCode)
    assert.equal(events[0].diagnostic.phase, 'completion')
    assert.ok(!events[0].error.includes('fixture-secret'))
    fish.abort()
  }
})

test('Fish tracks handshake versus first-audio and completion timeouts without timing out tool pauses', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let socket
  const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture' }), event => events.push(event), () => { socket = new Socket(); return socket })
  const key = { sessionId: 'session', turnId: 'turn', generation: 1 }
  try {
    fish.start(key)
    fish.push('hello')
    fish.finish()
    socket.readyState = WebSocket.CLOSING // ws changes state before delivering an opening error.
    socket.emit('error', new Error('Opening handshake has timed out'))
    assert.equal(events[0].diagnostic.code, 'handshake_timeout')
    assert.equal(events[0].diagnostic.phase, 'handshake')
    events.length = 0
    socket.readyState = WebSocket.CONNECTING
    fish.start({ ...key, generation: 2 })
    socket.open()
    fish.push('short text')
    t.mock.timers.tick(60000)
    assert.equal(events.length, 0, 'Waiting for the model/tool is not a Fish timeout')
    fish.finish()
    t.mock.timers.tick(30000)
    assert.equal(events.at(-1).diagnostic.code, 'first_audio_timeout')
    events.length = 0
    socket.readyState = WebSocket.CONNECTING
    fish.start({ ...key, generation: 3 })
    socket.open()
    fish.push('hello')
    fish.finish()
    t.mock.timers.tick(20000)
    socket.emit('message', encode({ event: 'audio', audio: new Uint8Array([0, 0]) }))
    t.mock.timers.tick(20000)
    assert.equal(events.filter(event => event.type === 'error').length, 0)
    t.mock.timers.tick(10000)
    assert.equal(events.at(-1).diagnostic.code, 'completion_timeout')
  } finally { fish.abort() }
})

test('Fish distinguishes malformed opening headers and ignores intentional aborts and late events', () => {
  for (const [message, code] of [['Invalid Upgrade header', 'invalid_upgrade'], ['Invalid Sec-WebSocket-Accept header', 'invalid_accept'],
    ['Server sent an invalid subprotocol', 'subprotocol_mismatch'], ['Invalid Sec-WebSocket-Extensions header', 'extension_mismatch']]) {
    const socket = new Socket(), events = []
    const fish = new FishTts(() => ({ FISH_API_KEY: 'fixture' }), event => events.push(event), () => socket)
    try {
      fish.start({ sessionId: 'session', turnId: 'turn', generation: 1 })
      socket.readyState = WebSocket.CLOSING
      socket.emit('error', new Error(message))
      assert.equal(events[0].diagnostic.code, code)
      assert.equal(events[0].diagnostic.phase, 'handshake')
      events.length = 0
      socket.readyState = WebSocket.CONNECTING
      fish.start({ sessionId: 'session', turnId: 'turn', generation: 2 })
      fish.abort()
      socket.emit('error', new Error('late failure'))
      socket.emit('close', 1008, Buffer.from('late policy failure'))
      socket.emit('message', new Uint8Array([0xc1]))
      assert.equal(events.length, 0)
    } finally { fish.abort() }
  }
})

test('Fish tunnels through the configured network proxy and stays direct without one', () => {
  const options = [], events = [], config = { FISH_API_KEY: 'fixture' }
  const fish = new FishTts(() => config, event => events.push(event), (_url, value) => {
    options.push(value)
    const socket = new Socket(); socket.readyState = 1; return socket
  })
  const key = generation => ({ sessionId: 'session', turnId: 'turn', generation })
  try {
    fish.start(key(1))
    assert.equal(options[0].agent, undefined, 'no address means a direct connection')
    config.network_proxy = 'http://127.0.0.1:7890'
    fish.start(key(2))
    assert.equal(options[1].agent.constructor.name, 'HttpsProxyAgent')
    fish.start(key(3))
    assert.equal(options[2].agent, options[1].agent, 'the same address reuses one agent')
    config.network_proxy = 'http://127.0.0.1:7891'
    fish.start(key(4))
    assert.notEqual(options[3].agent, options[1].agent)
    config.network_proxy = 42
    events.length = 0
    fish.start(key(5))
    assert.equal(events[0].diagnostic.code, 'invalid_configuration')
  } finally { fish.abort() }
})
