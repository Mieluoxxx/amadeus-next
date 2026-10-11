import { defineDoc, defineEntry } from '@earendil-works/pi-durable'

// kind 字符串是持久化协议的一部分：界面与事件桥按它过滤，改名会让旧会话里的记忆条目漏过滤。
export const SNAPSHOT_KIND = 'amadeus.memory-snapshot'
export const UPDATE_KIND = 'amadeus.memory-update'
export const REFREEZE_KIND = 'amadeus.memory-refreeze'
export const EPISODE_KIND = 'amadeus.episode'

// 'empty' 目前没有写入路径：快照全空只会出现在压缩后，按文档第 3 行仍记为 'compaction'，这里保留以对齐文档的 data 定义。
export type SnapshotReason = 'first' | 'compaction' | 'empty'

export type SnapshotData = {
  v: 1
  hash: string
  bytes: number
  count: number
  truncated: number
  reason: SnapshotReason
}

export type UpdateData = {
  v: 1
  hash: string
  bytes: number
  added: number
  removed: number
}

export type RefreezeData = {
  v: 1
  hash: string
  bytes: number
  count: number
  truncated: number
  replaced: number
  omitted: number[]
}

export type EpisodeData = {
  v: 1
  chunkIds: string[]
  scores: number[]
}

export const MemorySnapshotEntry = defineEntry<SnapshotData>(SNAPSHOT_KIND)
export const MemoryUpdateEntry = defineEntry<UpdateData>(UPDATE_KIND)
export const MemoryRefreezeEntry = defineEntry<RefreezeData>(REFREEZE_KIND)
export const MemoryEpisodeEntry = defineEntry<EpisodeData>(EPISODE_KIND)

/** 模型当前"有效看到"的记忆状态，是计算增量的唯一依据（long-term-memory.md §2.4）。 */
export type MemoryBaselineState = {
  snapshotEntryId: number | null
  snapshotBytes: number
  hash: string
  effective: Record<string, { type: string; body: string }>
  updateEntryIds: number[]
  updateBytes: number
  refrozenAt: number | null
}

export const MemoryBaseline = defineDoc<MemoryBaselineState>({
  kind: 'app.memory-baseline',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  // 分叉出的对话没有继承快照条目，必须重新写一份，所以从初始值开始。
  fork: 'initial',
  initial: () => ({
    snapshotEntryId: null,
    snapshotBytes: 0,
    hash: '',
    effective: {},
    updateEntryIds: [],
    updateBytes: 0,
    refrozenAt: null,
  }),
})

/** 供界面与事件桥把记忆条目从字幕、TTS 和对话记录里剔除。 */
export function isMemoryEntry(entry: { kind?: string } | undefined): boolean {
  const kind = entry?.kind
  return kind === SNAPSHOT_KIND || kind === UPDATE_KIND || kind === REFREEZE_KIND || kind === EPISODE_KIND
}

const FENCE_PREFIXES = ['<amadeus_core_memory', '<amadeus_episode']

/**
 * `message_start` 不带 kind，只能凭围栏识别；`beforeCompact` 钩子拿到的也只有消息。
 * 围栏前缀同时覆盖 `<amadeus_core_memory>` 与 `<amadeus_core_memory_update>`。
 */
export function isMemoryMessage(message: { role?: string; content?: unknown } | undefined): boolean {
  if (message?.role !== 'user') return false
  const { content } = message
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) && content[0]?.type === 'text' ? String(content[0].text) : ''
  return FENCE_PREFIXES.some(prefix => text.startsWith(prefix))
}

export type ExtractResult = {
  at: number
  status: 'ok' | 'skipped' | 'failed'
  proposed: number
  dropped: Record<string, number>
  error?: string
}

/** M2 抽取的游标与限流（long-term-memory.md §2.4）。 */
export type MemoryExtractState = {
  cursor: number | null
  lastRunAt: number | null
  /** 最近一小时内每次抽取的毫秒时间，用于每会话每小时 ≤ 12 次的限流。 */
  recent: number[]
  lastResult: ExtractResult | null
}

export const MemoryExtractDoc = defineDoc<MemoryExtractState>({
  kind: 'app.memory-extract',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ cursor: null, lastRunAt: null, recent: [], lastResult: null }),
})

/** M3 日记整理的游标，与抽取分开：两者读同一段对话，但推进节奏不同。 */
export type MemoryJournalState = { cursor: number | null; lastRunAt: number | null }

export const MemoryJournalDoc = defineDoc<MemoryJournalState>({
  kind: 'app.memory-journal',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ cursor: null, lastRunAt: null }),
})

/** M3 召回的会话内账：同一段只注入一次、一个会话最多 5 次、相邻两次至少隔 3 个用户回合。 */
export type MemoryRecallState = { chunkIds: string[]; count: number; lastTurn: number | null }

export const MemoryRecallDoc = defineDoc<MemoryRecallState>({
  kind: 'app.memory-recall',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ chunkIds: [], count: 0, lastTurn: null }),
})
