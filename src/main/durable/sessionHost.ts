import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import {
  ConversationBusy,
  Harness,
  ROOT_CONVERSATION_ID,
  StorageRejected,
  type Conversation,
  type ConversationId,
  type Extension,
  type HarnessSettings,
  type Registry,
  type Storage,
  type Tx,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { EventBridge, type SettledTurn } from './eventBridge.ts'
import { countUserTurns } from './history.ts'
import { CommandError } from './lanes.ts'
import { resolveSelection } from './modelSelection.ts'
import { SESSION_ID, SessionDoc, summarize, type SessionEntry, type SessionIndex } from './sessionIndex.ts'
import {
  ANCHOR_TASK_NAME,
  ApprovalsDoc,
  HandoffsDoc,
  OutboxDoc,
  REPORTER_TASK_NAME,
  cleanLostHandoffs,
  expireApprovalsOnOpen,
  initHandoffDocs,
  reconcileHandoffs,
  summaryOf,
  watchApprovals,
  type Handoffs,
  type Outbox,
  type TaskSummary,
} from './handoff/index.ts'
import type { MemoryService } from './memory/index.ts'

type Json = Record<string, unknown>

const ctx = BACKGROUND_CONTEXT
const DELETE_ABORT_MS = 10_000

export type OpenSession = {
  id: string
  harness: Harness
  root: Conversation
  bridge: EventBridge
  /** 关闭时按序停掉的监视；事件桥单独管。 */
  stops: Array<() => Promise<unknown>>
  /** 已发过 task.report-ready 的汇报 id，避免文档每次变化都重复通知。 */
  announced: Set<string>
  /** task.graph：上一次推给界面的任务列表（键），其中去掉 progress 的形状，以及最近一次读到的列表（节流的尾沿推它）。 */
  graph: string
  graphShape: string
  graphLatest: TaskSummary[]
  graphProgressAt: number
  graphTimer: ReturnType<typeof setTimeout> | undefined
  /** 主人发言次数，记忆重新冻结按它触发；打开时数一次，之后在内存里累加。 */
  turns: number
  lastUsed: number
  refreshing: Promise<void>
  /** 清理器的串行链；`cleaningQueued` 为真表示已有一次排在后面、尚未开始，新的触发不必再排。 */
  cleaning: Promise<void>
  cleaningQueued: boolean
}

type Slot = { state: 'opening' | 'open' | 'closing'; promise: Promise<unknown>; open?: OpenSession }

export type HostDeps = {
  sessionsDir: string
  agentDir: string
  models: Models
  registry: Registry
  settings: HarnessSettings
  index: SessionIndex
  /** 主对话固定的扩展选择；记忆服务重建后会变，所以每次打开时现取。 */
  agentExtensions: () => readonly Extension[]
  openStorage: (file: string) => Promise<Storage>
  post: (message: Json) => void
  memory: () => MemoryService | undefined
  idleCloseMs: number
  maxOpen: number
  /** report_progress 推送到界面的最小间隔（handoff limits.progressIntervalMs）。 */
  progressIntervalMs: number
  now: () => number
  log: (message: string, error?: unknown) => void
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref?.())

const shapeOf = (tasks: readonly TaskSummary[]): string => JSON.stringify(tasks.map(({ progress: _progress, ...rest }) => rest))

export const isPoisoned = (error: unknown): boolean => error instanceof Error && /poisoned/i.test(error.message)

/**
 * 一会话一个 Harness 的打开 / 关闭 / 删除 / 回收 / 中毒恢复（architecture §2.2）。
 * 状态：closed → opening → open → closing → closed；同一会话并发的打开共用一个 promise，closing 期间到达的打开等关闭完成后重来。
 */
export class SessionHost {
  private readonly deps: HostDeps
  private readonly slots = new Map<string, Slot>()
  /** checkpoint 之后为 false：后台预热等不经命令道的打开不能把库又打开。 */
  accepting = true

  constructor(deps: HostDeps) { this.deps = deps }

  directory(id: string): string {
    if (!SESSION_ID.test(id)) throw new CommandError('invalid', 'Invalid session id')
    return path.join(this.deps.sessionsDir, id)
  }

  peek(id: string): OpenSession | undefined {
    const slot = this.slots.get(id)
    return slot?.state === 'open' ? slot.open : undefined
  }

  openIds(): string[] { return [...this.slots.entries()].filter(([, slot]) => slot.state === 'open').map(([id]) => id) }

  all(): OpenSession[] { return this.openIds().flatMap(id => this.peek(id) ?? []) }

  emit(id: string, name: string, payload: Json = {}): void {
    // 封包字段放后面：载荷里的同名字段不能盖掉事件名和会话 id。
    this.deps.post({ ...payload, type: 'event', name, sessionId: id })
  }

  async open(id: string): Promise<OpenSession> {
    this.directory(id)
    if (!this.accepting) throw new CommandError('closed', 'Pi runtime is checkpointed; resume or restart it first')
    for (;;) {
      const slot = this.slots.get(id)
      if (!slot) break
      if (slot.state === 'open') { slot.open!.lastUsed = this.deps.now(); return slot.open! }
      if (slot.state === 'opening') return slot.promise as Promise<OpenSession>
      await slot.promise.catch(() => {})
    }
    const slot: Slot = { state: 'opening', promise: Promise.resolve() }
    slot.promise = this.evict().then(() => this.openFresh(id)).then(
      open => { slot.state = 'open'; slot.open = open; return open },
      error => { if (this.slots.get(id) === slot) this.slots.delete(id); throw error },
    )
    this.slots.set(id, slot)
    return slot.promise as Promise<OpenSession>
  }

  /** worker ready 之后在后台打开当前会话和 hasActive 的会话，让后台任务与汇报重放尽早恢复。 */
  async warm(): Promise<void> {
    const { index } = this.deps
    const wanted = [index.currentId, ...index.all().filter(entry => entry.hasActive).map(entry => entry.id)]
    for (const id of new Set(wanted)) {
      const entry = index.get(id)
      if (!entry || entry.empty || !this.accepting) continue
      await this.open(id).catch(error => this.deps.log(`background open of ${id} failed`, error))
    }
  }

  private async openFresh(id: string): Promise<OpenSession> {
    const { index, models, agentDir } = this.deps
    const entry = index.get(id)
    if (!entry) throw new CommandError('not_found', 'Session not found')
    const directory = this.directory(id)
    // 先建目录再开库：空会话在这一刻才真正落地（懒创建）。
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const storage = await this.deps.openStorage(path.join(directory, 'durable.sqlite'))
    let harness: Harness
    try {
      harness = await Harness.open(storage, {
        models,
        registry: this.deps.registry,
        settings: this.deps.settings,
        env: ({ cwd }) => cwd ? new NodeExecutionEnv({ cwd }) : undefined,
        onReport: error => this.report(id, error),
      }, ctx)
    } catch (error) {
      await storage.close(ctx).catch(() => {})
      throw error
    }

    const taskRoot = path.join(directory, 'handoff')
    const ensure = async (tx: Tx, rootId: ConversationId) => {
      await initHandoffDocs(tx, rootId, { taskRoot })
      const session = await tx.doc(SessionDoc)
      if (!session.createdAt) { session.title = entry.title; session.createdAt = entry.createdAt }
    }
    let bridge: EventBridge | undefined
    const stops: OpenSession['stops'] = []
    try {
      const selection = await resolveSelection(models, agentDir)
      const root = await harness.root(ctx, {
        agent: {
          extensions: this.deps.agentExtensions(),
          ...(selection ? { model: selection.ref, thinkingLevel: selection.thinkingLevel } : {}),
        },
        init: (tx, rootId) => ensure(tx, rootId),
      })
      // root() 对已有根对话不会再跑 init；旧库缺的文档在这里补建（幂等）。
      await root.commit(tx => ensure(tx, root.id), ctx)
      if (entry.empty) index.update(id, { empty: false }, true)

      // 桥的回调在 attach 返回前就可能触发（遗留 run 被中止时），所以会话对象先完整建好，桥稍后补上。
      const session: OpenSession = {
        id, harness, root, bridge: undefined as unknown as EventBridge, stops, announced: new Set<string>(),
        graph: '', graphShape: '', graphLatest: [], graphProgressAt: 0, graphTimer: undefined,
        turns: 0, lastUsed: this.deps.now(), refreshing: Promise.resolve(), cleaning: Promise.resolve(), cleaningQueued: false,
      }
      const attached = await EventBridge.attach(harness, root.id, {
        emit: (name, payload) => this.emit(id, name, payload),
        onSettled: turn => this.settled(session, turn),
        onReportPlaced: (requestId, placed) => void this.fillEntry(session, requestId, placed),
        onRunEnd: mapped => { if (!mapped) { this.touch(id); void this.refresh(session) } },
        // Reporter / Anchor faulted 后调度器只写任务终态，条目会停在 queued / running 并占住名额（pi-tool-constraints §3.4）。
        onTaskFailed: task => { if (task.kind === REPORTER_TASK_NAME || task.kind === ANCHOR_TASK_NAME) void this.cleanLost(session) },
        report: error => this.report(id, error),
      })
      bridge = session.bridge = attached.bridge
      // 打开时序 4~7：挂桥但不调度 → 对账（此时没有任何任务在跑）→ 中止遗留 run → resume。
      // 文档把遗留 run 的 abort 排在对账之前，但 Conversation.abort() 内部会启动调度器（harness.js:66），
      // 对账里作废待确认的前提是没有工具任务在跑，所以遗留 run 的 abort 必须放在对账之后。
      const voided = await this.pendingApprovals(harness, root.id)
      await reconcileHandoffs(harness, root, ctx)
      await expireApprovalsOnOpen(harness, root, ctx)
      // 作废发生在监视挂上之前，watchApprovals 看不到这次状态变化；主进程只会清自己的缓存，界面上的旧卡片要靠这个事件收起。
      for (const approval of voided) this.emit(id, 'task.approval-resolved', { ...approval, state: 'expired' })
      if (attached.hasRun) await root.abort(ctx)
      harness.resume()

      const outbox = await harness.snapshot(OutboxDoc, root.id, ctx)
      session.turns = await countUserTurns(root, outbox?.delivered ?? {})
      await this.watch(session)
      void this.refresh(session)
      return session
    } catch (error) {
      await Promise.allSettled(stops.map(stop => stop()))
      await bridge?.stop().catch(() => {})
      await harness.close(ctx).catch(() => {})
      throw error
    }
  }

  /** 未终态委托里现存的 pending 确认；对账会把它们全部作废。 */
  private async pendingApprovals(harness: Harness, rootId: ConversationId): Promise<Array<{ taskId: string; approvalId: string }>> {
    const handoffs = await harness.snapshot(HandoffsDoc, rootId, ctx)
    const found: Array<{ taskId: string; approvalId: string }> = []
    for (const item of handoffs?.items ?? []) {
      if (item.status !== 'queued' && item.status !== 'running') continue
      const approvals = await harness.snapshot(ApprovalsDoc, item.child as ConversationId, ctx)
      for (const [approvalId, approval] of Object.entries(approvals?.items ?? {})) if (approval.state === 'pending') found.push({ taskId: item.taskId, approvalId })
    }
    return found
  }

  /** 汇报信箱、任务卡片与待确认的监视。watchDoc 的初值只是打开时的现值，不回放历史，所以现存的 pending 在这里逐条重放。 */
  private async watch(open: OpenSession): Promise<void> {
    const { harness, root } = open
    const soft = async (name: string, attach: () => Promise<void>) => {
      try { await attach() } catch (error) { this.deps.log(`${name} watch of ${open.id} failed`, error) }
    }
    await soft('outbox', async () => {
      const watch = await harness.watchDoc(OutboxDoc, root.id, ctx)
      if (!watch) return
      open.stops.push(() => watch.stop())
      await this.outbox(open, watch.value as Outbox | null)
      watch.start(async value => { await this.outbox(open, value as Outbox | null) })
    })
    await soft('handoffs', async () => {
      const watch = await harness.watchDoc(HandoffsDoc, root.id, ctx)
      if (!watch) return
      open.stops.push(() => watch.stop())
      this.graph(open, watch.value as Handoffs | null, false)
      watch.start(async value => { this.graph(open, value as Handoffs | null, true); void this.refresh(open) })
    })
    await soft('approvals', async () => {
      const stop = await watchApprovals(harness, root, ctx, {
        request: approval => this.emit(open.id, 'task.approval-request', approval),
        resolved: approval => this.emit(open.id, 'task.approval-resolved', approval),
      })
      open.stops.push(stop)
    })
  }

  private async outbox(open: OpenSession, value: Outbox | null): Promise<void> {
    try {
      const pending = value?.pending ?? []
      const fresh = pending.filter(item => !open.announced.has(item.id))
      if (fresh.length > 0) {
        const handoffs = await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)
        for (const item of fresh) {
          open.announced.add(item.id)
          const title = handoffs?.items.find(each => each.taskId === item.taskId)?.title ?? ''
          this.emit(open.id, 'task.report-ready', { id: item.id, title, status: item.status, round: item.round ?? 1 })
        }
      }
      this.patch(open.id, { pendingReports: pending.length })
    } catch (error) { this.report(open.id, error) }
  }

  /**
   * 任务列表推给界面。状态、轮次、问题的变化立即推；只有 progress 变了（子代理的 report_progress）按 progressIntervalMs 节流：
   * 间隔内的多次变化合并，间隔结束时推最新的一条。条目本身总是最新的，session.load 与 handoff_status 读到的不受节流影响。
   */
  private graph(open: OpenSession, value: Handoffs | null, announce: boolean): void {
    const tasks = (value?.items ?? []).map(summaryOf)
    open.graphLatest = tasks
    if (!announce) {
      open.graph = JSON.stringify(tasks)
      open.graphShape = shapeOf(tasks)
      return
    }
    if (shapeOf(tasks) !== open.graphShape) return this.flushGraph(open, false)
    if (JSON.stringify(tasks) === open.graph) return
    const wait = open.graphProgressAt + this.deps.progressIntervalMs - this.deps.now()
    if (wait <= 0) return this.flushGraph(open, true)
    if (open.graphTimer) return
    open.graphTimer = setTimeout(() => {
      open.graphTimer = undefined
      if (this.peek(open.id) === open) this.flushGraph(open, true)
    }, wait)
    open.graphTimer.unref?.()
  }

  private flushGraph(open: OpenSession, progressOnly: boolean): void {
    if (open.graphTimer) clearTimeout(open.graphTimer)
    open.graphTimer = undefined
    const tasks = open.graphLatest
    const key = JSON.stringify(tasks)
    if (key === open.graph) return
    open.graph = key
    open.graphShape = shapeOf(tasks)
    if (progressOnly) open.graphProgressAt = this.deps.now()
    this.emit(open.id, 'task.graph', { tasks })
  }

  /** 回合落定：刷新索引，并对用户回合触发回合后抽取（汇报回合跳过，architecture §4.4）。 */
  private settled(open: OpenSession, turn: SettledTurn): void {
    this.touch(open.id)
    void this.refresh(open)
    if (turn.kind !== 'user') return
    const memory = this.deps.memory()
    if (!memory) return
    // 在事件批的处理里不能等它：抽取只是后台增强，失败不影响对话。
    void memory.afterTurn(open.harness, open.root, ctx, { sessionId: open.id }).catch(error => this.deps.log('memory.afterTurn failed', error))
  }

  /** 汇报输入入队时 entryId 为空；事件桥看到 placed 后补写（architecture §4.3）。 */
  async fillEntry(open: OpenSession, requestId: string, entry: number): Promise<void> {
    const outboxId = requestId.slice('report:'.length)
    try {
      await open.root.commit(async tx => {
        const outbox = await tx.doc(OutboxDoc, open.root.id)
        const delivered = outbox.delivered[outboxId]
        if (delivered && delivered.entryId === null) delivered.entryId = entry
      }, ctx)
    } catch (error) { this.report(open.id, error) }
  }

  /** 打开会话、回合落定、任务图变化时按库里的事实校正索引：hasActive 与 pendingReports。 */
  refresh(open: OpenSession): Promise<void> {
    open.refreshing = open.refreshing.then(async () => {
      try {
        const inspection = await open.harness.inspect(ctx)
        const outbox = await open.harness.snapshot(OutboxDoc, open.root.id, ctx)
        this.patch(open.id, {
          hasActive: inspection.tasks.length > 0 || inspection.submissions.length > 0,
          pendingReports: outbox?.pending.length ?? 0,
        })
      } catch { /* 会话正在关闭，索引保留最后一次的值。 */ }
    })
    return open.refreshing
  }

  /** 改索引；观察字段真的变了才发 session.updated。 */
  patch(id: string, patch: Parameters<SessionIndex['update']>[1], immediate = false): void {
    const result = this.deps.index.update(id, patch, immediate)
    if (result?.changed) this.updated(result.entry)
  }

  touch(id: string): void { this.patch(id, { updatedAt: this.deps.now() }) }

  updated(entry: SessionEntry, extra: Json = {}): void {
    const { title, updatedAt, hasActive, pendingReports } = summarize(entry)
    this.emit(entry.id, 'session.updated', { title, updatedAt, hasActive, pendingReports, ...extra })
  }

  private report(id: string, error: unknown): void {
    this.deps.log(`session ${id}`, error)
    // 非 StorageRejected 的存储错误会让 Harness 中毒，之后所有操作都抛；识别到就重开该会话（architecture §2.2）。
    if (isPoisoned(error)) void this.recover(id)
  }

  /** 失败的命令之后探一下会话是否已中毒；空提交不写任何东西，但会先检查健康状态。 */
  async probe(id: string, error: unknown): Promise<void> {
    if (error instanceof CommandError || error instanceof StorageRejected || error instanceof ConversationBusy) return
    const open = this.peek(id)
    if (!open) return
    if (isPoisoned(error)) { await this.recover(id); return }
    try { await open.harness.commit(() => undefined, ctx) } catch (probeError) {
      if (isPoisoned(probeError)) await this.recover(id)
    }
  }

  async recover(id: string): Promise<void> {
    const slot = this.slots.get(id)
    if (!slot || slot.state !== 'open') return
    this.deps.log(`reopening poisoned session ${id}`)
    await this.close(id, { refresh: false })
    const entry = this.deps.index.get(id)
    // 后台任务要续跑的会话立刻重开一次；其余的等下一条命令。失败不再重试，免得坏库把 worker 拖进循环。
    if (entry?.hasActive || this.deps.index.currentId === id) await this.open(id).catch(error => this.deps.log(`reopen of ${id} failed`, error))
  }

  async close(id: string, options: { refresh?: boolean } = {}): Promise<void> {
    for (;;) {
      const slot = this.slots.get(id)
      if (!slot) return
      if (slot.state === 'closing') { await slot.promise.catch(() => {}); return }
      if (slot.state === 'opening') { await slot.promise.catch(() => {}); continue }
      const open = slot.open!
      slot.state = 'closing'
      slot.promise = this.teardown(open, options.refresh !== false)
      await slot.promise.catch(error => this.deps.log(`close of ${id} failed`, error))
      if (this.slots.get(id) === slot) this.slots.delete(id)
      return
    }
  }

  private async teardown(open: OpenSession, refresh: boolean): Promise<void> {
    // 关闭前校正一次索引：之后 inspect 就不可用了。
    if (refresh) await this.refresh(open)
    if (open.graphTimer) clearTimeout(open.graphTimer)
    open.graphTimer = undefined
    await Promise.allSettled(open.stops.splice(0).map(stop => stop()))
    await open.bridge.stop().catch(() => {})
    open.bridge.abandon('closed', 'Session closed before the reply finished')
    // close() 会中止在途调用且不写任务结果，任务保持 pending，下次打开续跑。
    await open.harness.close(ctx)
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.slots.values()].map(slot => slot.promise))
    await Promise.all([...this.slots.keys()].map(id => this.close(id)))
  }

  /** 是否必须保持打开：当前会话、有未终止任务、有回合在进行。 */
  keepOpen(open: OpenSession): boolean {
    return this.deps.index.currentId === open.id
      || this.deps.index.get(open.id)?.hasActive === true
      || open.bridge.unsettled > 0
      || open.bridge.runActive
  }

  /**
   * 清理器：Reporter 已终止或不存在、条目却还是 queued / running 的，置 failed（lost）并补写汇报。幂等，随时可调；
   * 触发点是事件桥看到 Reporter / Anchor 的 task_failed，以及每次空闲回收巡检。
   */
  cleanLost(open: OpenSession): Promise<void> {
    if (open.cleaningQueued) return open.cleaning
    open.cleaningQueued = true
    open.cleaning = open.cleaning.then(async () => {
      open.cleaningQueued = false
      // 会话已在关闭：库马上不可用，条目留到下次打开时由对账收尾。
      if (this.peek(open.id) !== open) return
      try {
        if ((await cleanLostHandoffs(open.harness, open.root, ctx)) > 0) await this.refresh(open)
      } catch (error) { this.report(open.id, error) }
    })
    return open.cleaning
  }

  /** 空闲回收（每分钟检查一次）：不满足保持条件、持续 idleCloseMs 之后关闭；顺带校正索引、清理丢失的委托。 */
  async sweep(): Promise<void> {
    for (const open of this.all()) {
      await this.refresh(open)
      // 当前会话与 hasActive 的会话不会被回收，也就不会因重开而对账，所以只能在这里兜底；没有活动条目时只读一份文档。
      await this.cleanLost(open)
      if (this.keepOpen(open) || this.deps.now() - open.lastUsed < this.deps.idleCloseMs) continue
      await this.close(open.id)
    }
  }

  /** 并存上限：超出时先关最久没用的空闲会话，全都不空闲则不关。 */
  private async evict(): Promise<void> {
    while (this.slots.size >= this.deps.maxOpen) {
      const candidate = this.all().filter(open => !this.keepOpen(open)).sort((left, right) => left.lastUsed - right.lastUsed)[0]
      if (!candidate) return
      await this.close(candidate.id)
    }
  }

  /**
   * 根对话此刻是否有前台工作：自己的前台任务，或已被某个 run 接手的输入。后台任务（Anchor、Reporter、抽取）不算。
   * 排队中的输入也算：失败 run 遗留的 queued 项空闲时不会自己动，新提交（即便 whenBusy: 'reject'）会排在它们后面，
   * 汇报排在后面就可能在放进对话之前被主人的 chat.abort 撤回，而它已记为 delivered。
   * `except` 是调用方自己的 requestId：它的提交由 deliverReport 按 requestId 去重，不该挡住自己。
   */
  async busy(open: OpenSession, except?: string): Promise<boolean> {
    const { tasks, submissions } = await open.harness.inspect(ctx)
    const id = open.root.id
    return tasks.some(({ record }) => record.conversationId === id && !record.background)
      || submissions.some(item => item.conversationId === id && item.type === 'input' && item.requestId !== except && (item.status === 'placed' || item.status === 'queued'))
  }

  /** 删除时序第 1~5 步（architecture §2.2）；第 0 步（切走当前会话）与第 6 步（通知）由调用方负责。 */
  async remove(id: string): Promise<void> {
    const { index, sessionsDir } = this.deps
    const open = await this.settle(id)
    if (open) {
      // close() 本身会中止所有在途调用，所以 10 秒内没等到就直接进入下一步。
      await Promise.race([open.root.abort(ctx, { background: true }).catch(() => {}), sleep(DELETE_ABORT_MS)])
      await this.close(id, { refresh: false })
    }
    const directory = this.directory(id)
    let trashed: string | undefined
    if (existsSync(directory)) {
      const trash = path.join(sessionsDir, '.trash')
      mkdirSync(trash, { recursive: true, mode: 0o700 })
      // 先原子改名再改索引：3 之前被杀会话仍在，3 与 4 之间被杀启动时丢弃条目，4 之后被杀只剩 .trash，都不会复活。
      trashed = path.join(trash, `${id}-${this.deps.now()}`)
      renameSync(directory, trashed)
    }
    const wasCurrent = index.currentId === id
    index.remove(id)
    if (wasCurrent) index.setCurrent(index.latest()?.id ?? '')
    if (trashed) rmSync(trashed, { recursive: true, force: true })
  }

  /** 若有正在进行的打开则等它落定；返回此刻已打开的会话。 */
  private async settle(id: string): Promise<OpenSession | undefined> {
    const slot = this.slots.get(id)
    if (slot?.state === 'opening') await slot.promise.catch(() => {})
    return this.peek(id)
  }

  /** 启动校验：清空 .trash（5 之后被杀的残留）。 */
  emptyTrash(): void {
    const trash = path.join(this.deps.sessionsDir, '.trash')
    if (!existsSync(trash)) return
    for (const name of readdirSync(trash)) rmSync(path.join(trash, name), { recursive: true, force: true })
  }

  /** 索引缺失或损坏：扫描目录，从各库的 app.session 重建。 */
  async scan(): Promise<SessionEntry[]> {
    const { sessionsDir, models } = this.deps
    const found: SessionEntry[] = []
    if (!existsSync(sessionsDir)) return found
    for (const name of readdirSync(sessionsDir)) {
      const file = path.join(sessionsDir, name, 'durable.sqlite')
      if (!SESSION_ID.test(name) || !existsSync(file)) continue
      let storage: Storage | undefined
      let harness: Harness | undefined
      try {
        storage = await this.deps.openStorage(file)
        harness = await Harness.open(storage, { models, registry: this.deps.registry, settings: this.deps.settings, onReport: error => this.deps.log(`scan of ${name}`, error) }, ctx)
        const stamp = statSync(file).mtimeMs
        const doc = await harness.snapshot(SessionDoc, ctx)
        const outbox = await harness.snapshot(OutboxDoc, ROOT_CONVERSATION_ID, ctx)
        const inspection = await harness.inspect(ctx)
        found.push({
          id: name,
          title: doc?.title ?? '',
          createdAt: doc?.createdAt || stamp,
          updatedAt: stamp,
          hasActive: inspection.tasks.length > 0 || inspection.submissions.length > 0,
          pendingReports: outbox?.pending.length ?? 0,
        })
      } catch (error) {
        this.deps.log(`session ${name} could not be recovered into the index`, error)
      } finally {
        if (harness) await harness.close(ctx).catch(() => {})
        else await storage?.close(ctx).catch(() => {})
      }
    }
    return found
  }
}
