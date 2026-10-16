import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { EnvHttpProxyAgent, getGlobalDispatcher } from 'undici'
import { installProxy } from '../src/main/durable/proxy.ts'
import { WORKER_SETTING_KEYS, applySettingsEnv } from '../src/shared/workerSettings.ts'

test('applySettingsEnv sets, clears and reports only the managed keys', () => {
  const env = { AMADEUS_MCP_MODE: 'shared', OTHER: 'kept' }
  const changed = applySettingsEnv(env, { AMADEUS_MCP_MODE: '', AMADEUS_SKILLS_MODE: 'shared', HTTP_PROXY: 7, OTHER: 'changed' })
  assert.deepEqual([...changed].sort(), ['AMADEUS_MCP_MODE', 'AMADEUS_SKILLS_MODE'], 'a non-string counts as empty, and HTTP_PROXY was already empty')
  assert.deepEqual(env, { AMADEUS_SKILLS_MODE: 'shared', OTHER: 'kept' })
  assert.ok(WORKER_SETTING_KEYS.includes('AMADEUS_TRANSLATION_MODEL'))
})

test('the proxy is swapped in place: requests go through it once enabled and stop when it is cleared', async t => {
  const hits = { proxy: 0, origin: 0 }
  const origin = createServer((_request, response) => { hits.origin++; response.end('origin') })
  // 明文 HTTP 经代理时走 CONNECT 隧道（proxyTunnel），代理把隧道接到源站。
  const proxy = createServer()
  proxy.on('connect', (request, socket) => {
    hits.proxy++
    const [host, port] = request.url.split(':')
    import('node:net').then(({ connect }) => {
      const upstream = connect(Number(port), host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(socket); socket.pipe(upstream) })
      upstream.on('error', () => socket.destroy())
    })
  })
  await Promise.all([new Promise(resolve => origin.listen(0, '127.0.0.1', resolve)), new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))])
  t.after(() => { origin.close(); proxy.close() })
  const url = `http://127.0.0.1:${origin.address().port}/`
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`

  installProxy({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '' })
  assert.ok(getGlobalDispatcher() instanceof EnvHttpProxyAgent)
  assert.equal(await (await fetch(url)).text(), 'origin')
  assert.equal(hits.proxy, 1)

  installProxy({ HTTP_PROXY: proxyUrl })
  assert.equal(getGlobalDispatcher() instanceof EnvHttpProxyAgent, false, 'the address alone does not opt in, as with Node')
  assert.equal(await (await fetch(url)).text(), 'origin')
  assert.deepEqual(hits, { proxy: 1, origin: 2 })
})
