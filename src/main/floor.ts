import type { Clock } from './clock.ts'

/** 话筒仲裁（architecture §4.2）：决定"谁在说话、何时开口"，不碰呈现、TTS 与 worker 通信。 */
export type FloorState = 'idle' | 'armed' | 'hearing' | 'responding' | 'settling'

export type PendingReport = { sessionId: string; id: string; title: string; status: string }
type Entry = PendingReport & { busy: number; parked: boolean }

/** 与回合无关的外部闸门，每次评估时现读，Floor 不缓存。 */
export type FloorGates = {
  /** 重载排队或进行中、正在导入角色资源。 */
  blocked: boolean
  sceneReady: boolean
  /** `report_proactive`。 */
  proactive: boolean
  sessionId: string
  /** 当前会话是旧会话（只读）。 */
  readonly: boolean
}

export type FloorHost = {
  clock: Clock
  gates(): FloorGates
  /** 状态由现有的 activeTurn 标志推导，Floor 不另存一份。 */
  turn(): { kind: 'user' | 'report'; piDone: boolean; drained: boolean } | null
  speechStart(): { ok: boolean; error?: string }
  speechStop(): void
  speechFinish(manual: boolean): { ok: boolean; error?: string }
  /** 起汇报回合：宿主建 activeTurn、发 report.deliver，结果用 reportResult 回报。 */
  deliver(report: PendingReport): void
  /** 有重载排队时由宿主自己判断是否空闲、是否执行。 */
  flushReload(): void
}

/** `report.deliver` 的结局（architecture §4.3 应答表），`deferred` 是 closed / worker_exit。 */
export type ReportOutcome = 'started' | 'already' | 'missing' | 'dropped' | 'busy' | 'aborted' | 'deferred'
export type RecognizedVerdict = 'forward' | 'drop' | 'turn'

export const REPORT_DEBOUNCE_MS = 500
export const SETTLE_MS = 1000
export const BUSY_RETRY_MS = 1000
export const BUSY_RETRIES = 5
/** worker 一直回 closed / worker_exit / timeout 而主进程没收到 worker.down 时的重投间隔：逐次翻倍，封顶 30 秒。 */
export const DEFER_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]

type Timer = ReturnType<typeof setTimeout>

export class Floor {
  listeningEnabled = false
  /** 语音识别正在运行（我们启动过且没收到结束信号）。 */
  asrOn = false
  /** 收到过非空 partial，或已请求收尾、在等最终结果。 */
  hearing = false
  composing = false
  workerReady = true
  resumeAt = 0
  private resumeTimer: Timer | null = null
  private debounceTimer: Timer | null = null
  private debounceOk = false
  private retryTimer: Timer | null = null
  // 汇报被 deferred 后整个信箱退避：worker 不可用时换哪条汇报都一样，不能逐条各试一轮。
  private deferTimer: Timer | null = null
  private deferStreak = 0
  private readonly reports: Entry[] = []
  private inFlight: Entry | null = null
  private micResult: { ok: boolean; error?: string } | undefined
  private disposed = false
  private readonly host: FloorHost

  constructor(host: FloorHost) { this.host = host }

  state(): FloorState {
    if (this.busy()) return 'responding'
    if (this.asrOn) return this.hearing ? 'hearing' : 'armed'
    return this.host.clock.now() < this.resumeAt ? 'settling' : 'idle'
  }

  /** 有回合在进行，直到模型结束且播放排空。 */
  busy(): boolean {
    const turn = this.host.turn()
    return !!turn && (!turn.piDone || !turn.drained)
  }

  pendingCount(sessionId: string): number {
    return this.reports.filter(item => item.sessionId === sessionId).length
  }

  // ---- 麦克风意图 ----

  /** 转移 1。闸门未过就只记意图，解除后由 pump 补开；返回开麦的结果供界面报错。 */
  asrStart(): { ok: boolean; error?: string } {
    this.listeningEnabled = true
    this.micResult = undefined
    this.pump()
    return this.micResult ?? { ok: true }
  }

  /** 转移 6。收尾还要等最终结果，期间仍算 hearing。 */
  asrStop(): { ok: boolean; error?: string } {
    this.listeningEnabled = false
    this.cancelResume()
    this.resetDebounce()
    const result = this.host.speechFinish(true)
    if (this.asrOn) this.hearing = true
    return result
  }

  /** 转移 2、3、4：partial 进入 hearing；最终结果按闸门决定是否起用户回合。 */
  recognized(text: string, isFinal: boolean, manual: boolean): RecognizedVerdict {
    if (!isFinal) {
      if (this.asrOn && text.trim()) { this.hearing = true; this.resetDebounce() }
      return 'forward'
    }
    this.asrOn = false
    this.hearing = false
    this.resetDebounce()
    const gates = this.host.gates()
    if (gates.blocked || this.busy()) return 'drop'
    if (manual) { this.listeningEnabled = false; return 'forward' }
    if (!this.listeningEnabled || gates.readonly || !text.trim()) return 'drop'
    return 'turn'
  }

  /** 转移 5：报错、no-speech、30 秒无转写都关掉监听意图；idle 即识别结束。 */
  status(status: string, reason?: string): void {
    if (status === 'listening') { this.asrOn = true; return }
    if (status === 'processing') return
    this.asrOn = false
    this.hearing = false
    this.resetDebounce()
    if (status === 'error' || (status === 'idle' && reason === 'no-speech')) {
      this.listeningEnabled = false
      this.cancelResume()
    }
    // 识别结束后因为"在听"而等着的汇报可以开口了；普通 idle 不重开麦，免得识别器反复秒退时空转。
    this.pump(false)
  }

  /** 关掉识别但保留 `listeningEnabled`（起回合、重载前）。 */
  stopMic(): void {
    this.host.speechStop()
    this.asrOn = false
    this.hearing = false
    this.resetDebounce()
  }

  // ---- 回合边界 ----

  /** 转移 7、8 的 Floor 部分：用户输入抢占一切，草稿随之清零。 */
  preempt(): void {
    this.composing = false
    this.cancelResume()
    this.stopMic()
  }

  /** 转移 10：窗口关闭，不再有人听。 */
  windowClosed(): void {
    this.listeningEnabled = false
    this.composing = false
    this.cancelResume()
    this.stopMic()
  }

  /** 转移 23：场景丢失；重载期间保留监听意图，握手后补开。 */
  sceneLost(reloading: boolean): void {
    if (!reloading) this.listeningEnabled = false
    this.cancelResume()
    this.stopMic()
    this.pump()
  }

  /** 转移 12：播放正常结束后留一秒缓冲，避免麦克风收到自己的回声。 */
  playbackEnded(): void { this.resumeAt = this.host.clock.now() + SETTLE_MS }

  // ---- 汇报信箱 ----

  /** 转移 17~19：新增的 pending 汇报。重复的（重放、重启）忽略。 */
  reportReady(report: PendingReport): void {
    if (this.reports.some(item => item.sessionId === report.sessionId && item.id === report.id)) return
    this.reports.push({ ...report, busy: 0, parked: false })
    this.pump()
  }

  /** 转移 20、21。 */
  reportResult(report: PendingReport, outcome: ReportOutcome): void {
    const entry = this.reports.find(item => item.sessionId === report.sessionId && item.id === report.id)
    if (this.inFlight === entry) this.inFlight = null
    // 除 deferred 外，任何应答都说明 worker 在回话，退避从头算。
    if (outcome !== 'deferred') this.deferStreak = 0
    if (!entry) return
    if (outcome === 'deferred') {
      // 条目原样保留，只是在退避期内不重投；外部事件（wake）和计时器都能提前 / 按时解除。
      this.cancelDefer()
      const delay = DEFER_BACKOFF_MS[Math.min(++this.deferStreak, DEFER_BACKOFF_MS.length) - 1]
      this.deferTimer = this.host.clock.setTimeout(() => { this.deferTimer = null; this.pump() }, delay)
    } else if (outcome === 'busy') {
      // 拒绝时什么都没写入，原样重投；重试用尽就搁置，等下一次外部事件再来，不然会原地空转。
      if (entry.busy < BUSY_RETRIES) {
        entry.busy++
        this.retryTimer = this.host.clock.setTimeout(() => { this.retryTimer = null; this.pump() }, BUSY_RETRY_MS)
      } else { entry.busy = 0; entry.parked = true }
    } else if (outcome === 'started' || outcome === 'already' || outcome === 'missing' || outcome === 'dropped') {
      this.reports.splice(this.reports.indexOf(entry), 1)
    }
  }

  /** 会话被删除：它的汇报不会再有人听。 */
  dropSession(sessionId: string): void {
    for (let index = this.reports.length - 1; index >= 0; index--) {
      if (this.reports[index].sessionId !== sessionId) continue
      if (this.inFlight === this.reports[index]) this.inFlight = null
      this.reports.splice(index, 1)
    }
  }

  /** worker 重启：待投递缓存由重放重建，进行中的投递随命令一起作废。 */
  workerDown(): void {
    this.workerReady = false
    this.inFlight = null
    this.cancelRetry()
    this.cancelDefer()
    this.deferStreak = 0
    this.resetDebounce()
  }

  workerUp(): void {
    this.workerReady = true
    this.reports.length = 0
    this.inFlight = null
    this.cancelRetry()
    this.cancelDefer()
    this.deferStreak = 0
    this.wake()
  }

  setComposing(active: boolean): void {
    const was = this.composing
    this.composing = active
    if (active) this.resetDebounce()
    else if (was) this.wake()
  }

  // ---- 调度 ----

  /** 外部事件（闸门解除、切会话、设置变化）：搁置的汇报重新有资格投递。 */
  wake(): void {
    // 退避计时器也让位：事件已经表明形势变了，值得再试一次；再失败则退避更久（streak 不清零）。
    this.cancelDefer()
    for (const item of this.reports) item.parked = false
    this.pump()
  }

  /** 优先级：重载 > 汇报 > 开麦（§4.2）。`mic: false` 只处理重载与汇报。 */
  pump(mic = true): void {
    if (this.disposed) return
    this.cancelResume()
    if (this.state() !== 'hearing') this.host.flushReload()
    const gates = this.host.gates()
    if (gates.blocked || this.busy()) return
    const remaining = this.resumeAt - this.host.clock.now()
    if (remaining > 0) {
      // 转移 16：缓冲期内既不插话也不开麦，到期再来。
      if (this.listeningEnabled || this.nextReport(gates)) this.resumeTimer = this.host.clock.setTimeout(() => { this.resumeTimer = null; this.pump() }, remaining)
      return
    }
    if (this.tryReport(gates)) return
    if (mic) this.tryMic(gates)
  }

  dispose(): void {
    this.disposed = true
    this.cancelResume()
    this.cancelRetry()
    this.cancelDefer()
    this.resetDebounce()
  }

  private nextReport(gates: FloorGates): Entry | undefined {
    if (!this.workerReady || !gates.sceneReady || !gates.proactive || gates.readonly || this.composing) return undefined
    if (this.inFlight || this.retryTimer !== null || this.deferTimer !== null) return undefined
    return this.reports.find(item => item.sessionId === gates.sessionId && !item.parked)
  }

  private tryReport(gates: FloorGates): boolean {
    const entry = this.nextReport(gates)
    const state = this.state()
    if (!entry || state === 'hearing') { this.resetDebounce(); return false }
    if (state === 'armed' && !this.debounceOk) {
      // 转移 18：麦开着但没人说话，等 500ms 确认真的没人开口再抢占。
      if (this.debounceTimer === null) {
        this.debounceTimer = this.host.clock.setTimeout(() => {
          this.debounceTimer = null
          if (this.state() !== 'armed') return
          this.debounceOk = true
          this.pump()
        }, REPORT_DEBOUNCE_MS)
      }
      return false
    }
    this.resetDebounce()
    this.stopMic()
    this.inFlight = entry
    this.host.deliver({ sessionId: entry.sessionId, id: entry.id, title: entry.title, status: entry.status })
    return true
  }

  private tryMic(gates: FloorGates): void {
    if (!this.listeningEnabled || !gates.sceneReady || !this.workerReady || this.asrOn) return
    const result = this.host.speechStart()
    this.micResult = result
    if (result.ok) { this.asrOn = true; this.hearing = false } else this.listeningEnabled = false
  }

  private resetDebounce(): void {
    if (this.debounceTimer !== null) this.host.clock.clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    this.debounceOk = false
  }

  private cancelResume(): void {
    if (this.resumeTimer !== null) this.host.clock.clearTimeout(this.resumeTimer)
    this.resumeTimer = null
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.host.clock.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private cancelDefer(): void {
    if (this.deferTimer !== null) this.host.clock.clearTimeout(this.deferTimer)
    this.deferTimer = null
  }
}
