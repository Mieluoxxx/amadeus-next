import type { Context, JsonValue } from '@earendil-works/chord'
import { withCancel } from '@earendil-works/chord/context'
import { LiveDoc } from '@earendil-works/pi-durable'
import type { ContextEdit, Conversation, EntryId, Harness, TaskRecord, Tx } from '@earendil-works/pi-durable'
import type { UserMessage } from '@earendil-works/pi-ai'
import {
  MemoryBaseline,
  MemoryEpisodeEntry,
  MemoryRefreezeEntry,
  MemorySnapshotEntry,
  MemoryUpdateEntry,
  type EpisodeData,
  type MemoryBaselineState,
} from './kinds.ts'
import { plan, type Plan } from './plan.ts'
import {
  blockHash,
  itemsFromText,
  renderSnapshot,
  toEffective,
  utf8Bytes,
  type MemoryItem,
} from './render.ts'

export type MemoryAction = 'snapshot' | 'update' | 'refreeze' | 'none' | 'skipped'

export type PrepareMemoryResult = {
  action: MemoryAction
  /** 本次追加的记忆条目；`none` 与 `skipped` 没有。 */
  entryId?: number
  /** 同一次 commit 里追加的召回条目（M3）。 */
  episodeEntryId?: number
  reason?: 'busy'
}

/** 召回块在记忆条目之后、同一次 commit 里追加；`onAppended` 在同一事务里更新会话内的召回账。 */
export type EpisodeDraft = {
  text: string
  data: EpisodeData
  onAppended?: (tx: Tx, entryId: number) => void | Promise<void>
}

/** 空闲复核通过之后才计算：召回打分最长 700ms，不能浪费在忙碌的对话上。 */
export type MemoryBuild = {
  items: readonly MemoryItem[]
  /** 因 3KB 预算被挤掉的条数。 */
  truncated?: number
  episode?: EpisodeDraft
}

export type PrepareMemoryOptions = {
  /** 当前应当被模型看到的记忆条目（带类型、已按预算选好）。 */
  build?: () => MemoryBuild | Promise<MemoryBuild>
  /** P0 兼容：当前应当被模型看到的记忆文本，每个非空行一条，行首 `- ` 可有可无。 */
  snapshotSource?: () => string
  /** run 刚结束时任务收尾有一个很短的窗口，先等它而不是误判为忙；0 表示不等。 */
  idleWaitMs?: number
  now?: () => number
}

const DEFAULT_IDLE_WAIT_MS = 250

type LiveTask = TaskRecord<JsonValue, JsonValue, JsonValue>

/**
 * 与 `Conversation.waitForIdle` 不同，这里只看主对话自己的前台任务：
 * 后台任务（Anchor、Reporter、抽取）以及它们名下的子任务不算忙。
 * 失败 run 遗留在收件箱里的 `queued` 输入也不算，它们要等下一次 submit 才落位，追加记忆条目不会插到它们中间。
 */
export async function isConversationIdle(harness: Harness, conversationId: Conversation['id'], context: Context): Promise<boolean> {
  const { tasks, submissions } = await harness.inspect(context)
  const live = new Map<number, LiveTask>(tasks.map(({ record }) => [record.id, record]))
  const underBackground = (start: LiveTask): boolean => {
    for (let record: LiveTask | undefined = start; record !== undefined; record = record.owner === undefined ? undefined : live.get(record.owner)) {
      if (record.background) return true
    }
    return false
  }
  if (tasks.some(({ record }) => record.conversationId === conversationId && !underBackground(record))) return false
  return !submissions.some(item => item.conversationId === conversationId && item.type === 'input' && item.status === 'placed')
}

async function waitForIdleWithin(conversation: Conversation, context: Context, ms: number): Promise<void> {
  if (ms <= 0) return
  const { context: waitContext, cancel } = withCancel(context)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    cancel()
  }, ms)
  try {
    await conversation.waitForIdle(waitContext)
  } catch (error) {
    // 调用方自己取消、或 Harness 已关闭的错误必须继续往上抛；只有自己的超时才当作"仍然忙"。
    if (!timedOut) throw error
  } finally {
    clearTimeout(timer)
  }
}

function userMessage(text: string, timestamp: number): UserMessage {
  return { role: 'user', content: text, timestamp }
}

function readBaseline(draft: MemoryBaselineState): MemoryBaselineState {
  // Draft 是代理对象，拷成普通值再交给纯函数，免得判定逻辑意外读到可变视图。
  return JSON.parse(JSON.stringify(draft)) as MemoryBaselineState
}

function assignBaseline(draft: MemoryBaselineState, next: Partial<MemoryBaselineState>): void {
  Object.assign(draft, next)
}

type Draft<T> = T

/**
 * 在对话空闲时、提交用户输入之前调用（long-term-memory.md §4.1 的 prepareInput 第 2–4 步）。
 * 忙时一律不写，也不退到 `submit({ type: 'write' })`：写提交在下一个边界才落位，基线文档无法与它同一次 commit。
 * `build` / `snapshotSource` 抛出的错误原样上抛，由宿主决定是否仍然提交用户输入。
 */
export async function prepareMemory(
  harness: Harness,
  conversation: Conversation,
  context: Context,
  options: PrepareMemoryOptions,
): Promise<PrepareMemoryResult> {
  await waitForIdleWithin(conversation, context, options.idleWaitMs ?? DEFAULT_IDLE_WAIT_MS)
  if (!(await isConversationIdle(harness, conversation.id, context))) return { action: 'skipped', reason: 'busy' }

  const built: MemoryBuild = options.build ? await options.build() : { items: itemsFromText(options.snapshotSource?.() ?? '') }
  const now = (options.now ?? Date.now)()

  return conversation.commit(async (tx): Promise<PrepareMemoryResult> => {
    // 上面的检查与这次 commit 之间可能有别的写者开了 run；commit 内再看一次 `pi.live.run`，让"忙时不写"没有缝隙。
    if ((await tx.doc(LiveDoc, conversation.id)).run !== undefined) return { action: 'skipped', reason: 'busy' }

    const draft = await tx.doc(MemoryBaseline, conversation.id)
    const baseline = readBaseline(draft)
    // 所有表读取必须先于第一次表写入，否则 Tx 抛 ReadAfterWrite。
    const marker = await tx.latestHeadMarker(conversation.id)
    const decision = plan({ baseline, current: built.items, activeHead: marker?.head })
    const result = await writeDecision(tx, conversation, draft, baseline, decision, built, now)

    const episode = built.episode
    if (!episode) return result
    // 召回条目排在记忆条目之后、同一次 commit；忙时不写的约束对它同样成立（上面已复核）。
    const entry = await tx.appendEntry(MemoryEpisodeEntry, conversation.id, {
      model: [userMessage(episode.text, now)],
      data: episode.data,
    })
    await episode.onAppended?.(tx, entry.id)
    return { ...result, episodeEntryId: entry.id }
  }, context)
}

async function writeDecision(
  tx: Tx,
  conversation: Conversation,
  draft: Draft<MemoryBaselineState>,
  baseline: MemoryBaselineState,
  decision: Plan,
  built: MemoryBuild,
  now: number,
): Promise<PrepareMemoryResult> {
  const current = built.items
  const truncated = built.truncated ?? 0
  switch (decision.kind) {
    case 'none':
      return { action: 'none' }
    case 'forget-snapshot':
      assignBaseline(draft, { snapshotEntryId: null, snapshotBytes: 0, hash: '', updateEntryIds: [], updateBytes: 0 })
      return { action: 'none' }
    case 'snapshot': {
      const block = renderSnapshot(current)
      const hash = blockHash(block)
      const bytes = utf8Bytes(block)
      const edits: ContextEdit[] = decision.omit.map(id => ({ target: id as EntryId, action: 'omit' }))
      const entry = await tx.appendEntry(MemorySnapshotEntry, conversation.id, {
        model: [userMessage(block, now)],
        data: { v: 1, hash, bytes, count: current.length, truncated, reason: decision.reason },
        ...(edits.length > 0 ? { edits } : {}),
      })
      assignBaseline(draft, {
        snapshotEntryId: entry.id,
        snapshotBytes: bytes,
        hash,
        effective: toEffective(current),
        updateEntryIds: [],
        updateBytes: 0,
      })
      return { action: 'snapshot', entryId: entry.id }
    }
    case 'update': {
      const bytes = utf8Bytes(decision.text)
      const entry = await tx.appendEntry(MemoryUpdateEntry, conversation.id, {
        model: [userMessage(decision.text, now)],
        data: { v: 1, hash: blockHash(decision.text), bytes, added: decision.added.length, removed: decision.removed.length },
      })
      // 先移除再新增：条目的 id 在编辑后保持不变，同一个 id 会同时出现在 removed（旧正文）和 added（新正文）里。
      const effective = { ...baseline.effective }
      for (const item of decision.removed) delete effective[item.id]
      Object.assign(effective, toEffective(decision.added))
      assignBaseline(draft, {
        effective,
        updateEntryIds: [...baseline.updateEntryIds, entry.id],
        updateBytes: baseline.updateBytes + bytes,
      })
      return { action: 'update', entryId: entry.id }
    }
    case 'refreeze': {
      const block = renderSnapshot(current)
      const hash = blockHash(block)
      const bytes = utf8Bytes(block)
      const target = baseline.snapshotEntryId as number
      const edits: ContextEdit[] = [
        { target: target as EntryId, action: 'replace', messages: [userMessage(block, now)] },
        ...baseline.updateEntryIds.map((id): ContextEdit => ({ target: id as EntryId, action: 'omit' })),
      ]
      // 没有 model：重新冻结只改上下文的呈现，不新增模型消息。
      const entry = await tx.appendEntry(MemoryRefreezeEntry, conversation.id, {
        data: { v: 1, hash, bytes, count: current.length, truncated, replaced: target, omitted: [...baseline.updateEntryIds] },
        edits,
      })
      assignBaseline(draft, {
        snapshotBytes: bytes,
        hash,
        effective: toEffective(current),
        updateEntryIds: [],
        updateBytes: 0,
        refrozenAt: now,
      })
      return { action: 'refreeze', entryId: entry.id }
    }
  }
}
