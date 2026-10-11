export const MEMORY_TYPES = ['profile', 'preference', 'relationship', 'feedback', 'ongoing'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
export type MemoryStatus = 'reviewed' | 'unreviewed'
export type Confidence = 'high' | 'medium' | 'low'
export type MemorySource = 'manual' | 'explicit' | 'extracted'
export type Area = 'core' | 'archived'
export type ProposalKind = 'replace' | 'remove'

/** 注入时的取舍优先级：数字小的先放，挤不下就停（long-term-memory.md §4.2）。 */
export const INJECT_PRIORITY: Record<MemoryType, number> = { feedback: 0, relationship: 1, preference: 2, profile: 3, ongoing: 4 }
/** 渲染顺序与取舍优先级不同：先稳定的画像，再易变的事项。 */
export const RENDER_ORDER: Record<MemoryType, number> = { profile: 0, preference: 1, relationship: 2, feedback: 3, ongoing: 4 }

export const BODY_MAX = 120
export const QUOTE_MAX = 200
export const SNAPSHOT_LIMIT = 3072

export const isMemoryType = (value: unknown): value is MemoryType => typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)

/** 一条能被解析的记忆；`id` 即文件名（不含 `.md`）。 */
export type MemoryEntry = {
  id: string
  area: Area
  type: MemoryType
  status: MemoryStatus
  confidence: Confidence
  source: MemorySource
  sourceQuote: string
  body: string
  bodyHash: string
  createdAt: number
  updatedAt: number
  reviewAfter: string | null
  proposal: ProposalKind | null
  target: string | null
  supersedes: string[]
  autoDowngraded: boolean
  mtimeMs: number
  size: number
}

export type InvalidFile = { id: string; area: Area; file: string; error: string; mtimeMs: number; size: number }

/** 闸门与存储返回给调用方的错误码；`rejected_before` 只用于抽取的丢弃统计。 */
export type GateCode =
  | 'disabled'
  | 'empty'
  | 'too_long'
  | 'sensitive'
  | 'injection'
  | 'quote_not_found'
  | 'quote_too_short'
  | 'quote_unrelated'
  | 'limit'
  | 'conflict_external'
  | 'io'
export type DropReason = GateCode | 'rejected_before' | 'duplicate' | 'invalid' | 'too_many'
export type ErrorCode = GateCode | 'not_found' | 'invalid' | 'unconfirmed'

export type Failure = { ok: false; code: ErrorCode; length?: number }
export type Ok<T extends object = object> = { ok: true } & T
export type Outcome<T extends object = object> = Ok<T> | Failure

export type ChangeReason = 'manual' | 'tool' | 'extract' | 'external' | 'clear'
export type MemoryChange = { reason: ChangeReason; ids?: string[] }

/** 注入用的最小条目：快照与增量只关心 id、类型、正文。 */
export type InjectItem = { id: string; type: string; body: string }

export type RecallMode = 'off' | 'log' | 'on'
export const isRecallMode = (value: unknown): value is RecallMode => value === 'off' || value === 'log' || value === 'on'
