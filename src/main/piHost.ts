import { randomUUID } from 'node:crypto'
import type { UtilityProcess } from 'electron'
import { systemClock, type Clock } from './clock.ts'

type Json = Record<string, unknown>
type Timer = ReturnType<typeof setTimeout>
type TurnKind = 'user' | 'report'

/** 保留 worker 回的 `code`（architecture §7.4）；超时、进程退出等本地失败用同一组码。 */
export class PiError extends Error {
  readonly code: string
  constructor(message: string, code = 'failed') {
    super(message)
    this.code = code
  }
}

const DEFAULT_TIMEOUT_MS = 60_000
const COMMAND_TIMEOUTS: Record<string, number> = {
  'chat.submit': 15_000,
  'report.deliver': 15_000,
  'session.delete': 30_000,
  checkpoint: 30_000,
  'model.list': 20_000,
  'model.set': 20_000,
  'task.all': 15_000,
  'task.trace': 20_000,
}
const STARTUP_TIMEOUT_MS = 20_000
const RESPAWN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]
const MAX_RESPAWN_FAILURES = 5
const STABLE_AFTER_MS = 60_000
// 旧进程被杀后迟迟没有 exit 时不能无限等；新 worker 的进程锁（§2.2）是最后一道保险。
const EXIT_WAIT_MS = 10_000
const TURN_END_EVENTS = new Set(['turn.done', 'turn.error', 'turn.aborted'])

type Pending = {
  owner: UtilityProcess
  command: string
  turnId?: string
  resolve: (value: Json) => void
  reject: (error: Error) => void
}

/**
 * pi-worker 的命令通道。除 worker 自己的事件外，还会合成 `worker.ready` / `worker.down`，
 * 并为意外退出时仍在进行的回合补一条 `turn.error(worker_exit)`，让上层只需处理一种终止信号。
 */
export class PiHost {
  private readonly fork: () => UtilityProcess
  private readonly clock: Clock
  private process: UtilityProcess | null = null
  private starting: Promise<UtilityProcess> | null = null
  private restarting: Promise<void> | null = null
  private disposed = false
  private readonly failures = new WeakMap<UtilityProcess, Error>()
  private readonly exits = new WeakMap<UtilityProcess, Promise<void>>()
  private readonly children = new Set<UtilityProcess>()
  private readonly pending = new Map<string, Pending>()
  // 回合已受理但还没收到终止事件：进程死掉时只有这些需要合成 turn.error，在途命令由命令自己的拒绝处理。
  private readonly turns = new Map<string, { owner: UtilityProcess; sessionId: string; kind: TurnKind; acked: boolean }>()
  private readonly onEvent: (message: Json) => void
  private respawnTimer: Timer | null = null
  private stableTimer: Timer | null = null
  private failureStreak = 0
  private gaveUp = false
  error = ''

  constructor(fork: () => UtilityProcess, onEvent: (message: Json) => void = () => {}, options: { clock?: Clock } = {}) {
    this.fork = fork
    this.onEvent = onEvent
    this.clock = options.clock ?? systemClock
  }

  async init(): Promise<void> {
    try { await this.ensureStarted() } catch (error) {
      this.error = String(error)
      this.noteFailure()
    }
  }

  private spawnReady(): Promise<UtilityProcess> {
    const child = this.fork()
    this.children.add(child)
    let exited!: () => void
    this.exits.set(child, new Promise<void>(resolve => { exited = resolve }))
    return new Promise((resolve, reject) => {
      let ready = false
      const fail = (error: Error) => {
        if (this.failures.has(child)) return
        this.failures.set(child, error)
        this.clock.clearTimeout(timer)
        if (!ready) reject(error)
        const wasCurrent = this.process === child
        if (wasCurrent) { this.process = null; this.error = error.message }
        const lost = [...this.turns].filter(([, turn]) => turn.owner === child)
        for (const [turnId] of lost) this.turns.delete(turnId)
        for (const [id, pending] of this.pending) {
          if (pending.owner !== child) continue
          this.pending.delete(id)
          pending.reject(new PiError(error.message, 'worker_exit'))
        }
        if (!wasCurrent) return
        this.clearStable()
        // 先宣布 worker 倒下，让上层的闸门先关上，再逐个收尾被打断的回合；
        // 命令还在途的回合由该命令的拒绝处理，这里只补已受理的。
        this.dispatch({ type: 'event', name: 'worker.down', error: error.message })
        for (const [turnId, turn] of lost) {
          if (turn.acked) this.dispatch({ type: 'event', name: 'turn.error', sessionId: turn.sessionId, turnId, kind: turn.kind, code: 'worker_exit', error: error.message })
        }
        this.noteFailure()
      }
      const timer = this.clock.setTimeout(() => { fail(new Error('Pi startup timed out')); child.kill() }, STARTUP_TIMEOUT_MS)
      child.on('message', (message: Json) => {
        if (message?.type === 'ready') {
          if (ready || this.failures.has(child)) return
          this.clock.clearTimeout(timer)
          if (message.error) { fail(new Error(String(message.error))); child.kill(); return }
          ready = true
          resolve(child)
          return
        }
        // 只认当前进程的事件；替换中的旧进程发来的作废。
        if (message?.type === 'event') { if (this.process === child) this.dispatch(message); return }
        const id = String(message?.id || '')
        const pending = this.pending.get(id)
        if (!pending || pending.owner !== child) return
        const type = String(message.type)
        if (!['done', 'error', 'aborted'].includes(type)) return
        this.pending.delete(id)
        this.settleTurn(pending, message)
        if (type === 'error') pending.reject(new PiError(String(message.error || 'Pi request failed'), String(message.code || 'failed')))
        else pending.resolve(message)
      })
      child.on('exit', code => { this.children.delete(child); fail(new Error(`Pi utility process exited (${code})`)); exited() })
      child.on('error', type => { fail(new Error(`Pi utility process error: ${type}`)); child.kill() })
    })
  }

  private dispatch(message: Json): void {
    if (TURN_END_EVENTS.has(String(message.name))) this.turns.delete(String(message.turnId || ''))
    try { this.onEvent(message) } catch (error) { console.error('[amadeus-next] Pi event handler failed', error) }
  }

  private settleTurn(pending: Pending, reply: Json): void {
    if (!pending.turnId) return
    const turn = this.turns.get(pending.turnId)
    if (!turn) return
    const started = reply.type === 'done' && (pending.command === 'chat.submit' || (reply.status ?? 'started') === 'started')
    if (started) turn.acked = true
    else this.turns.delete(pending.turnId)
  }

  private adopt(child: UtilityProcess): void {
    this.process = child
    this.error = ''
    this.clearStable()
    this.stableTimer = this.clock.setTimeout(() => { this.stableTimer = null; this.failureStreak = 0 }, STABLE_AFTER_MS)
    console.info(`[amadeus-next] Pi runtime ready: ${child.pid ?? 'unknown'}`)
    this.dispatch({ type: 'event', name: 'worker.ready' })
  }

  private clearStable(): void {
    if (this.stableTimer !== null) this.clock.clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  /** 退避重拉（§2.2）：连续失败 5 次后停止，保留 `error`，等下一条命令触发惰性重拉。 */
  private noteFailure(): void {
    // 计划内重启期间旧进程退出是预期的，restart() 自己负责善后。
    if (this.disposed || this.restarting || this.respawnTimer !== null) return
    this.failureStreak++
    if (this.failureStreak > MAX_RESPAWN_FAILURES) { this.gaveUp = true; return }
    const delay = RESPAWN_BACKOFF_MS[Math.min(this.failureStreak, RESPAWN_BACKOFF_MS.length) - 1]
    this.respawnTimer = this.clock.setTimeout(() => {
      this.respawnTimer = null
      if (this.disposed) return
      this.ensureStarted().catch(error => { this.error = String(error); this.noteFailure() })
    }, delay)
  }

  private async ensureStarted(): Promise<UtilityProcess> {
    if (this.disposed) throw new Error('Pi host is closed')
    if (this.restarting) await this.restarting
    if (this.process) return this.process
    if (!this.starting) {
      this.starting = this.spawnReady().then(child => {
        const failure = this.failures.get(child)
        if (failure) throw failure
        if (this.disposed) { child.kill(); throw new Error('Pi host is closed') }
        this.adopt(child)
        return child
      }).finally(() => { this.starting = null })
    }
    return this.starting
  }

  private command(child: UtilityProcess, command: string, params: Json = {}, timeout = COMMAND_TIMEOUTS[command] ?? DEFAULT_TIMEOUT_MS): Promise<Json> {
    const failure = this.failures.get(child)
    if (failure) return Promise.reject(new PiError(failure.message, 'worker_exit'))
    const id = randomUUID()
    const turnId = (command === 'chat.submit' || command === 'report.deliver') && typeof params.turnId === 'string' ? params.turnId : undefined
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id)
        if (turnId) this.turns.delete(turnId)
        reject(new PiError(`Pi ${command} timed out`, 'timeout'))
      }, timeout)
      this.pending.set(id, {
        owner: child, command, turnId,
        resolve: value => { this.clock.clearTimeout(timer); resolve(value) },
        reject: error => { this.clock.clearTimeout(timer); reject(error) },
      })
      if (turnId) this.turns.set(turnId, { owner: child, sessionId: String(params.sessionId || ''), kind: command === 'chat.submit' ? 'user' : 'report', acked: false })
      // 参数嵌套在 params 里：report.deliver 与 memory.* 的参数本身有 id，平铺会被封包的 id 覆盖。
      try { child.postMessage({ id, command, params }) } catch (error) {
        this.pending.delete(id)
        if (turnId) this.turns.delete(turnId)
        this.clock.clearTimeout(timer)
        reject(error)
      }
    })
  }

  /** 应答类型 `aborted`（排队中的 chat.submit / report.deliver 被撤回）原样带回，调用方看 `type`。 */
  async request(command: string, params: Json = {}): Promise<Json> {
    if (this.gaveUp && !this.process) { this.gaveUp = false; this.failureStreak = 0 }
    return this.command(await this.ensureStarted(), command, params)
  }

  /** 打断不该为了取消而拉起 worker：没有进程就没有要取消的东西。 */
  async abort(sessionId: string): Promise<void> {
    if (this.process) await this.command(this.process, 'chat.abort', { sessionId })
  }

  restart(): Promise<void> {
    if (this.restarting) return this.restarting
    this.restarting = (async () => {
      if (this.disposed) throw new Error('Pi host is closed')
      if (this.starting) await this.starting.catch(() => {})
      const previous = this.process
      if (previous) {
        try { await this.command(previous, 'checkpoint') } catch {
          // checkpoint 没有确认就不能保证旧进程已放开存储：杀掉它并等它真的退出，再拉新的（等同崩溃恢复）。
          await this.retire(previous)
        }
      }
      let replacement: UtilityProcess
      try {
        replacement = await this.spawnReady()
        const failure = this.failures.get(replacement)
        if (failure) throw failure
      } catch (error) {
        // checkpoint 已让旧进程关库放锁；替换失败时要让它重新接管，否则两边都不可用。
        if (previous && this.process === previous && !this.failures.has(previous)) {
          // 接管也失败的旧进程留着只会一直回 closed：当作崩溃处理，让上层看到 worker.down，再由退避重拉兜底。
          await this.command(previous, 'resume').catch(() => this.retire(previous))
        }
        if (!this.process) this.error = String(error)
        throw error
      }
      if (this.disposed) { replacement.kill(); throw new Error('Pi host is closed') }
      this.adopt(replacement)
      for (const [turnId, turn] of this.turns) if (turn.owner === previous) this.turns.delete(turnId)
      previous?.kill()
    })().finally(() => {
      this.restarting = null
      // 旧进程已死、替换又没起来：没人会再触发重拉，交给退避重拉兜底。
      if (!this.process && !this.disposed) this.noteFailure()
    })
    return this.restarting
  }

  /** 杀掉进程并等它退出，让它的锁真正放开；退出事件会走 fail()，发 worker.down 并清掉在途命令。 */
  private async retire(child: UtilityProcess): Promise<void> {
    child.kill()
    let giveUp: Timer | undefined
    await Promise.race([this.exits.get(child), new Promise<void>(resolve => { giveUp = this.clock.setTimeout(resolve, EXIT_WAIT_MS) })])
    this.clock.clearTimeout(giveUp)
    if (this.process !== child) return
    // 迟迟没有退出事件：不能让上层继续以为它还活着。
    this.process = null
    this.dispatch({ type: 'event', name: 'worker.down', error: 'Pi utility process did not exit' })
  }

  dispose(): void {
    this.disposed = true
    if (this.respawnTimer !== null) this.clock.clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    this.clearStable()
    for (const child of this.children) child.kill()
    this.children.clear()
    this.process = null
    this.turns.clear()
    for (const pending of this.pending.values()) pending.reject(new PiError('Pi host is closed', 'closed'))
    this.pending.clear()
  }
}
