import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { fetch as undiciFetch } from 'undici'
import { createDialer, refusalOf } from '../src/main/durable/handoff/fetchGuard.ts'
import { createWebFetchTool } from '../src/main/durable/handoff/research.ts'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => (server.closeAllConnections?.(), server.close(() => resolve())))

/** 一个本机"网站"：回显它收到的 Host 头与路径。 */
async function site() {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url })
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<p>host=${request.headers.host} url=${request.url}</p>`)
  })
  return { server, port: await listen(server), seen }
}

/** 一个把所有请求都转给本机网站的"代理"，并记下它看到的目标。 */
async function proxyTo(webPort) {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push(`FORWARD ${request.method} ${request.url} host=${request.headers.host}`)
    const target = new URL(request.url)
    const upstream = http.request({ host: '127.0.0.1', port: webPort, path: target.pathname + target.search, headers: request.headers }, answer => {
      response.writeHead(answer.statusCode, answer.headers)
      answer.pipe(response)
    })
    upstream.end()
  })
  server.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  return { server, port: await listen(server), seen }
}

test('the dialer connects only to the pinned addresses, and keeps the host name in Host', async () => {
  const web = await site()
  const dialer = createDialer(new Map([['pinned.test', ['127.0.0.1']]]), {})
  try {
    const response = await undiciFetch(`http://pinned.test:${web.port}/x?y=1`, { dispatcher: dialer })
    assert.equal(await response.text(), `<p>host=pinned.test:${web.port} url=/x?y=1</p>`)
    assert.deepEqual(web.seen, [{ host: `pinned.test:${web.port}`, url: '/x?y=1' }], 'the request went to the pinned address and still named the site')
  } finally {
    await dialer.destroy()
    await close(web.server)
  }
})

test('the dialer fails closed: a host that was never validated is not looked up, and an IPv6 literal is pinned under its bracketed form', async () => {
  const web = await site()
  const dialer = createDialer(new Map([['[::1]', ['::1']]]), {})
  try {
    const error = await undiciFetch(`http://unvalidated.test:${web.port}/`, { dispatcher: dialer }).then(() => undefined, caught => caught)
    assert.ok(error, 'the request failed')
    assert.equal(refusalOf(error)?.message, 'The domain name could not be resolved.')
    assert.deepEqual(web.seen, [])
    // IPv6 字面量：拨号层按 URL 里的写法取地址；本机没有监听 ::1，所以连接失败，但失败的是连接而不是解析。
    const v6 = await undiciFetch(`http://[::1]:${web.port}/`, { dispatcher: dialer }).then(() => undefined, caught => caught)
    assert.ok(v6 && refusalOf(v6) === undefined, 'a connection error, not a refusal')
  } finally {
    await dialer.destroy()
    await close(web.server)
  }
})

test('web_fetch through a proxy: the proxy is told the address that was validated, not the name, and the name is never resolved twice', async () => {
  const web = await site()
  const proxy = await proxyTo(web.port)
  // 重绑定的域名：第一次答公网地址，之后每次都答本机。
  const asked = []
  const lookup = async hostname => {
    asked.push(hostname)
    return [{ address: asked.length === 1 ? '203.0.113.7' : '127.0.0.1' }]
  }
  const env = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }
  const tool = createWebFetchTool({ lookup, env })
  try {
    const result = await tool.execute({ url: 'http://rebind.test/p?q=1' }, {}, ctx)
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.match(result.content[0].text, /host=rebind\.test url=\/p\?q=1/, 'the site still saw its own name in Host')
    assert.deepEqual(proxy.seen, ['FORWARD GET http://203.0.113.7/p?q=1 host=rebind.test'], 'the proxy was given the validated address')
    assert.deepEqual(asked, ['rebind.test'], 'one resolution per hop')

    const tls = await createWebFetchTool({ lookup: async () => [{ address: '203.0.113.7' }], env }).execute({ url: 'https://rebind.test/secure' }, {}, ctx)
    assert.equal(tls.isError, true, 'this stand-in proxy refuses tunnels')
    assert.deepEqual(proxy.seen.slice(1), ['CONNECT 203.0.113.7:443'], 'the tunnel is asked for the address, so the proxy has nothing to resolve')
  } finally {
    await close(proxy.server)
    await close(web.server)
  }
})

test('web_fetch pins every redirect hop to the address validated for that hop', async () => {
  const web = await site()
  const proxy = await proxyTo(web.port)
  const hops = []
  // 第一跳的页面把读者重定向到另一个域名；每一跳各自解析、各自校验、各自固定。
  const redirecting = http.createServer((request, response) => {
    response.writeHead(302, { location: 'http://second.test/landed' })
    response.end()
  })
  const redirectPort = await listen(redirecting)
  const forward = http.createServer((request, response) => {
    hops.push(`${request.url} host=${request.headers.host}`)
    const target = new URL(request.url)
    const port = target.hostname === '203.0.113.7' ? redirectPort : web.port
    const upstream = http.request({ host: '127.0.0.1', port, path: target.pathname + target.search, headers: request.headers }, answer => {
      response.writeHead(answer.statusCode, answer.headers)
      answer.pipe(response)
    })
    upstream.end()
  })
  const forwardPort = await listen(forward)
  const addresses = { 'first.test': '203.0.113.7', 'second.test': '203.0.113.8' }
  const resolved = []
  const tool = createWebFetchTool({
    lookup: async hostname => (resolved.push(hostname), addresses[hostname] ? [{ address: addresses[hostname] }] : []),
    env: { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://127.0.0.1:${forwardPort}` },
  })
  try {
    const result = await tool.execute({ url: 'http://first.test/start' }, {}, ctx)
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.match(result.content[0].text, /url="http:\/\/second\.test\/landed"/)
    assert.deepEqual(hops, ['http://203.0.113.7/start host=first.test', 'http://203.0.113.8/landed host=second.test'])
    assert.deepEqual(resolved, ['first.test', 'second.test'])
  } finally {
    await close(forward)
    await close(redirecting)
    await close(proxy.server)
    await close(web.server)
  }
})

test('web_fetch without the proxy variables still validates before it dials, and never reaches a private address', async () => {
  const web = await site()
  const asked = []
  const tool = createWebFetchTool({ lookup: async hostname => (asked.push(hostname), [{ address: '127.0.0.1' }]), env: {} })
  try {
    const result = await tool.execute({ url: `http://start.test:${web.port}/` }, {}, ctx)
    assert.equal(result.isError, true)
    assert.equal(result.content[0].text, 'Local and private network addresses cannot be read.')
    assert.deepEqual(asked, ['start.test'])
    assert.deepEqual(web.seen, [], 'the local site never received a request')
  } finally {
    await close(web.server)
  }
})
