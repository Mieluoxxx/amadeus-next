import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { OfflineConnection, RemoteConnection, RemoteExecutionEnv } from './client.ts'
import type { Hello } from './protocol.ts'
import { sshArguments, type RemoteTarget } from './targets.ts'

/** 到 runner 的一条字节通道；ssh 之外，测试用回环实现它。 */
export type Link = {
  input: Readable
  output: Writable
  close(): void
  /** 通道失败时附在错误里的诊断（ssh 的 stderr 末尾）。 */
  diagnostics?(): string
}

export type Connector = (target: RemoteTarget) => Promise<Link>

export type DirCheck = { ok: true; path: string } | { ok: false; reason: 'offline' | 'missing' | 'not_directory'; detail: string }

export type TargetPoolOptions = {
  targets: readonly RemoteTarget[]
  connector: Connector
  log?: (message: string, error?: unknown) => void
  now?: () => number
  /** 调用方等一条可用连接的上限；超过就按离线失败，不让工具调用无限挂着。 */
  waitMs?: number
  helloTimeoutMs?: number
}

const WAIT_MS = 15_000
const HELLO_TIMEOUT_MS = 20_000
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000
/** 断线后只在最近用过的目标上后台重连：没人用的目标不该一直拨号。 */
const RETRY_WINDOW_MS = 10 * 60_000

type Slot = {
  target: RemoteTarget
  connection?: RemoteConnection
  link?: Link
  hello?: Hello
  connecting?: Promise<RemoteConnection>
  offlineSince?: number
  lastError?: string
  lastUsed: number
  attempt: number
  retry?: ReturnType<typeof setTimeout>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function timeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * 每个远程目标一条连接，worker 内所有会话共用。连接是一个 generation：断了就作废，在途调用失败、不重放；
 * 之后的调用（或后台重连）新建一条。Harness 每次用 env 都会重新要一个，所以新调用自然落在新连接上。
 */
export class TargetPool {
  private readonly slots = new Map<string, Slot>()
  private readonly connector: Connector
  private readonly log: (message: string, error?: unknown) => void
  private readonly now: () => number
  private readonly waitMs: number
  private readonly helloTimeoutMs: number
  /** 主动关掉的连接：它们的断开不算离线，也不触发重连。 */
  private readonly retired = new WeakSet<RemoteConnection>()

  constructor(options: TargetPoolOptions) {
    for (const target of options.targets) this.slots.set(target.name, { target, lastUsed: 0, attempt: 0 })
    this.connector = options.connector
    this.log = options.log ?? ((text, error) => console.error(`[amadeus-next] remote: ${text}`, error ?? ''))
    this.now = options.now ?? Date.now
    this.waitMs = options.waitMs ?? WAIT_MS
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  }

  get targets(): RemoteTarget[] { return [...this.slots.values()].map(slot => slot.target) }

  has(name: string): boolean { return this.slots.has(name) }

  /** 断线或连不上的起始时刻；在线、或从没用过时为 undefined。 */
  offlineSince(name: string): number | undefined { return this.slots.get(name)?.offlineSince }

  lastError(name: string): string | undefined { return this.slots.get(name)?.lastError }

  /** 最近一次握手里 runner 报告的机器信息；从没连上过时为 undefined。 */
  hello(name: string): Hello | undefined { return this.slots.get(name)?.hello }

  /** 给工具用的 env。连不上时仍返回一个 env，它的每个调用都以 unknown 失败，错误文本交给模型。 */
  async env(name: string, cwd: string): Promise<ExecutionEnv> {
    const slot = this.slots.get(name)
    if (!slot) return new RemoteExecutionEnv({ name, connection: new OfflineConnection(`remote target ${name} is not configured`), cwd })
    try {
      const connection = await this.ready(slot)
      return new RemoteExecutionEnv({ name, connection, cwd: this.expand(slot, cwd) })
    } catch (error) {
      return new RemoteExecutionEnv({ name, connection: new OfflineConnection(message(error)), cwd })
    }
  }

  /** handoff 受理时确认工作目录：远程展开 `~`、取 realpath、必须是目录。 */
  async checkDir(name: string, raw: string | undefined): Promise<DirCheck> {
    const slot = this.slots.get(name)
    if (!slot) return { ok: false, reason: 'offline', detail: `remote target ${name} is not configured` }
    let connection: RemoteConnection
    try {
      connection = await this.ready(slot)
    } catch (error) {
      return { ok: false, reason: 'offline', detail: message(error) }
    }
    const wanted = this.expand(slot, raw?.trim() || slot.target.workspace)
    const env = new RemoteExecutionEnv({ name, connection, cwd: slot.hello!.home })
    const real = await env.canonicalPath(wanted, BACKGROUND_CONTEXT)
    if (!real.ok) return { ok: false, reason: real.error.code === 'not_found' ? 'missing' : 'offline', detail: real.error.message }
    const info = await env.fileInfo(real.value, BACKGROUND_CONTEXT)
    if (!info.ok) return { ok: false, reason: 'offline', detail: info.error.message }
    if (info.value.kind !== 'directory') return { ok: false, reason: 'not_directory', detail: real.value }
    return { ok: true, path: real.value }
  }

  /**
   * 断开所有连接（checkpoint、worker 退出）：远程 runner 随之杀掉还在跑的命令。池子仍可用，resume 之后按需重连；
   * 这次断开不记为离线，否则恢复后的 Reporter 会把一段计划内的停机当成目标掉线。
   */
  close(): void {
    for (const slot of this.slots.values()) {
      if (slot.retry) clearTimeout(slot.retry)
      slot.retry = undefined
      slot.lastUsed = 0
      if (slot.connection) this.retired.add(slot.connection)
      slot.connection?.close()
      slot.link?.close()
      slot.connection = undefined
      slot.link = undefined
    }
  }

  /** 远程路径一律 POSIX；`~` 按 runner 报告的 home 展开，本机的 path 模块在 Windows 上会拼出反斜杠，所以用 posix。 */
  private expand(slot: Slot, value: string): string {
    const home = slot.hello?.home
    if (!home) return value
    if (value === '~') return home
    if (value.startsWith('~/')) return path.posix.join(home, value.slice(2))
    return value
  }

  private async ready(slot: Slot): Promise<RemoteConnection> {
    slot.lastUsed = this.now()
    if (slot.connection && !slot.connection.closed) return slot.connection
    return timeout(this.connect(slot), this.waitMs, `connecting to ${slot.target.name}`)
  }

  private connect(slot: Slot): Promise<RemoteConnection> {
    if (slot.connecting) return slot.connecting
    if (slot.retry) { clearTimeout(slot.retry); slot.retry = undefined }
    const attempt = this.open(slot).then(
      connection => {
        slot.connecting = undefined
        return connection
      },
      error => {
        slot.connecting = undefined
        slot.offlineSince ??= this.now()
        slot.lastError = message(error)
        this.log(`cannot connect to ${slot.target.name}: ${slot.lastError}`)
        this.scheduleRetry(slot)
        throw error
      },
    )
    slot.connecting = attempt
    attempt.catch(() => {})
    return attempt
  }

  private async open(slot: Slot): Promise<RemoteConnection> {
    const { target } = slot
    const link = await this.connector(target)
    const connection = new RemoteConnection(link.input, link.output)
    let hello: Hello
    try {
      hello = await timeout(connection.hello, this.helloTimeoutMs, `starting the runner on ${target.name}`)
    } catch (error) {
      connection.close()
      link.close()
      const detail = link.diagnostics?.().trim()
      throw new Error(detail ? `${message(error)}: ${detail}` : message(error))
    }
    slot.hello = hello
    // 握手之后先看一眼工作目录，确认真的能用再登记为在线（Memoh 的 Stat("/") 探测同理）。
    const probe = new RemoteExecutionEnv({ name: target.name, connection, cwd: hello.home })
    const info = await probe.fileInfo(this.expand(slot, target.workspace), BACKGROUND_CONTEXT)
    if (!info.ok || info.value.kind !== 'directory') {
      connection.close()
      link.close()
      throw new Error(`workspace ${target.workspace} on ${target.name} is not a usable directory${info.ok ? '' : `: ${info.error.message}`}`)
    }
    slot.connection = connection
    slot.link = link
    slot.offlineSince = undefined
    slot.lastError = undefined
    slot.attempt = 0
    connection.onClose(reason => {
      if (slot.connection === connection) {
        slot.connection = undefined
        slot.link = undefined
      }
      link.close()
      if (this.retired.has(connection)) return
      slot.offlineSince ??= this.now()
      slot.lastError = `disconnected: ${reason}${link.diagnostics?.() ? ` (${link.diagnostics().trim()})` : ''}`
      this.log(`${target.name} ${slot.lastError}`)
      this.scheduleRetry(slot)
    })
    this.log(`connected to ${target.name} (${hello.os}/${hello.arch}, node ${hello.node})`)
    return connection
  }

  private scheduleRetry(slot: Slot): void {
    if (slot.retry || slot.connecting) return
    if (this.now() - slot.lastUsed > RETRY_WINDOW_MS) return
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** slot.attempt)
    slot.attempt += 1
    const delay = base * (0.8 + Math.random() * 0.4)
    slot.retry = setTimeout(() => {
      slot.retry = undefined
      void this.connect(slot).catch(() => {})
    }, delay)
    slot.retry.unref?.()
  }
}

const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']
const STDERR_KEEP = 2_000

/**
 * 经 ssh 部署并启动 runner。bundle 按内容哈希命名：远程没有这个文件就推一份，两端永远是同一份代码，不需要版本协商。
 * 远程命令先过对方的登录 shell（可能是 bash、zsh 或 fish），所以只用 `sh -c '…'` 这一种各家都认的写法，里面再交给 sh。
 */
export function sshConnector(options: { runnerFile: string; ssh?: string; log?: (message: string) => void }): Connector {
  const ssh = options.ssh ?? 'ssh'
  let bundle: { content: Buffer; hash: string } | undefined
  const load = () => {
    if (!bundle) {
      const content = readFileSync(options.runnerFile)
      bundle = { content, hash: createHash('sha256').update(content).digest('hex').slice(0, 16) }
    }
    return bundle
  }

  const run = (args: readonly string[], command: string, stdin?: Buffer): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(ssh, [...SSH_OPTIONS, ...args, command], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-STDERR_KEEP) })
    // 文件已在时远程不读 stdin 就退出，写入会 EPIPE；结果以退出码为准。
    child.stdin.on('error', () => {})
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ssh exited with ${code}: ${stderr.trim()}`))))
    child.stdin.end(stdin)
  })

  return async target => {
    // 设置保存时已校验过；这里再拆一次，坏命令按连不上处理。
    const parsed = sshArguments(target.ssh)
    if (!parsed.ok) throw new Error(parsed.error)
    // 我们的选项在前：ssh 对同一选项取第一次出现的值，用户命令里的 BatchMode=no 之类改不掉它们。
    const args = parsed.args
    const { content, hash } = load()
    const file = `$HOME/.amadeus/runner/${hash}.mjs`
    await run(
      args,
      `sh -c 'f="${file}"; [ -f "$f" ] && exit 0; mkdir -p "$HOME/.amadeus/runner" && cat > "$f.$$" && mv "$f.$$" "$f"'`,
      content,
    )
    const child = spawn(ssh, [...SSH_OPTIONS, ...args, `exec sh -lc 'exec ${target.node} "${file}" --stdio'`], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP)
    })
    child.stdin.on('error', () => {})
    // ssh 本身起不来（没装、权限）时只有 error 事件；结束 stdout 让连接按断开处理，而不是让 worker 因未处理的 error 崩掉。
    child.on('error', error => {
      stderr += `\n${error.message}`
      child.stdout.destroy()
    })
    let closed = false
    return {
      input: child.stdout,
      output: child.stdin,
      close() {
        if (closed) return
        closed = true
        child.stdin.end()
        // stdin 关闭后 runner 自己收尾退出；ssh 迟迟不走（网络挂起）才强杀。
        setTimeout(() => child.kill(), 2_000).unref()
      },
      diagnostics: () => stderr.split('\n').filter(Boolean).slice(-3).join(' | '),
    }
  }
}
