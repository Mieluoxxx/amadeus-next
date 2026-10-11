import { scan, looksSensitive } from './redact.ts'
import {
  BODY_MAX,
  QUOTE_MAX,
  isMemoryType,
  type Confidence,
  type DropReason,
  type MemoryEntry,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type ProposalKind,
} from './types.ts'
import { addDays, cpLength, fold, hasRecorded, isDateString, jaccard, localDate, normalizeBody, normalizeQuote, quoteCoverage, quoteWeight, sha256, stripRecorded, truncateCp } from './text.ts'
import type { RejectionRow } from './indexdb.ts'

// 词表集中在这里（long-term-memory.md §3.3 第 3 步）；命中即视为"会过期的事"，类型强制归 ongoing。
const RELATIVE_ZH = ['今天', '明天', '后天', '昨天', '前天', '今晚', '昨晚', '明晚', '今早', '这周', '本周', '下周', '上周', '这个月', '本月', '下个月', '上个月', '最近', '马上', '待会', '明年', '今年', '去年']
const RELATIVE_JA = ['今日', '明日', '昨日', '来週', '今週', '先週', '来月', '今月', '先月', '来年']
const RELATIVE_EN = /\b(today|tomorrow|yesterday|tonight|next\s+(week|month|year)|last\s+(week|month|year)|this\s+(week|month)|recently)\b/i
export const hasRelativeTime = (text: string): boolean =>
  RELATIVE_ZH.some(word => text.includes(word)) || RELATIVE_JA.some(word => text.includes(word)) || RELATIVE_EN.test(text)

const SIMILAR = 0.8
const HINT_LOW = 0.4
const REVIEWED_LIMIT = 200
const EXPLICIT_PER_MINUTE = 5
// 引用太短（"的"、"天"）在任何一句话里都找得到，等于没核对；正文也必须主要由引用撑起来，不能只是顺带蹭一个字。
const QUOTE_WEIGHT_MIN = 1
const QUOTE_COVERAGE_MIN = 0.3

export type GateInput = {
  source: MemorySource
  type: unknown
  body: unknown
  sourceQuote?: unknown
  /** 抽取给出的可信度；其余来源由证据契约推出。 */
  confidence?: Confidence
  /** 仅 manual 可指定。 */
  reviewAfter?: unknown
  /** 主人最近的用户回合输入；'trusted' 表示引用已在上游核对过（抽取的 apply 阶段）。 */
  userTurns?: readonly string[] | 'trusted'
  /** 就地编辑既有条目：跳过去重，且不改变它的状态与来源。 */
  editing?: MemoryEntry
  /** 抽取的提议：目标条目不参与去重，拒绝键带上目标。 */
  proposal?: { kind: ProposalKind; target: MemoryEntry }
}

export interface GateWorld {
  readonly enabled: boolean
  readonly now: number
  entries(): readonly MemoryEntry[]
  rejection(hash: string): RejectionRow | undefined
  recentRejections(): readonly RejectionRow[]
  recentExplicitWrites(): number
}

export type WritePlan = {
  action: 'create' | 'update' | 'promote' | 'exists'
  /** update / promote / exists 时的既有条目。 */
  target?: MemoryEntry
  type: MemoryType
  /** 正文，含系统追加的记录日期。 */
  body: string
  bodyHash: string
  status: MemoryStatus
  source: MemorySource
  sourceQuote: string
  confidence: Confidence
  autoDowngraded: boolean
  reviewAfter: string | null
  proposal?: { kind: ProposalKind; target: string }
  /** 就地编辑既有条目：类型与 reviewAfter 以本计划为准，其余沿用目标。 */
  editing?: true
  /** 主人亲口说的优先于自动提议的拒绝：要清掉的 rejections 行。 */
  clearRejections: string[]
  /** remember 的更正提示：同类型相似度在 [0.4, 0.8) 的已有 reviewed 条目。 */
  similar: MemoryEntry[]
  /** 新增的是 unreviewed，抽取超限时先把最旧的归档。 */
  needsRoom: boolean
}

export type GateResult = { ok: true; plan: WritePlan } | { ok: false; code: DropReason; length?: number }

const fail = (code: DropReason, length?: number): GateResult => ({ ok: false, code, ...(length === undefined ? {} : { length }) })

/** 证据契约（LiveAgent）：high 要 ≥ 5 字原话，medium 要非空原话，不满足逐级降。 */
export function applyEvidence(confidence: Confidence, quote: string): { confidence: Confidence; downgraded: boolean } {
  let level = confidence
  let downgraded = false
  const trimmed = quote.trim()
  if (level === 'high' && cpLength(trimmed) < 5) {
    level = 'medium'
    downgraded = true
  }
  if (level === 'medium' && trimmed === '') {
    level = 'low'
    downgraded = true
  }
  return { confidence: level, downgraded }
}

/** 提议的拒绝键：`remove` 提议的正文就是目标条目的原文，必须带上目标才不会和普通正文哈希混在一起。 */
export const rejectionKey = (hash: string, norm: string, proposal?: { kind: ProposalKind; target: { id: string } }): string =>
  proposal?.kind === 'remove' ? sha256(`remove:${proposal.target.id}:${norm}`) : hash

export function evaluate(input: GateInput, world: GateWorld): GateResult {
  const { source, editing, proposal } = input
  const today = localDate(world.now)

  // 1 开关：manual 是人在设置页操作，关闭记忆后仍可整理。
  if (source !== 'manual' && !world.enabled) return fail('disabled')

  // 2 形状
  if (typeof input.body !== 'string') return fail('empty')
  const raw = input.body
  let body = fold(raw)
  if (body === '') return fail('empty')
  if (!isMemoryType(input.type)) return fail('invalid')
  let type: MemoryType = input.type
  const quote = fold(typeof input.sourceQuote === 'string' ? input.sourceQuote : '')
  if (source !== 'manual' && quote === '') return fail('empty')
  const length = cpLength(stripRecorded(body))
  if (length > BODY_MAX) return fail('too_long', length)
  let manualReviewAfter: string | undefined
  if (input.reviewAfter !== undefined && input.reviewAfter !== null) {
    if (!isDateString(input.reviewAfter)) return fail('invalid')
    manualReviewAfter = input.reviewAfter
  }

  // 3 相对时间
  let relative = false
  if (source !== 'manual' && hasRelativeTime(stripRecorded(body))) {
    relative = true
    type = 'ongoing'
    if (!hasRecorded(body)) body = `${body} (recorded on ${today})`
  }

  // 4 扫描：引用同样留在磁盘上，敏感信息不能藏在引用里。
  const verdict = scan(raw, source) ?? (looksSensitive(quote) ? 'sensitive' : undefined)
  if (verdict) return fail(verdict)

  // 5 引用核对
  if (source !== 'manual' && input.userTurns !== 'trusted') {
    const wanted = normalizeQuote(quote)
    const found = wanted !== '' && (input.userTurns ?? []).some(turn => normalizeQuote(turn).includes(wanted))
    if (!found) return fail('quote_not_found')
    if (quoteWeight(quote) < QUOTE_WEIGHT_MIN) return fail('quote_too_short')
    if (quoteCoverage(body, quote) < QUOTE_COVERAGE_MIN) return fail('quote_unrelated')
  }

  // 6 拒绝记忆
  const norm = normalizeBody(body)
  const hash = sha256(norm)
  const clearRejections: string[] = []
  const exactRejection = world.rejection(rejectionKey(hash, norm, proposal))
  const similarRejections = proposal ? [] : world.recentRejections().filter(row => row.body !== null && jaccard(normalizeBody(row.body), norm) >= SIMILAR)
  const superseded = world.entries().some(entry => entry.supersedes.some(old => jaccard(normalizeBody(old), norm) >= SIMILAR))
  if (exactRejection || similarRejections.length > 0 || superseded) {
    if (source === 'extracted') return fail('rejected_before')
    if (exactRejection) clearRejections.push(exactRejection.bodyHash)
    for (const row of similarRejections) clearRejections.push(row.bodyHash)
  }

  // 7 去重（所有 area，含 archived）
  const candidates = editing || proposal ? world.entries().filter(entry => entry.id !== editing?.id && entry.id !== proposal?.target.id) : world.entries()
  let action: WritePlan['action'] = 'create'
  let target: MemoryEntry | undefined
  if (editing) {
    action = 'update'
    target = editing
  } else {
    // 同一正文可能同时存在于 reviewed 与别处（提议、归档）；已转正的那条优先，才不会把"已有"误判成"转正"。
    const exact = candidates.filter(entry => entry.bodyHash === hash).sort((a, b) => Number(isLive(b)) - Number(isLive(a)))[0]
    const similar = exact
      ? undefined
      : candidates
          .filter(entry => entry.type === type && !entry.proposal)
          .map(entry => ({ entry, score: jaccard(norm, normalizeBody(entry.body)) }))
          .filter(item => item.score >= SIMILAR)
          .sort((a, b) => b.score - a.score)[0]?.entry
    // 提议改写目标时正文可以相似于目标；只有与目标逐字相同才算没有变化。
    if (proposal?.kind === 'replace' && proposal.target.bodyHash === hash) return fail('duplicate')
    const hit = exact ?? similar
    if (hit) {
      if (source === 'extracted') return fail('duplicate')
      target = hit
      action = isLive(hit) ? (exact ? 'exists' : 'update') : exact ? 'promote' : 'update'
    }
  }

  // 8 数量与频率
  const status: MemoryStatus = editing ? editing.status : source === 'extracted' ? 'unreviewed' : 'reviewed'
  const becomesLive = status === 'reviewed' && action !== 'exists' && !(target && isLive(target))
  if (becomesLive && world.entries().filter(isLive).length >= REVIEWED_LIMIT) return fail('limit')
  if (source === 'explicit' && action !== 'exists' && world.recentExplicitWrites() >= EXPLICIT_PER_MINUTE) return fail('limit')

  const evidence = source === 'manual' ? { confidence: 'high' as Confidence, downgraded: false } : applyEvidence(source === 'explicit' ? 'high' : (input.confidence ?? 'medium'), quote)
  let reviewAfter: string | null = null
  if (type === 'ongoing') {
    if (relative) reviewAfter = addDays(today, 7)
    else if (manualReviewAfter) reviewAfter = manualReviewAfter
    else if (editing?.type === 'ongoing' && editing.reviewAfter) reviewAfter = editing.reviewAfter
    else reviewAfter = addDays(today, 30)
  }

  const similar =
    action === 'create' && source === 'explicit'
      ? world
          .entries()
          .filter(entry => isLive(entry) && !entry.proposal && entry.type === type)
          .map(entry => ({ entry, score: jaccard(norm, normalizeBody(entry.body)) }))
          .filter(item => item.score >= HINT_LOW && item.score < SIMILAR)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2)
          .map(item => item.entry)
      : []

  return {
    ok: true,
    plan: {
      action,
      ...(target ? { target } : {}),
      type,
      body,
      bodyHash: hash,
      status,
      source: editing ? editing.source : source,
      sourceQuote: truncateCp(quote, QUOTE_MAX),
      confidence: editing ? editing.confidence : evidence.confidence,
      autoDowngraded: editing ? editing.autoDowngraded : evidence.downgraded,
      reviewAfter,
      ...(proposal ? { proposal: { kind: proposal.kind, target: proposal.target.id } } : {}),
      ...(editing ? { editing: true as const } : {}),
      clearRejections,
      similar,
      needsRoom: status === 'unreviewed' && action === 'create',
    },
  }
}

/** forget 带 id 却没出现在候选里时的凭据：query 按引用对待，份量够且与该条正文有足够多的共同 ≥ 3 字窗口。 */
export const queryOverlapsBody = (query: string, body: string): boolean =>
  quoteWeight(query) >= QUOTE_WEIGHT_MIN && quoteCoverage(query, stripRecorded(body)) >= QUOTE_COVERAGE_MIN

/** 在核心区、已确认、不是提议：才算"正在被注入的那一类"。 */
export const isLive = (entry: MemoryEntry): boolean => entry.status === 'reviewed' && entry.area === 'core' && !entry.proposal
