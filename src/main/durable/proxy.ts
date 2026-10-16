import { EventEmitter } from 'node:events'
import { Agent, Client, EnvHttpProxyAgent, Pool, install, setGlobalDispatcher, type Dispatcher } from 'undici'

const ignore = () => {}
// 中途终止流式响应时 undici 可能在内部 Client 上发 error；没人监听会被当成未处理异常打崩 worker。
const quiet = <T extends Dispatcher>(dispatcher: T): T => {
  if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, 'error', ignore)
  return dispatcher
}
const client = (origin: string | URL, options: object) => quiet(new Client(origin, options))
const origin = (url: string | URL, options: object): Dispatcher =>
  (options as { connections?: number }).connections === 1 ? client(url, options) : quiet(new Pool(url, { ...options, factory: client }))

/**
 * worker 的 fetch 统一走 npm undici，dispatcher 按当前 env 现建：Node 的 NODE_USE_ENV_PROXY 只在进程启动时读一次，
 * 设置页改了代理要热生效，只能自己换全局 dispatcher。是否走代理沿用 Node 的约定（NODE_USE_ENV_PROXY 为 1 才读 HTTP(S)_PROXY）。
 * 做法与 pi-coding-agent 的 configureHttpDispatcher 一致：fetch 与 dispatcher 同一份 undici，避免压缩响应解不开。
 */
export function installProxy(env: NodeJS.ProcessEnv = process.env): void {
  const proxied = /^(1|true)$/i.test(env.NODE_USE_ENV_PROXY?.trim() ?? '')
  const dispatcher = proxied
    ? new EnvHttpProxyAgent({
      allowH2: false, proxyTunnel: true, factory: origin, clientFactory: client,
      httpProxy: env.HTTP_PROXY ?? env.http_proxy, httpsProxy: env.HTTPS_PROXY ?? env.https_proxy, noProxy: env.NO_PROXY ?? env.no_proxy,
    })
    : new Agent({ allowH2: false, factory: origin })
  setGlobalDispatcher(quiet(dispatcher))
  install()
}
