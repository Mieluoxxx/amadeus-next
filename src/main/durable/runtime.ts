import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import { ConversationBusy, UsageDoc, createRegistry, type ConversationId, type Extension, type HarnessSettings, type Storage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { ActivityLog } from './childActivity.ts'
import { cardOf, entriesOf, readHistory } from './history.ts'
import { CommandError, KeyedLanes, Lane } from './lanes.ts'
import { readSelection, resolveSelection, thinkingLevels, writeSelection } from './modelSelection.ts'
import { ProcessLock } from './processLock.ts'
import { createRoleExtension } from './role.ts'
import { composeTitle, generateTopic, isNamingDue, titleSourceOf, type TitleSource } from './sessionName.ts'
import { userTexts } from './history.ts'
import { SESSION_ID, SessionDoc, SessionIndex, summarize, type SessionEntry } from './sessionIndex.ts'
import { SessionHost, type OpenSession } from './sessionHost.ts'
import {
  HandoffsDoc,
  OutboxDoc,
  approveHandoff,
  cancelHandoff,
  createHandoffExtensions,
  deliverReport,
  delegationModelFromEnv,
  listHandoffs,
  resolveLimits,
  summaryOf,
  type HandoffOptions,
  type RemotePool,
} from './handoff/index.ts'
import type { TargetPool } from './remote/pool.ts'
import { createMemoryService, type MemoryService, type MemoryServiceOptions, type PrepareOptions } from './memory/index.ts'
import { isRecallMode } from './memory/types.ts'
import { direct, directorPrompt, normalizeRequest, voiceModel } from './voice.ts'
import { targetsFromEnv } from './remote/targets.ts'
import { applySettingsEnv, type WorkerSettingKey } from '../../shared/workerSettings.ts'
import { WorkLedger } from './workLedger.ts'

type Json = Record<string, unknown>
export type Post = (message: Json) => void

export type DurableRuntimeOptions = {
  models: Models
  /** `<userData>/sessions`：每个会话一个子目录，内含 durable.sqlite，另有 index.json 与 .lock。 */
  sessionsDir: string
  /** ROLE.md、PRESENTATION.md、settings.json 所在目录。 */
  agentDir: string
  /** 记忆目录；缺省为 sessionsDir 的同级 `memory`。 */
  memoryDir?: string
  post: Post
  /** 空闲会话多久后关闭（默认 10 分钟）；每 sweepMs 检查一次。 */
  idleCloseMs?: number
  sweepMs?: number
  /** 并存上限（默认 16）。 */
  maxOpen?: number
  /** 取进程锁时持有者存活的最长等待（默认 10 秒）。 */
  lockWaitMs?: number
  /** checkpoint 等在途回合自然结束的宽限（默认 5 秒），之后 close() 会中止它们。 */
  checkpointGraceMs?: number
  settings?: Partial<HarnessSettings>
  handoff?: HandoffOptions
  /** 远程目标池（设置页的 remote_targets）；不设就没有 remote 委托。 */
  remote?: RemotePool & Pick<TargetPool, 'env' | 'close' | 'hello'> & Partial<Pick<TargetPool, 'configure'>>
  extraExtensions?: readonly Extension[]
  /** `config.apply` 改了哪些设置；worker 据此刷新启动时缓存的部分（代理、skills / MCP 来源）。 */
  onSettings?: (changed: ReadonlySet<WorkerSettingKey>) => void
  /** 会话自动命名（默认开）；测试关掉它，免得命名请求吃掉 faux 的脚本响应。 */
  autoName?: boolean
  /** 以下三项是测试接缝。 */
  openStorage?: (file: string) => Promise<Storage>
  createMemory?: typeof createMemoryService
  now?: () => number
  log?: (message: string, error?: unknown) => void
}

const ctx = BACKGROUND_CONTEXT
const ABORTED = Symbol('aborted')
const TITLE_MAX = 200

const SESSION_COMMANDS = new Set(['chat.submit', 'report.deliver', 'session.load', 'session.rename', 'session.delete', 'task.cancel', 'task.approve', 'task.trace'])
/** 工作面板列表里，运行中的任务附带最近几步。 */
const RECENT_ACTIONS = 3
const GLOBAL_COMMANDS = new Set(['session.list', 'session.create', 'model.list', 'model.set', 'reload', 'checkpoint', 'resume'])

const text = (value: unknown): string => typeof value === 'string' ? value : ''

/**
 * 命令参数。封包 `{ id, command, ...params }` 里的 `id` 与参数同名（report.deliver 的汇报 id、memory.* 的记忆 id）会撞车，
 * 所以优先取嵌套的 `params`；没有嵌套时把平铺字段当参数，此时 `id` / `command` 属于封包。
 */
function paramsOf(message: Json): Json {
  if (message.params && typeof message.params === 'object' && !Array.isArray(message.params)) return { ...message.params as Json }
  const { id: _id, command: _command, params: _params, ...flat } = message
  return flat
}

function describe(error: unknown): { code: string; message: string } {
  if (error instanceof CommandError) return { code: error.code, message: error.message }
  if (error instanceof ConversationBusy) return { code: 'busy', message: 'The conversation is busy' }
  // 委托模块用 Error('not_found') 表示任务或确认不存在 / 已处理 / 已过期。
  if (error instanceof Error && error.message === 'not_found') return { code: 'not_found', message: 'Not found' }
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) }
}

/**
 * pi-worker 在 durable 运行时下的主体（architecture §7）：命令分道、会话索引、SessionHost 的调度，以及全部命令。
 * 每条命令恰好一条终止应答（done / error / aborted）；回合进度走 `turn.*` 事件，由事件桥发出。
 */
export class DurableRuntime {
  private readonly options: DurableRuntimeOptions
  private readonly registry = createRegistry()
  private readonly lock: ProcessLock
  private readonly index: SessionIndex
  private readonly ledger: WorkLedger
  /** 公开给测试与基准脚本取已打开的会话；命令一律走 handle()。 */
  readonly host: SessionHost
  private readonly role: Extension
  private handoff: readonly Extension[]
  private readonly sessionLanes = new KeyedLanes()
  private readonly globalLane = new Lane()
  private readonly memoryJobs = new Set<Promise<unknown>>()
  private readonly epochs = new Map<string, number>()
  private readonly stopping = new Map<string, Promise<void>>()
  private memory: MemoryService | undefined
  private readonly memoryDir: string
  /** 最近一次 memory.configure 的开关。worker 不持久化配置，resume 重建服务时据此沿用，否则会悄悄回到默认（开 / log）。 */
  private memorySettings: Pick<MemoryServiceOptions, 'enabled' | 'recall'> = {}
  /** 索引校验 / 重建的进度。重建要逐个打开会话库，不能挡住 ready（主进程有 20 秒启动超时），所以命令与预热等它，ready 不等。 */
  private indexing: Promise<void> = Promise.resolve()
  private state: 'running' | 'checkpointing' | 'closed' = 'running'
  private sweeper: ReturnType<typeof setInterval> | undefined
  private readonly now: () => number
  private readonly log: (message: string, error?: unknown) => void

  constructor(options: DurableRuntimeOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((message, error) => console.error(`[amadeus-next] durable: ${message}`, error ?? ''))
    this.lock = new ProcessLock(options.sessionsDir)
    this.index = new SessionIndex(options.sessionsDir, error => this.log('session index write failed', error))
    this.ledger = new WorkLedger(options.sessionsDir, error => this.log('work ledger write failed', error))
    this.role = createRoleExtension(options.agentDir)
    this.memoryDir = options.memoryDir ?? path.join(path.dirname(options.sessionsDir), 'memory')
    this.handoff = this.assembleHandoff()
    for (const extension of [this.role, ...this.handoff, ...(options.extraExtensions ?? [])]) this.registry.install(extension)
    const settings: HarnessSettings = {
      // 不依赖"默认全选"：每个对话显式选择扩展，子代理才不会意外拿到主对话的工具。
      extensions: [],
      // 第一个 partial 也要等满间隔才提交，100ms 会吃掉首包预算（评估 §2.5）。
      progress: { partialIntervalMs: 30, outputIntervalMs: 100 },
      stream: { cacheRetention: 'long' },
      ...options.settings,
    }
    this.host = new SessionHost({
      sessionsDir: options.sessionsDir,
      agentDir: options.agentDir,
      models: options.models,
      registry: this.registry,
      settings,
      index: this.index,
      ledger: this.ledger,
      agentExtensions: () => [this.role, ...(this.memory ? [this.memory.mainExtension] : []), this.handoff[0]],
      openStorage: options.openStorage ?? (file => openNodeSqliteStorage(file)),
      post: message => options.post(message),
      memory: () => this.memory,
      ...(options.remote ? { remoteEnv: (target: string, cwd: string) => options.remote!.env(target, cwd) } : {}),
      ...(options.autoName === false ? {} : { afterUserTurn: (open: OpenSession) => this.autoName(open) }),
      idleCloseMs: options.idleCloseMs ?? 600_000,
      maxOpen: options.maxOpen ?? 16,
      progressIntervalMs: resolveLimits(options.handoff?.limits).progressIntervalMs,
      now: this.now,
      log: this.log,
    })
  }

  /** 远程机器的增减会改变 handoff 的 schema（是否有 remote、target 的取值），所以随之重建；registry 按名字原地替换。 */
  private assembleHandoff(): readonly Extension[] {
    const { options } = this
    // 拒绝根由宿主显式给出，不靠守卫去读 process.env：环境变量名一旦与主进程设置的对不上，userData 就悄悄失去保护。
    const guard = options.handoff?.guard
    return createHandoffExtensions({
      ...options.handoff,
      ...(options.remote ? { remote: options.remote } : {}),
      // 设置页的委托模型可以热更新，每次受理现读。
      delegationModel: options.handoff?.delegationModel ?? (() => delegationModelFromEnv(process.env)),
      guard: { ...guard, deny: [...(guard?.deny ?? []), path.dirname(options.sessionsDir), options.sessionsDir, this.memoryDir, options.agentDir] },
    })
  }

  /**
   * 设置页的改动：写进 process.env（多数读取方每次使用时现读），再刷新启动时缓存的部分。
   * 远程机器变了要重建委托扩展；已打开会话的下一次请求就带上新的 handoff schema。
   */
  private applySettings(params: Json): Json {
    const values = params.env && typeof params.env === 'object' && !Array.isArray(params.env) ? params.env as Record<string, unknown> : {}
    const changed = applySettingsEnv(process.env, values)
    if (!changed.size) return { changed: [] }
    this.options.onSettings?.(changed)
    if (changed.has('AMADEUS_REMOTE_TARGETS') && this.options.remote?.configure) {
      this.options.remote.configure(targetsFromEnv(process.env, message => this.log(message)))
      this.handoff = this.assembleHandoff()
      for (const extension of this.handoff) this.registry.install(extension)
    }
    return { changed: [...changed] }
  }

  /**
   * 取进程锁（先于开任何库）→ 校验索引 → 起记忆服务与空闲回收。锁被占用时抛错，worker 在 ready 里报告。
   * 索引缺失或损坏时的重建在 ready 之后进行（命令与预热等它），这里只做读取与校验。
   */
  async start(): Promise<void> {
    await this.lock.acquire({ waitMs: this.options.lockWaitMs })
    try {
      mkdirSync(this.options.sessionsDir, { recursive: true, mode: 0o700 })
      this.host.emptyTrash()
      this.ledger.load()
      // 先起记忆服务：重建索引要打开各库，registry 里的扩展得是全的。
      this.startMemory()
      const rebuilding = this.checkIndex()
      if (rebuilding) this.indexing = rebuilding.catch(error => this.log('session index rebuild failed', error))
      this.startSweeper()
    } catch (error) {
      await this.memory?.close().catch(() => {})
      this.memory = undefined
      this.lock.release()
      throw error
    }
  }

  /** ready 之后在后台打开当前会话和 hasActive 的会话（architecture §2.2）。 */
  async warm(): Promise<void> {
    await this.indexing
    if (this.state === 'running') await this.host.warm()
  }

  /** 进程退出钩子里同步释放进程锁。 */
  releaseLock(): void { this.lock.release() }

  private async rebuildIndex(): Promise<void> {
    const found = await this.host.scan()
    const latest = [...found].sort((left, right) => right.updatedAt - left.updatedAt)[0]
    this.index.replace(found, latest?.id ?? '')
  }

  /**
   * 校验索引：丢弃指向不存在库的条目与不是当前会话的空条目；缺失或损坏就需要扫描各库重建，此时返回重建的 promise，
   * 由调用方决定等不等（start 不等，resume 要等）。校验本身是同步的，抛错照常从调用处抛出。
   */
  private checkIndex(): Promise<void> | undefined {
    const { index } = this
    if (index.load() !== 'ok') return this.rebuildIndex()
    for (const entry of index.all()) {
      const stored = existsSync(path.join(this.options.sessionsDir, entry.id, 'durable.sqlite'))
      if (entry.empty) {
        if (stored) index.update(entry.id, { empty: false })
        else if (entry.id !== index.currentId) index.remove(entry.id)
      } else if (!stored) index.remove(entry.id)
    }
    if (index.currentId && !index.has(index.currentId)) index.currentId = index.latest()?.id ?? ''
    index.flush(true)
    return undefined
  }

  private startMemory(): void {
    try {
      const create = this.options.createMemory ?? createMemoryService
      const service = create({ dir: this.memoryDir, models: this.options.models, post: message => this.options.post(message), now: this.now, ...this.memorySettings })
      for (const extension of service.extensions) this.registry.install(extension)
      this.memory = service
    } catch (error) {
      // 记忆只是增强：起不来就本次运行不带记忆，对话照常。
      this.memory = undefined
      this.log('memory is disabled for this run', error)
    }
  }

  private startSweeper(): void {
    this.sweeper = setInterval(() => void this.host.sweep().catch(error => this.log('idle sweep failed', error)), this.options.sweepMs ?? 60_000)
    this.sweeper.unref?.()
  }

  /**
   * 命令入口。同步部分只做分道与 epoch 快照（排队中的命令要能被之后到达的 chat.abort 撤回），
   * 返回的 promise 在该命令的终止应答发出之后落定。
   */
  handle(message: Json): Promise<void> {
    const id = text(message.id)
    const command = text(message.command)
    const params = paramsOf(message)
    const sessionId = text(params.sessionId)
    const reply = (job: () => Promise<Json | typeof ABORTED>, scope?: string) => this.respond(id, job, scope)
    const fail = (code: string, error: string) => { this.options.post({ type: 'error', id, code, error }); return Promise.resolve() }

    if (command === 'chat.abort') return this.abort(id, sessionId)
    if (command === 'checkpoint' && this.state === 'running') this.state = 'checkpointing'
    else if (command !== 'checkpoint' && command !== 'resume' && this.state !== 'running') return fail('closed', 'Pi runtime is checkpointed; resume or restart it first')

    if (command.startsWith('memory.')) return reply(() => this.forwardMemory(command, params))
    // 只读、跨会话：不进全局道，免得排在 model.list（可能十几秒）后面。
    if (command === 'task.all') return reply(() => this.allTasks())
    // 改设置是同步的进程内操作，不必排在 model.list 之类的慢命令后面。
    if (command === 'config.apply') return reply(async () => this.applySettings(params))
    // 配音在开口的关键路径上，与会话无关：不进任何道，免得排在别的命令后面。
    if (command === 'voice.direct') return reply(() => this.direct(params))
    // 连接要等 ssh，可能十几秒；与会话无关，也不进全局道。
    if (command === 'remote.check') return reply(() => this.checkRemote(params))
    if (GLOBAL_COMMANDS.has(command)) return this.globalLane.run(() => reply(() => this.global(command, params)))
    if (!SESSION_COMMANDS.has(command)) return fail('invalid', `unsupported Pi worker command: ${command}`)
    if (!SESSION_ID.test(sessionId)) return fail('invalid', 'Invalid session id')
    const epoch = this.epochs.get(sessionId) ?? 0
    return this.sessionLanes.run(sessionId, () => reply(async () => {
      // 上一次 abort 还在收尾时，新命令不能抢在它前面碰对话。
      await this.stopping.get(sessionId)
      return this.session(command, sessionId, params, epoch)
    }, sessionId))
  }

  private async respond(id: string, job: () => Promise<Json | typeof ABORTED>, sessionId?: string): Promise<void> {
    try {
      const result = await job()
      this.options.post(result === ABORTED ? { type: 'aborted', id } : { ...result, type: 'done', id })
    } catch (error) {
      const { code, message } = describe(error)
      this.options.post({ type: 'error', id, code, error: message })
      if (sessionId) await this.host.probe(sessionId, error).catch(() => {})
    }
  }

  /** abort 旁路：不排队、立即执行；递增 epoch 使已排队但未开始的 chat.submit / report.deliver 回 aborted。 */
  private async abort(id: string, sessionId: string): Promise<void> {
    if (SESSION_ID.test(sessionId)) {
      this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
      // 会话未打开也成功：此时没有 run 可中止。
      const open = this.host.peek(sessionId)
      if (open) {
        const stopping = open.root.abort(ctx).catch(error => this.log(`abort of ${sessionId} failed`, error))
        this.stopping.set(sessionId, stopping)
        await stopping
        if (this.stopping.get(sessionId) === stopping) this.stopping.delete(sessionId)
      }
    }
    this.options.post({ type: 'aborted', id })
  }

  private stale(sessionId: string, epoch: number): boolean { return (this.epochs.get(sessionId) ?? 0) !== epoch }

  private async direct(params: Json): Promise<Json> {
    const request = normalizeRequest(params)
    if (!request.lines.length) return { lines: [] }
    const model = await voiceModel(this.options.models, this.options.agentDir)
    if (!model) throw new CommandError('no_model', 'No model is available for voice direction')
    return { lines: await direct(this.options.models, model, directorPrompt(this.options.agentDir), request) }
  }

  /** 设置页的"测试连接"：连上、部署 runner、确认工作目录可用。失败是业务结果（ok: false），不是命令错误。 */
  private async checkRemote(params: Json): Promise<Json> {
    const name = text(params.target)
    const remote = this.options.remote
    if (!remote?.targets.some(each => each.name === name)) return { ok: false, code: 'not_found', error: `remote target ${name} is not configured` }
    const check = await remote.checkDir(name, undefined)
    if (!check.ok) return { ok: false, code: 'unreachable', error: check.detail }
    const hello = remote.hello(name)
    return { path: check.path, ...(hello ? { os: hello.os, arch: hello.arch, node: hello.node } : {}) }
  }

  // ─── 全局道 ────────────────────────────────────────────────────────

  private async global(command: string, params: Json): Promise<Json> {
    // 重建中的索引还不是事实；checkpoint 也要等，否则锁释放后重建还在开库。
    await this.indexing
    switch (command) {
      case 'session.list': return { currentId: this.index.currentId, sessions: this.index.summaries() }
      case 'session.create': return this.create(params)
      case 'model.list': return this.modelState()
      case 'model.set': return this.setModel(params)
      case 'reload': return this.reload()
      case 'checkpoint': return this.checkpoint()
      case 'resume': return this.resume()
    }
    throw new CommandError('invalid', `unsupported Pi worker command: ${command}`)
  }

  private create(params: Json): Json {
    const sessionId = text(params.sessionId)
    if (!SESSION_ID.test(sessionId)) throw new CommandError('invalid', 'Invalid session id')
    const existing = this.index.get(sessionId)
    if (existing) return { session: summarize(existing) }
    const now = this.now()
    const entry: SessionEntry = { id: sessionId, title: text(params.title).trim().slice(0, TITLE_MAX), createdAt: now, updatedAt: now, hasActive: false, pendingReports: 0, empty: true }
    // 懒创建：只登记，不建目录、不开库。新建的会话随即成为当前会话。
    this.index.add(entry)
    this.index.setCurrent(sessionId)
    this.host.updated(entry)
    return { session: summarize(entry) }
  }

  private async modelState(): Promise<Json> {
    const { models, agentDir } = this.options
    const available = await models.getAvailable(undefined, { signal: AbortSignal.timeout(15000) })
    const selection = await resolveSelection(models, agentDir)
    return {
      models: available.map(model => ({ value: `${model.provider}/${model.id}`, label: `${model.name} (${model.provider})` })),
      current: selection ? `${selection.ref.provider}/${selection.ref.modelId}` : '',
      thinkingLevel: selection?.thinkingLevel,
      thinkingLevels: thinkingLevels(selection?.model),
    }
  }

  private async setModel(params: Json): Promise<Json> {
    const { models, agentDir } = this.options
    const value = text(params.model)
    const slash = value.indexOf('/')
    const model = slash > 0 ? models.getModel(value.slice(0, slash), value.slice(slash + 1)) : undefined
    if (!model) throw new CommandError('invalid', value ? 'Unknown model' : 'Invalid model')
    if (params.thinkingLevel !== undefined) {
      const current = readSelection(agentDir)
      if (current.provider !== model.provider || current.model !== model.id) throw new CommandError('invalid', 'Select the model before changing its thinking level')
      if (!thinkingLevels(model).includes(params.thinkingLevel as never)) throw new CommandError('invalid', 'Unsupported thinking level')
      writeSelection(agentDir, { thinkingLevel: String(params.thinkingLevel) })
    } else writeSelection(agentDir, { provider: model.provider, model: model.id })
    return this.modelState()
  }

  /** 等所有会话空闲 → 刷新模型目录 → 校验当前选择。不重开存储；ROLE.md 的修改下一次请求自然生效。 */
  private async reload(): Promise<Json> {
    for (const open of this.host.all()) await open.root.waitForIdle(ctx)
    const refresh = (this.options.models as Models & { refresh?: Models['refresh'] }).refresh
    if (refresh) await refresh.call(this.options.models, { allowNetwork: false, signal: AbortSignal.timeout(15000) } as never)
    await resolveSelection(this.options.models, this.options.agentDir)
    return {}
  }

  /**
   * 计划内重启：等所有命令道排空、在途回合有限地等它结束 → 关闭全部 Harness → 释放进程锁 → closed。
   * 此后只接受 checkpoint（幂等）和 resume；不"按需重开"，否则新旧进程会同时持有同一个库（architecture §2.2）。
   */
  private async checkpoint(): Promise<Json> {
    if (this.state === 'closed') return {}
    await this.sessionLanes.drained()
    await Promise.allSettled([...this.memoryJobs])
    const grace = this.options.checkpointGraceMs ?? 5000
    await Promise.all(this.host.all().map(open => Promise.race([open.root.waitForIdle(ctx).catch(() => {}), new Promise(resolve => setTimeout(resolve, grace).unref?.())])))
    this.host.accepting = false
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
    await this.host.closeAll()
    await this.options.handoff?.mcp?.closeAll()
    // 会话都关了，远程命令不再有主人；断开连接让 runner 杀掉它们。resume 之后按需重连。
    this.options.remote?.close()
    await this.memory?.close().catch(error => this.log('memory close failed', error))
    this.memory = undefined
    this.index.close()
    this.ledger.close()
    this.lock.release()
    this.state = 'closed'
    return {}
  }

  /** 替换进程启动失败时让旧 worker 恢复服务；会话懒重开，后台任务要续跑的会话在后台重开。 */
  private async resume(): Promise<Json> {
    if (this.state === 'running') return {}
    await this.lock.acquire({ waitMs: this.options.lockWaitMs })
    try {
      this.startMemory()
      // 替换进程可能已经改过索引与账本，以磁盘为准。
      await this.checkIndex()
      this.ledger.load()
    } catch (error) {
      await this.memory?.close().catch(() => {})
      this.memory = undefined
      this.lock.release()
      throw error
    }
    this.state = 'running'
    this.host.accepting = true
    this.startSweeper()
    void this.host.warm()
    return {}
  }

  // ─── 记忆道 ────────────────────────────────────────────────────────

  /** 与服务端的校验一致：参数不合法时整条命令作废，也就不该被记下来。 */
  private noteMemorySettings(params: Json): void {
    const { enabled, recall } = params
    if ((enabled !== undefined && typeof enabled !== 'boolean') || (recall !== undefined && !isRecallMode(recall))) return
    if (typeof enabled === 'boolean') this.memorySettings.enabled = enabled
    if (isRecallMode(recall)) this.memorySettings.recall = recall
  }

  private async forwardMemory(command: string, params: Json): Promise<Json> {
    if (command === 'memory.configure') this.noteMemorySettings(params)
    const memory = this.memory
    if (!memory) throw new CommandError('failed', 'Memory is unavailable')
    const job = memory.handle(command, params)
    this.memoryJobs.add(job)
    try { return await job } finally { this.memoryJobs.delete(job) }
  }

  // ─── 会话道 ────────────────────────────────────────────────────────

  private async session(command: string, sessionId: string, params: Json, epoch: number): Promise<Json | typeof ABORTED> {
    await this.indexing
    switch (command) {
      case 'chat.submit': return this.submit(sessionId, params, epoch)
      case 'report.deliver': return this.deliver(sessionId, params, epoch)
      case 'session.load': return this.load(sessionId)
      case 'session.rename': return this.rename(sessionId, params)
      case 'session.delete': return this.remove(sessionId)
      case 'task.cancel': return this.cancel(sessionId, params)
      case 'task.approve': return this.approve(sessionId, params)
      case 'task.trace': return this.trace(sessionId, params)
    }
    throw new CommandError('invalid', `unsupported Pi worker command: ${command}`)
  }

  /** 已建库的会话：空会话还没有库，这些命令不该替它建。 */
  private async existing(sessionId: string): Promise<OpenSession> {
    const entry = this.index.get(sessionId)
    if (!entry || entry.empty) throw new CommandError('not_found', 'Session not found')
    return this.host.open(sessionId)
  }

  /** 与已解析的 agent 比较，不同才 configure：durable 没有宿主默认模型，每个对话都必须自己带（architecture §3.2）。 */
  private async followSelection(open: OpenSession): Promise<void> {
    const selection = await resolveSelection(this.options.models, this.options.agentDir)
    if (!selection) throw new CommandError('no_model', 'No model is available; check Pi model configuration and credentials')
    const agent = await open.root.agent(ctx)
    if (agent.model?.provider !== selection.ref.provider || agent.model?.modelId !== selection.ref.modelId || agent.thinkingLevel !== selection.thinkingLevel) {
      await open.root.configure({ model: selection.ref, thinkingLevel: selection.thinkingLevel }, ctx)
    }
  }

  private async prepareMemory(open: OpenSession, options: Omit<PrepareOptions, 'turn' | 'sessionId'>): Promise<void> {
    const memory = this.memory
    if (!memory) return
    try { await memory.prepare(open.harness, open.root, ctx, { turn: open.turns, sessionId: open.id, ...options }) } catch (error) {
      // 记忆只是增强，读不出来也要照常回答主人。
      this.log('memory.prepare failed', error)
    }
  }

  private async submit(sessionId: string, params: Json, epoch: number): Promise<Json | typeof ABORTED> {
    const turnId = text(params.turnId)
    const content = text(params.text)
    if (!turnId || !content) throw new CommandError('invalid', 'turnId and text are required')
    if (this.stale(sessionId, epoch)) return ABORTED
    const open = await this.host.open(sessionId)
    if (this.stale(sessionId, epoch)) return ABORTED
    // 用户输入优先：遗留的 run（崩溃残留、尚未收尾的汇报回合）先中止。
    if (await this.host.busy(open)) await open.root.abort(ctx)
    await this.followSelection(open)
    open.turns += 1
    await this.prepareMemory(open, { input: content })
    if (this.stale(sessionId, epoch)) return ABORTED

    const requestId = `turn:${turnId}`
    open.bridge.expect(requestId, turnId)
    // 先置标记、后提交：hasActive 只会多、不会少，崩溃后才不会漏掉要续跑的会话（architecture §2）。
    this.host.patch(sessionId, { hasActive: true, updatedAt: this.now() })
    try {
      const input = { type: 'input' as const, content, requestId, whenBusy: 'reject' as const }
      try { await open.root.submit(input, ctx) } catch (error) {
        if (!(error instanceof ConversationBusy)) throw error
        // 忙判断与提交之间又有 run 启动：中止后重试一次，仍忙才报 busy。
        await open.root.abort(ctx)
        await open.root.submit(input, ctx)
      }
    } catch (error) {
      open.bridge.forget(requestId)
      void this.host.refresh(open)
      throw error
    }
    return { requestId }
  }

  private async deliver(sessionId: string, params: Json, epoch: number): Promise<Json | typeof ABORTED> {
    const outboxId = text(params.id) || text(params.outboxId)
    const turnId = text(params.turnId)
    if (!outboxId || !turnId) throw new CommandError('invalid', 'id and turnId are required')
    if (this.stale(sessionId, epoch)) return ABORTED
    const open = await this.existing(sessionId)
    if (this.stale(sessionId, epoch)) return ABORTED

    // 已投递 / 不存在的汇报不必为"忙"白白重试。
    const outbox = await open.harness.snapshot(OutboxDoc, open.root.id, ctx)
    if (outbox?.delivered[outboxId]) return { status: 'already' }
    const report = outbox?.pending.find(item => item.id === outboxId)
    if (!report) return { status: 'missing' }

    // 汇报绝不去 abort 别人的 run：忙就回 busy，汇报留在 pending。
    const requestId = `report:${outboxId}`
    if (await this.host.busy(open, requestId)) throw new CommandError('busy', 'The conversation is busy')
    await this.followSelection(open)
    await this.prepareMemory(open, { report: true })
    if (this.stale(sessionId, epoch)) return ABORTED

    open.bridge.expect(requestId, turnId)
    let result: Awaited<ReturnType<typeof deliverReport>>
    try { result = await deliverReport(open.harness, open.root, outboxId, ctx) } catch (error) {
      open.bridge.forget(requestId)
      throw error
    }
    if (result.status !== 'started') open.bridge.forget(requestId)
    if (result.status === 'busy') throw new CommandError('busy', 'The conversation is busy')
    if (result.status !== 'started') return { status: result.status }

    this.host.touch(sessionId)
    void this.host.refresh(open)
    if (result.entryId === null && result.submissionId !== undefined) void this.backfill(open, requestId, result.submissionId)
    const handoffs = await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)
    const item = handoffs?.items.find(each => each.taskId === report.taskId)
    return { status: 'started', ...(item ? { card: cardOf(item) } : {}) }
  }

  /** submit 返回时记录还是 queued：之后它被放进对话，事件桥会补；这里再查一次，堵住"事件先于 delivered 写入"的缝。 */
  private async backfill(open: OpenSession, requestId: string, submissionId: number): Promise<void> {
    try {
      const submission = await open.harness.submission(submissionId as never, ctx)
      const record = await submission?.status(ctx)
      if (record?.entry !== undefined) await this.host.fillEntry(open, requestId, record.entry)
    } catch (error) { this.log('report entry backfill failed', error) }
  }

  private async load(sessionId: string): Promise<Json> {
    const entry = this.index.get(sessionId)
    if (!entry) throw new CommandError('not_found', 'Session not found')
    this.index.setCurrent(sessionId)
    if (entry.empty) return { session: summarize(entry), messages: [], tasks: [], pendingReports: [] }
    const open = await this.host.open(sessionId)
    const [outbox, handoffs] = await Promise.all([
      open.harness.snapshot(OutboxDoc, open.root.id, ctx),
      open.harness.snapshot(HandoffsDoc, open.root.id, ctx),
    ])
    const cards = new Map((handoffs?.items ?? []).map(item => [item.taskId, cardOf(item)]))
    const messages = await readHistory(open.root, {
      delivered: outbox?.delivered ?? {},
      card: taskId => cards.get(taskId),
      turnOf: entryId => open.bridge.turnForEntry(entryId),
    })
    return {
      session: summarize(this.index.get(sessionId) ?? entry),
      messages,
      tasks: await listHandoffs(open.harness, open.root.id, ctx),
      pendingReports: (outbox?.pending ?? []).map(item => ({ id: item.id, title: cards.get(item.taskId)?.title ?? '' })),
    }
  }

  private async rename(sessionId: string, params: Json): Promise<Json> {
    const title = text(params.title).trim()
    if (!title || title.length > TITLE_MAX) throw new CommandError('invalid', 'Invalid title')
    // 界面上的重命名是 manual；宿主首条消息时补的时间戳占位是 default。
    const source: TitleSource = params.source === 'default' ? 'default' : 'manual'
    const entry = this.index.get(sessionId)
    if (!entry) throw new CommandError('not_found', 'Session not found')
    // app.session 是索引丢失时重建标题的依据；未建库的会话只改索引。
    if (!entry.empty) {
      const open = await this.host.open(sessionId)
      const applied = await open.root.commit(async tx => {
        const doc = await tx.doc(SessionDoc)
        // 占位标题可能晚于自动命名才到（首个回合很快时），不能把模型起好的名字盖回去。
        if (source === 'default' && titleSourceOf(doc) !== 'default') return false
        doc.title = title
        doc.titleSource = source
        return true
      }, ctx)
      if (!applied) return {}
    }
    this.host.patch(sessionId, { title }, true)
    return {}
  }

  private readonly naming = new Set<string>()

  /**
   * 主人发言达到首次 / 刷新的次数时，用会话模型起个话题，标题写成 `MMDD｜话题`。
   * 主人手动改过的标题不碰；起名期间主人又改了名，提交时再看一次，以主人为准。只是锦上添花，失败只记日志。
   */
  private autoName(open: OpenSession): void {
    // open.turns 是同一口径的计数，先用它挡掉不到点的回合，免得每轮都把整段历史扫一遍。
    if (this.naming.has(open.id) || !isNamingDue(open.turns)) return
    this.naming.add(open.id)
    void (async () => {
      const doc = await open.harness.snapshot(SessionDoc, ctx)
      if (doc && titleSourceOf(doc) === 'manual') return
      const outbox = await open.harness.snapshot(OutboxDoc, open.root.id, ctx)
      const texts = await userTexts(open.root, outbox?.delivered ?? {})
      if (!isNamingDue(texts.length)) return
      const agent = await open.root.agent(ctx)
      const model = agent.model ? this.options.models.getModel(agent.model.provider, agent.model.modelId) : undefined
      if (!model) return
      const topic = await generateTopic(this.options.models, model, texts)
      const entry = this.index.get(open.id)
      if (!entry || entry.empty) return
      const title = composeTitle(doc?.createdAt || entry.createdAt, topic)
      const applied = await open.root.commit(async tx => {
        const current = await tx.doc(SessionDoc)
        if (titleSourceOf(current) === 'manual') return false
        current.title = title
        current.titleSource = 'auto'
        return true
      }, ctx)
      if (applied) this.host.patch(open.id, { title }, true)
    })().catch(error => this.log(`auto-name of ${open.id} failed`, error)).finally(() => this.naming.delete(open.id))
  }

  private async remove(sessionId: string): Promise<Json> {
    const entry = this.index.get(sessionId)
    if (!entry) throw new CommandError('not_found', 'Session not found')
    await this.host.remove(sessionId)
    this.host.updated(entry, { deleted: true })
    return {}
  }

  private async cancel(sessionId: string, params: Json): Promise<Json> {
    const taskId = text(params.taskId)
    if (!taskId) throw new CommandError('invalid', 'taskId is required')
    const open = await this.existing(sessionId)
    return { ...(await cancelHandoff(open.harness, open.root, taskId, ctx)) }
  }

  /**
   * 工作面板的列表：已打开的会话读库里的最新状态（附带子代理最近几步），其余读账本，不为了列表去打开会话库。
   * 运行中的委托所在的会话一定是打开的（SessionHost.keepOpen），所以账本里只会是已经停下的任务。
   */
  private async allTasks(): Promise<Json> {
    await this.indexing
    const sessions: Json[] = []
    for (const entry of this.index.summaries()) {
      const open = this.host.peek(entry.id)
      const recorded = new Map(this.ledger.get(entry.id).map(record => [record.taskId, record]))
      let tasks: Json[] = [...recorded.values()]
      if (open) {
        try {
          const handoffs = await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)
          tasks = (handoffs?.items ?? []).map(item => {
            const log = open.activity.get(item.taskId)
            const known = recorded.get(item.taskId)
            return {
              ...summaryOf(item),
              toolUses: log?.toolUses ?? known?.toolUses ?? 0,
              tokens: log?.tokens ?? known?.tokens ?? 0,
              ...(log ? { recent: log.recent(RECENT_ACTIONS) } : {}),
            }
          })
        } catch (error) { this.log(`task list of ${entry.id} fell back to the ledger`, error) }
      }
      if (tasks.length) sessions.push({ sessionId: entry.id, title: entry.title, tasks })
    }
    return { sessions }
  }

  /** 一个委托子对话的完整动作历史；打开会话库读取（与 session.load 一样）。顺带校正账本里的计数。 */
  private async trace(sessionId: string, params: Json): Promise<Json> {
    const taskId = text(params.taskId)
    if (!taskId) throw new CommandError('invalid', 'taskId is required')
    const open = await this.existing(sessionId)
    const handoffs = await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)
    const item = handoffs?.items.find(each => each.taskId === taskId)
    if (!item) throw new CommandError('not_found', 'Task not found')
    const childId = item.child as ConversationId
    const child = await open.harness.conversation(childId, ctx)
    const log = new ActivityLog(Number.POSITIVE_INFINITY)
    if (child) for await (const entry of entriesOf(child)) log.entry(entry)
    log.usage(await open.harness.snapshot(UsageDoc, childId, ctx).catch(() => undefined) ?? undefined)
    this.ledger.count(sessionId, taskId, { toolUses: log.toolUses, tokens: log.tokens })
    return { task: { ...summaryOf(item), toolUses: log.toolUses, tokens: log.tokens }, actions: log.actions() }
  }

  private async approve(sessionId: string, params: Json): Promise<Json> {
    const taskId = text(params.taskId)
    const approvalId = text(params.approvalId)
    if (!taskId || !approvalId || typeof params.allow !== 'boolean') throw new CommandError('invalid', 'taskId, approvalId and allow are required')
    const open = await this.existing(sessionId)
    await approveHandoff(open.harness, open.root, taskId, approvalId, params.allow, ctx)
    return {}
  }
}
