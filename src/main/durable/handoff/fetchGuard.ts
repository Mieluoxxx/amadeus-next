import { isIP } from 'node:net'
import { Agent, EnvHttpProxyAgent, interceptors, type Dispatcher } from 'undici'

/** 带面向模型的短原因；不把堆栈、内部地址等细节放进工具结果。 */
export class FetchRefused extends Error {}

const ipv4Parts = (ip: string): number[] => ip.split('.').map(Number)

function privateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

/** 展开成 8 个 16 位组；`::` 与内嵌的点分 IPv4 尾巴都处理。 */
function expandIPv6(ip: string): number[] {
  let address = ip.toLowerCase().split('%')[0]
  const tail = address.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const [a, b, c, d] = ipv4Parts(tail[1])
    address = address.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, rest] = address.split('::')
  const left = head ? head.split(':') : []
  const right = rest === undefined ? [] : rest ? rest.split(':') : []
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map(group => parseInt(group, 16))
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return privateIPv4(ipv4Parts(address))
  if (version !== 6) return true
  const g = expandIPv6(address)
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]
  // ::ffff:a.b.c.d（映射）、::a.b.c.d（兼容，含 :: 与 ::1）都按内嵌的 IPv4 判断。
  if (g.slice(0, 5).every(group => group === 0) && (g[5] === 0xffff || g[5] === 0)) return privateIPv4(embedded)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(group => group === 0)) return privateIPv4(embedded)
  if (g[0] === 0x2002) return privateIPv4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255])
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00
}

export type Resolver = (hostname: string) => Promise<readonly { address: string }[]>

/** 本次抓取里校验通过的主机（URL 里的写法）→ 它的全部地址。拨号层只认这张表。 */
export type Pinned = Map<string, string[]>

const PRIVATE = 'Local and private network addresses cannot be read.'

/**
 * 逐跳校验一个目标，通过的地址登记进 `pinned`。
 * 校验与连接用的是同一份解析结果：拨号层（createDialer）只能连 `pinned` 里的地址，不会"校验一次、连接时再解析一次"，
 * 所以攻击者的域名在两次解析之间改答案（DNS 重绑定）没有可乘之机。
 */
export async function assertPublic(url: URL, resolve: Resolver, pinned: Pinned): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchRefused('Only http and https links are supported.')
  if (url.username || url.password) throw new FetchRefused('Links must not contain a username or password.')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new FetchRefused(PRIVATE)
  const addresses = isIP(host) ? [host] : (await resolve(host).catch(() => [])).map(entry => entry.address)
  if (addresses.length === 0) throw new FetchRefused('The domain name could not be resolved.')
  if (addresses.some(isPrivateAddress)) throw new FetchRefused(PRIVATE)
  // 键用 URL 里的写法（IPv6 带方括号），拨号层按同一个键来取。
  pinned.set(url.hostname, addresses)
}

// 连不上时（含 IPv6 不通）尽快换另一个地址族，而不是等满默认的 10 秒。
const CONNECT_TIMEOUT_MS = 5_000
// 记录在拨号层里的存活时间：盖过一次抓取（超时 15 秒 × 若干跳）。过期后它会再调 lookup，而 lookup 只读 pinned，答案不变。
const RECORD_TTL_MS = 60_000

const truthy = (value: string | undefined): boolean => value === '1' || value === 'true'

/**
 * 只连 `pinned` 里的地址的 dispatcher：undici 的 dns 拦截器把请求改发到解析出的 IP，同时保留 Host 头与 TLS 的 SNI / 证书校验用的主机名；
 * 它的 lookup 不查 DNS，只读 `pinned`，没登记的主机一律拒绝（失败即关闭）。
 *
 * 经代理时同样成立：请求以 IP 发给代理（CONNECT ip:443 / 绝对地址里是 IP），代理不会再解析域名。
 * 是否走代理沿用 Node 的约定：NODE_USE_ENV_PROXY 为 1 时读 HTTP(S)_PROXY / NO_PROXY（主进程在配置了网络代理时设置）。
 * 残余：NO_PROXY 里按主机名写的条目对 IP 不再匹配；不遵守"绝对地址优先于 Host 头"的代理仍会自己解析 Host。
 *
 * 不能用 fetch 自己改写 URL 再带 Host 头：fetch 会丢掉调用方给的 Host 头，SNI 也会变成 IP。
 */
export function createDialer(pinned: Pinned, env: NodeJS.ProcessEnv = process.env): Dispatcher {
  const options = { allowH2: false, connectTimeout: CONNECT_TIMEOUT_MS }
  const base = truthy(env.NODE_USE_ENV_PROXY)
    ? new EnvHttpProxyAgent({
        ...options,
        httpProxy: env.HTTP_PROXY ?? env.http_proxy,
        httpsProxy: env.HTTPS_PROXY ?? env.https_proxy,
        noProxy: env.NO_PROXY ?? env.no_proxy,
      })
    : new Agent(options)
  return base.compose(
    interceptors.dns({
      // IPv4 优先；连接被拒或超时会自动试另一个地址族。
      affinity: 4,
      maxTTL: RECORD_TTL_MS,
      lookup: (origin, _options, callback) => {
        const addresses = pinned.get(origin.hostname)
        if (!addresses) return callback(new FetchRefused('The domain name could not be resolved.'), [])
        callback(null, addresses.map(address => ({ address, family: isIP(address) === 6 ? 6 : 4, ttl: RECORD_TTL_MS })))
      },
    }),
  )
}

/** fetch 把拨号层的错误包在 cause 里。 */
export function refusalOf(error: unknown): FetchRefused | undefined {
  if (error instanceof FetchRefused) return error
  return error instanceof Error && error.cause instanceof FetchRefused ? error.cause : undefined
}
