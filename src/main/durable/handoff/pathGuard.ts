import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@earendil-works/chord'
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { HandoffsDoc } from './docs.ts'

/**
 * NodeExecutionEnv 的 cwd 不是沙箱：绝对路径直接放行，`..` 照常解析（pi-tool-constraints §4.1）。
 * files 与 task 的所有文件工具都先过这里；拒绝列表优先于授权根。拒绝列表是初版，集中在此维护。
 */
export type DenyCategory = 'app data' | 'credentials'

export type PathGuardOptions = {
  home?: string
  /** 每个 worker 的 env 在 fork 时就定了，所以只在第一次用到时读一次；测试传入自己的。 */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /**
   * 宿主显式给出的拒绝根（会话根目录、记忆目录、userData 等）。拒绝范围以这里为准，env 里的目录只是兜底：
   * 变量改名时 env 兜底会悄悄失效，没有测试能发现，所以生产环境应当总是传入。
   */
  deny?: readonly string[]
}

/** 一个任务能碰的范围：授权路径加任务私有目录。 */
export type Scope = { cwd: string; paths: readonly string[] }

export type Grant =
  | { ok: true; path: string }
  | { ok: false; reason: 'relative' | 'missing' | 'unreadable' }
  | { ok: false; reason: 'denied'; category: DenyCategory }

type DenyRoot = { root: string; category: DenyCategory }

// 只看文件名：`.env` 目录（Python 虚拟环境常叫这个名字）里的普通文件不该被连坐。
const DENIED_NAMES: readonly RegExp[] = [/^\.env/i, /\.pem$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /\.(p12|pfx)$/i, /^\.(netrc|pgpass|npmrc|pypirc|git-credentials)$/i]

// 主进程 fork worker 时设置的是 AMADEUS_NEXT_SESSIONS；后两个是早期版本的旧名，仍然认。
const SESSIONS_ENV = ['AMADEUS_NEXT_SESSIONS', 'AMADEUS_NEXT_DURABLE_SESSIONS', 'AMADEUS_NEXT_PI_SESSIONS']

// 用户目录里常见的明文凭据：令牌文件，以及人们习惯在里面 export API key 的 shell 启动文件和历史记录。
const HOME_CREDENTIALS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.netrc', '.npmrc', '.docker/config.json', 'Library/Keychains',
  '.git-credentials', '.config/git/credentials', '.pypirc', '.gem/credentials', '.cargo/credentials', '.cargo/credentials.toml',
  '.config/gh', '.config/gcloud', '.azure', '.terraform.d', '.config/rclone', '.oci', '.vault-token', '.password-store', '.s3cfg', '.boto',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile',
  '.zsh_history', '.zsh_sessions', '.bash_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history',
  'Library/Cookies', 'Library/Messages', 'Library/Mail',
]

// 浏览器的用户数据目录里有 cookie、已存密码和登录态。
const HOME_BROWSERS = [
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Chromium',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Firefox',
  'Library/Application Support/Arc',
  'Library/Safari',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/microsoft-edge',
  '.mozilla',
]

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * 与内置 read / write / edit 的路径预处理保持一致（pi-durable 的 path-utils：Unicode 空格换成空格、去掉开头的 `@`）。
 * 守卫若按另一套规则解析，`@/etc/passwd` 会被当成 cwd 下的相对路径放行，而工具实际读的是 /etc/passwd。
 */
export const normalizeToolPath = (value: string): string => {
  const normalized = value.replace(UNICODE_SPACES, ' ')
  return normalized.startsWith('@') ? normalized.slice(1) : normalized
}

export function createPathGuard(options: PathGuardOptions = {}) {
  const platform = options.platform ?? process.platform
  // macOS 默认文件系统大小写不敏感；Linux 上多拒绝一点没有坏处，但授权根不能因此放宽，所以只对非 Linux 折叠。
  const fold = (value: string): string => (platform === 'linux' ? value : value.toLowerCase())
  const home = options.home ?? homedir()

  const within = (target: string, root: string): boolean => {
    const a = fold(target)
    const b = fold(root)
    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
  }

  let denyRoots: Promise<DenyRoot[]> | undefined

  async function build(): Promise<DenyRoot[]> {
    const env = options.env ?? process.env
    const found: DenyRoot[] = []
    const add = (value: string | undefined, category: DenyCategory) => {
      if (value) found.push({ root: path.resolve(value.startsWith('~/') ? path.join(home, value.slice(2)) : value), category })
    }
    add(env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'), 'app data')
    // userData 里有所有会话的 durable.sqlite、记忆和旧会话；worker 只拿到其下的 sessions 目录，取其父目录。
    for (const name of SESSIONS_ENV) if (env[name]) add(path.dirname(path.resolve(env[name])), 'app data')
    add(env.AMADEUS_MEMORY_DIR, 'app data')
    add(env.AMADEUS_NEXT_PI_AUTH, 'credentials')
    add(env.AMADEUS_NEXT_PI_MODELS, 'credentials')
    add(path.join(env.AMADEUS_HOME || path.join(home, '.amadeus'), 'settings.yaml'), 'app data')
    for (const entry of HOME_CREDENTIALS) add(path.join(home, entry), 'credentials')
    for (const entry of HOME_BROWSERS) add(path.join(home, entry), 'credentials')
    for (const entry of options.deny ?? []) add(entry, 'app data')
    // 同时登记词法形式与 realpath：授权路径和工具目标都是 realpath 之后的，/var 与 /private/var 这类别名不能让拒绝列表失效。
    const real = await Promise.all(found.map(async each => ({ ...each, root: await realpath(each.root).catch(() => undefined) })))
    const seen = new Set<string>()
    return [...found, ...real.flatMap(each => (each.root ? [{ root: each.root, category: each.category }] : []))].filter(each => {
      const key = fold(each.root)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const roots = (): Promise<DenyRoot[]> => (denyRoots ??= build())

  /**
   * 命中拒绝列表的类别。任务私有目录在 userData 之下，不能因此被整体拒绝：
   * 在私有目录内时，只跳过"包含私有目录"的那些根，文件名规则仍然生效。
   */
  async function denied(target: string, privateDir?: string): Promise<DenyCategory | undefined> {
    if (DENIED_NAMES.some(pattern => pattern.test(path.basename(target)))) return 'credentials'
    const own = privateDir && within(target, privateDir) ? privateDir : undefined
    for (const entry of await roots()) {
      if (!within(target, entry.root)) continue
      if (own && within(own, entry.root)) continue
      return entry.category
    }
    return undefined
  }

  /** realpath；目标还不存在（写新文件）时对最深的已有祖先取 realpath，再接回尾部。 */
  async function canonical(env: ExecutionEnv, absolute: string, context: Context): Promise<string | undefined> {
    const tail: string[] = []
    let current = absolute
    for (;;) {
      const real = await env.canonicalPath(current, context)
      if (real.ok) return path.join(real.value, ...tail)
      // 其它错误（权限、路径中间是文件）不猜测，按拒绝处理。
      if (real.error.code !== 'not_found') return undefined
      // realpath 找不到也可能是悬空符号链接：名字在、目标不在。当作"尚不存在的新文件"的话，结果是链接自己的路径（看上去在授权范围内），
      // 而 write / edit 用它时会穿过链接去创建真实目标。fileInfo 是 lstat，名字本身存在就拒绝。
      const named = await env.fileInfo(current, context)
      if (named.ok || named.error.code !== 'not_found') return undefined
      const parent = path.dirname(current)
      if (parent === current) return undefined
      tail.unshift(path.basename(current))
      current = parent
    }
  }

  return {
    /**
     * handoff 受理时规范化一个授权路径：只收绝对路径或 `~/` 开头，必须已存在，取 realpath；
     * 词法形式与 realpath 都要过拒绝列表（`~/notes` 指向 `~/.ssh` 的符号链接不能当作入口）。
     */
    async grant(raw: string): Promise<Grant> {
      const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
      if (!path.isAbsolute(expanded)) return { ok: false, reason: 'relative' }
      const lexical = path.resolve(expanded)
      let real: string
      try {
        real = await realpath(lexical)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' }
      }
      const category = (await denied(lexical)) ?? (await denied(real))
      return category ? { ok: false, reason: 'denied', category } : { ok: true, path: real }
    },

    /** 工具调用时：返回应当交给原工具的 realpath；范围外、命中拒绝列表或解析失败返回 undefined。 */
    async resolve(env: ExecutionEnv, raw: string, scope: Scope, context: Context): Promise<string | undefined> {
      const absolute = await env.absolutePath(normalizeToolPath(raw), context)
      if (!absolute.ok) return undefined
      const target = await canonical(env, absolute.value, context)
      if (!target) return undefined
      // 登记的 cwd 是词法路径（taskRoot 拼接而成），目标是 realpath；/var 与 /private/var 这类别名要取同一种形式才比得上。
      const own = scope.cwd ? await canonical(env, scope.cwd, context) : undefined
      if (await denied(target, own)) return undefined
      return [...scope.paths, ...(own ? [own] : [])].some(root => within(target, root)) ? target : undefined
    },
  }
}

export type PathGuard = ReturnType<typeof createPathGuard>

/** 本子对话对应的委托条目给出的范围；找不到条目时返回 undefined，调用方按拒绝处理。 */
export async function scopeOf(api: ToolExecutionApi, context: Context): Promise<Scope | undefined> {
  const handoffs = await api.snapshot(HandoffsDoc, ROOT_CONVERSATION_ID, context)
  const item = handoffs?.items.find(each => each.child === api.conversationId)
  return item ? { cwd: item.cwd, paths: item.paths } : undefined
}

export const refusedText = (given: string): string => `${given} is outside the locations you were given, or cannot be accessed.`
