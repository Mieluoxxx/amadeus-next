import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import type { Conversation, Extension, Harness } from '@earendil-works/pi-durable'
import { createMemoryExtension } from './extension.ts'
import { createExtractTask, scheduleExtract } from './extract.ts'
import { MemoryExtractDoc, MemoryRecallDoc, type ExtractResult, type MemoryRecallState } from './kinds.ts'
import { prepareMemory, type PrepareMemoryResult } from './prepare.ts'
import { createJevScorer, createJournalTask, planRecall, scheduleJournal, type RecallPlan, type Scorer } from './recall.ts'
import { MemoryStore, type ListItem } from './store.ts'
import { isMemoryType, isRecallMode, type ErrorCode, type MemoryChange, type RecallMode } from './types.ts'
import { isDateString } from './text.ts'

type Json = Record<string, unknown>

export type MemoryTuning = {
  /** 抽取去抖：第一轮之后等多久再读最新内容（默认 30s）。 */
  extractDebounceMs?: number
  /** 日记整理：对话安静多久后开始（默认 10 分钟）。 */
  journalQuietMs?: number
  /** 压缩时自带陪伴向摘要（默认开）。 */
  companionSummary?: boolean
  /** Jev 硬超时（默认 700ms）。 */
  recallTimeoutMs?: number
}

export type MemoryServiceOptions = {
  /** `<userData>/memory`。 */
  dir: string
  models: Models
  post: (message: Json) => void
  now?: () => number
  tuning?: MemoryTuning
  /** 召回打分器工厂，每次召回时调用；缺省按环境变量里的 Jev 配置创建，未配置则召回安静地不工作。 */
  recallScorer?: () => Scorer | undefined
  /** 初始开关；正式运行以主进程的 `memory.configure` 为准。 */
  enabled?: boolean
  recall?: RecallMode
}

export type PrepareOptions = {
  /** 即将提交的用户输入是第几轮（durable 里没有现成的计数）。 */
  turn: number
  /** 这一轮主人的输入原文；M3 召回需要，不传则不召回。 */
  input?: string
  /** 汇报回合：不召回。 */
  report?: boolean
  /** 供 `memory.status` 按会话取最近一次抽取结果。 */
  sessionId?: string
}

export interface MemoryService {
  /** 需要安装进 registry 的全部扩展（含任务定义）。 */
  readonly extensions: readonly Extension[]
  /** 根对话选择的那个，名为 `amadeus-memory`。 */
  readonly mainExtension: Extension
  /** `chat.submit` / `report.deliver` 提交输入之前、对话空闲时调用（long-term-memory.md §4.1）。 */
  prepare(harness: Harness, conversation: Conversation, context: Context, options: PrepareOptions): Promise<unknown>
  /** 用户回合（或汇报回合）落定后调用：规则门控通过则安排 M2 抽取，并安排 M3 日记整理。不阻塞，失败只记日志。 */
  afterTurn(harness: Harness, conversation: Conversation, context: Context, options?: { sessionId?: string }): Promise<void>
  /** `memory.*` 命令；业务失败返回 `{ ok: false, code, error }`。 */
  handle(command: string, params: Json): Promise<Json>
  close(): Promise<void>
}

const MESSAGE: Record<ErrorCode, string> = {
  disabled: '长期记忆已关闭',
  empty: '内容不能为空',
  too_long: '内容太长，请控制在 120 字以内',
  sensitive: '内容像是包含身份证号、密码或密钥，不能写入长期记忆',
  injection: '内容像是指令或标签，不是关于你的事实，不能写入',
  quote_not_found: '原话引用在最近的对话里找不到',
  quote_too_short: '原话引用太短，无法核对',
  quote_unrelated: '内容超出了原话所能支持的范围',
  limit: '记忆已满或写入过于频繁，请先整理',
  conflict_external: '这条记忆刚被外部修改，请刷新后重试',
  io: '记忆存储暂时不可用',
  not_found: '找不到这条记忆',
  invalid: '参数无效',
  unconfirmed: '删除依据不足，没有删除',
}

const failure = (code: ErrorCode | 'unsupported', length?: number): Json => ({
  ok: false,
  code,
  error: code === 'unsupported' ? '不支持的记忆命令' : code === 'too_long' && length ? `内容有 ${length} 字，上限 120 字` : MESSAGE[code],
})

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function lastExtract(detail: string): ExtractResult | null {
  try {
    const parsed = JSON.parse(detail) as Partial<ExtractResult>
    if (parsed.status !== 'ok' && parsed.status !== 'skipped' && parsed.status !== 'failed') return null
    return { at: Number(parsed.at), status: parsed.status, proposed: Number(parsed.proposed ?? 0), dropped: parsed.dropped ?? {}, ...(parsed.error ? { error: parsed.error } : {}) }
  } catch {
    return null
  }
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const now = options.now ?? Date.now
  const tuning = options.tuning ?? {}
  let recall: RecallMode = options.recall ?? 'log'
  // 弱引用：会话关闭后不该被 memory.status 的缓存拖住。
  const sessions = new Map<string, { harness: WeakRef<Harness>; conversation: WeakRef<Conversation> }>()
  const trackSession = (sessionId: string | undefined, harness: Harness, conversation: Conversation): void => {
    if (sessionId) sessions.set(sessionId, { harness: new WeakRef(harness), conversation: new WeakRef(conversation) })
  }

  const store = new MemoryStore({
    dir: options.dir,
    now,
    onChange: (change: MemoryChange) => options.post({ type: 'event', name: 'memory.changed', ...change }),
  })
  store.enabled = options.enabled ?? true

  // 打开失败时本次运行禁用记忆、对话照常（long-term-memory.md §7 第 1 行）。
  let openError: unknown
  const ready = store.open().then(
    () => true,
    error => {
      openError = error
      console.error('[amadeus-next] memory store failed to open:', error)
      return false
    },
  )

  const extractTask = createExtractTask({ store, now })
  const journalTask = createJournalTask({ store, mode: () => recall, now })
  const extension = createMemoryExtension({ store, extractTask, journalTask, companionSummary: tuning.companionSummary ?? true })
  const scorer = (): Scorer | undefined => (options.recallScorer ? options.recallScorer() : createJevScorer())

  async function prepare(harness: Harness, conversation: Conversation, context: Context, opts: PrepareOptions): Promise<PrepareMemoryResult | { action: 'none'; reason: string }> {
    trackSession(opts.sessionId, harness, conversation)
    if (!(await ready)) return { action: 'none', reason: 'unavailable' }
    // 关闭时不写任何记忆条目：已注入的块保持原样（long-term-memory.md §7 第 13 行）。
    if (!store.enabled) return { action: 'none', reason: 'disabled' }
    await store.reconcile(true)

    const wantsRecall = Boolean(opts.input) && !opts.report && recall !== 'off'
    // log 模式只记候选、不注入：放到后台去打分，不占语音首包（on 模式才需要在 commit 之前拿到结果）。
    if (wantsRecall && recall === 'log') detach(logRecall(harness, conversation, context, opts))

    let recalled: RecallPlan = {}
    const result = await prepareMemory(harness, conversation, context, {
      build: async () => {
        const selection = store.selection()
        if (wantsRecall && recall === 'on') recalled = await recallPlan(harness, conversation, context, opts)
        return { items: selection.items, truncated: selection.truncated, ...(recalled.episode ? { episode: recalled.episode } : {}) }
      },
    })

    if (recalled.best) {
      store.db.logRecall({
        at: now(),
        mode: recall,
        turn: opts.turn,
        chunkId: recalled.best.chunk.id,
        score: recalled.best.score,
        injected: result.episodeEntryId !== undefined,
        body: recalled.best.chunk.body,
      })
    }
    return result
  }

  /** 召回只是增强：任何失败都退化成"不注入"，不影响记忆注入本身。 */
  async function recallPlan(harness: Harness, conversation: Conversation, context: Context, opts: PrepareOptions): Promise<RecallPlan> {
    try {
      const state: MemoryRecallState = (await harness.snapshot(MemoryRecallDoc, conversation.id, context)) ?? { chunkIds: [], count: 0, lastTurn: null }
      return await planRecall(
        { store, mode: () => recall, scorer, ...(tuning.recallTimeoutMs ? { timeoutMs: tuning.recallTimeoutMs } : {}) },
        conversation.id,
        opts.input as string,
        state,
        opts.turn,
        context.abortSignal,
      )
    } catch (error) {
      console.error('[amadeus-next] memory recall failed:', error)
      return {}
    }
  }

  async function logRecall(harness: Harness, conversation: Conversation, context: Context, opts: PrepareOptions): Promise<void> {
    const plan = await recallPlan(harness, conversation, context, opts)
    if (!plan.best) return
    store.db.logRecall({ at: now(), mode: 'log', turn: opts.turn, chunkId: plan.best.chunk.id, score: plan.best.score, injected: false, body: plan.best.chunk.body })
  }

  const background = new Set<Promise<unknown>>()
  function detach(job: Promise<unknown>): void {
    const tracked = job.catch(error => console.error('[amadeus-next] memory background job failed:', error)).finally(() => background.delete(tracked))
    background.add(tracked)
  }

  async function afterTurn(harness: Harness, conversation: Conversation, context: Context, opts: { sessionId?: string } = {}): Promise<void> {
    trackSession(opts.sessionId, harness, conversation)
    if (!(await ready) || !store.enabled) return
    try {
      const verdict = await scheduleExtract(store, extractTask, harness, conversation, context, { debounceMs: tuning.extractDebounceMs ?? 30_000, now })
      const meaningful = !['report', 'disabled', 'no_turn', 'failed'].includes(verdict)
      if (meaningful && recall !== 'off') await scheduleJournal(journalTask, harness, conversation, context, { quietMs: tuning.journalQuietMs ?? 600_000, now })
    } catch (error) {
      if (context.abortSignal?.aborted) return
      console.error('[amadeus-next] memory afterTurn failed:', error)
    }
  }

  async function status(sessionId: unknown): Promise<Json> {
    const stats = store.stats()
    let latest: ExtractResult | null = null
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    const harness = session?.harness.deref()
    const conversation = session?.conversation.deref()
    if (harness && conversation) {
      try {
        latest = (await harness.snapshot(MemoryExtractDoc, conversation.id, BACKGROUND_CONTEXT))?.lastResult ?? null
      } catch {
        // 会话已关闭：退回全局最近一次。
        sessions.delete(sessionId as string)
      }
    }
    if (!latest) {
      const run = store.lastExtractRun()
      latest = run ? lastExtract(run.detail) : null
    }
    return {
      ok: true,
      enabled: store.enabled,
      counts: { reviewed: stats.reviewed, unreviewed: stats.unreviewed, archived: stats.archived, invalid: stats.invalid, due: stats.due },
      snapshotBytes: stats.snapshotBytes,
      lastExtract: latest,
      recall,
    }
  }

  const itemOf = (id: string): ListItem | undefined => store.item(id)

  async function dispatch(command: string, params: Json): Promise<Json> {
    switch (command) {
      case 'memory.list': {
        const { items, invalid, stats } = await store.list()
        return { ok: true, items, invalid: invalid.map(({ file, error }) => ({ file, error })), stats }
      }
      case 'memory.write': {
        const outcome = await store.write(params.id !== undefined ? { id: params.id, type: params.type, body: params.body, reviewAfter: params.reviewAfter } : { type: params.type, body: params.body, reviewAfter: params.reviewAfter })
        return outcome.ok ? { ok: true, item: itemOf(outcome.entry.id) } : failure(outcome.code, outcome.length)
      }
      case 'memory.delete': {
        const outcome = await store.delete(params.id)
        return outcome.ok ? { ok: true } : failure(outcome.code)
      }
      case 'memory.accept': {
        const edit = isRecord(params.edit) ? params.edit : {}
        if (edit.reviewAfter !== undefined && edit.reviewAfter !== null && !isDateString(edit.reviewAfter)) return failure('invalid')
        if (edit.type !== undefined && !isMemoryType(edit.type)) return failure('invalid')
        const outcome = await store.accept(params.id, edit)
        if (!outcome.ok) return failure(outcome.code, outcome.length)
        return outcome.removed !== undefined ? { ok: true, removed: outcome.removed } : { ok: true, item: outcome.entry ? itemOf(outcome.entry.id) : undefined }
      }
      case 'memory.reject': {
        const outcome = await store.reject(params.id)
        return outcome.ok ? { ok: true } : failure(outcome.code)
      }
      case 'memory.clear': {
        const outcome = await store.clear()
        return outcome.ok ? { ok: true, trashed: outcome.trashed } : failure(outcome.code)
      }
      case 'memory.status': {
        await store.reconcile(true)
        return status(params.sessionId)
      }
      case 'memory.configure': {
        if (params.enabled !== undefined && typeof params.enabled !== 'boolean') return failure('invalid')
        if (params.recall !== undefined && !isRecallMode(params.recall)) return failure('invalid')
        if (typeof params.enabled === 'boolean') store.enabled = params.enabled
        if (isRecallMode(params.recall)) recall = params.recall
        return { ok: true }
      }
      default:
        return failure('unsupported')
    }
  }

  return {
    extensions: [extension],
    mainExtension: extension,
    prepare,
    afterTurn,
    async handle(command, params) {
      // configure 只改内存里的开关，存储没打开也要能生效；其余命令都要存储就绪。
      if (command !== 'memory.configure' && !(await ready)) return { ...failure('io'), error: openError instanceof Error ? `记忆存储不可用：${openError.message}` : MESSAGE.io }
      try {
        return await dispatch(command, isRecord(params) ? params : {})
      } catch (error) {
        console.error(`[amadeus-next] ${command} failed:`, error)
        return failure('io')
      }
    },
    async close() {
      await ready
      await Promise.allSettled([...background])
      await store.close()
    },
  }
}
