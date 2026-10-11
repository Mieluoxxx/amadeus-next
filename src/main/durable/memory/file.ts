import { Document, parseDocument } from 'yaml'
import {
  BODY_MAX,
  QUOTE_MAX,
  isMemoryType,
  type Area,
  type Confidence,
  type InvalidFile,
  type MemoryEntry,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type ProposalKind,
} from './types.ts'
import { bodyHash, cpLength, fold, isDateString, isoSeconds, parseTime, stripRecorded, truncateCp } from './text.ts'

// 文件名即 id：允许 Unicode 字母、数字、`-`、`_`，长度 ≤ 80，不以 `.` 开头（long-term-memory.md §2.2）。
const NAME = /^[\p{L}\p{N}_-]{1,80}$/u
export const isValidName = (name: string): boolean => NAME.test(name)

const FRONTMATTER = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/
const RESERVED_TAG = /<\/?\s*amadeus_/i
const SUPERSEDES_KEEP = 3
const MAX_ALIAS_COUNT = 10

export type ParsedFile = {
  entry?: MemoryEntry
  invalid?: InvalidFile
  /** YAML 语法正确时保留，供回写时保留未知键与注释。 */
  document?: Document
  /** frontmatter 之后的原样正文，回写时不可丢。 */
  rest?: string
}

type Stat = { mtimeMs: number; size: number }

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

export const normalizeText = (raw: string): string => raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

export function parseMemoryFile(id: string, area: Area, raw: string, stat: Stat): ParsedFile {
  const file = area === 'archived' ? `archived/${id}.md` : `${id}.md`
  const fail = (error: string, extra: Partial<ParsedFile> = {}): ParsedFile => ({
    invalid: { id, area, file, error, mtimeMs: stat.mtimeMs, size: stat.size },
    ...extra,
  })
  if (!isValidName(id)) return fail('文件名只能包含字母、数字、- 和 _，且不超过 80 个字符')

  const text = normalizeText(raw)
  const match = FRONTMATTER.exec(text)
  if (!match) return fail('缺少 frontmatter（文件需以 --- 开头）')
  let document: Document
  let data: unknown
  try {
    document = parseDocument(match[1] ?? '')
    if (document.errors.length > 0) return fail(`frontmatter 的 YAML 有语法错误：${document.errors[0].message.split('\n')[0]}`)
    // 记忆文件是扁平键值，用不上别名；手改或同步冲突产生的别名炸弹（几百字节展开成指数级）在这里被拦下，只让这一个文件无法解析。
    data = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT })
  } catch (error) {
    return fail(`frontmatter 无法解析：${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return fail('frontmatter 不是键值对', { document })
  const fields = data as Record<string, unknown>
  const rest = text.slice(match[0].length)
  const withDoc = { document, rest }

  if (!isMemoryType(fields.type)) return fail('type 必须是 profile、preference、relationship、feedback 或 ongoing', withDoc)
  if (fields.status !== 'reviewed' && fields.status !== 'unreviewed') return fail('status 必须是 reviewed 或 unreviewed', withDoc)

  const body = fold(rest)
  if (body === '') return fail('正文为空', withDoc)
  if (RESERVED_TAG.test(body)) return fail('正文含保留标签 <amadeus_', withDoc)
  if (cpLength(stripRecorded(body)) > BODY_MAX) return fail(`正文超过 ${BODY_MAX} 字`, withDoc)

  const type: MemoryType = fields.type
  const reviewAfter = isDateString(fields.review_after) ? fields.review_after : null
  if (type === 'ongoing' && reviewAfter === null) return fail('ongoing 条目需要 review_after（YYYY-MM-DD）', withDoc)

  let proposal: ProposalKind | null = null
  let target: string | null = null
  if (fields.proposal !== undefined && fields.proposal !== null) {
    if (fields.proposal !== 'replace' && fields.proposal !== 'remove') return fail('proposal 必须是 replace 或 remove', withDoc)
    if (typeof fields.target !== 'string' || !isValidName(fields.target)) return fail('提议缺少有效的 target', withDoc)
    proposal = fields.proposal
    target = fields.target
  }

  const updatedAt = parseTime(fields.updated_at, stat.mtimeMs)
  const entry: MemoryEntry = {
    id,
    area,
    type,
    status: fields.status as MemoryStatus,
    confidence: pick<Confidence>(fields.confidence, ['high', 'medium', 'low'], 'medium'),
    source: pick<MemorySource>(fields.source, ['manual', 'explicit', 'extracted'], 'manual'),
    sourceQuote: typeof fields.source_quote === 'string' ? truncateCp(fold(fields.source_quote), QUOTE_MAX) : '',
    body,
    bodyHash: bodyHash(body),
    createdAt: parseTime(fields.created_at, updatedAt),
    updatedAt,
    reviewAfter: type === 'ongoing' ? reviewAfter : null,
    proposal,
    target,
    supersedes: Array.isArray(fields.supersedes) ? fields.supersedes.filter((item): item is string => typeof item === 'string').slice(0, SUPERSEDES_KEEP) : [],
    autoDowngraded: fields.auto_downgraded === true,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  }
  return { entry, document, rest }
}

export type FileFields = Pick<
  MemoryEntry,
  'type' | 'status' | 'confidence' | 'source' | 'sourceQuote' | 'createdAt' | 'updatedAt' | 'reviewAfter' | 'proposal' | 'target' | 'supersedes' | 'autoDowngraded'
>

/**
 * 写回时只动自己认识的键：传入已有的 Document 就保留未知键与注释；换行统一为 LF，BOM 在读取时已去掉。
 * 可选键在值为空时删除，保证 frontmatter 里不残留旧提议的 proposal / target。
 */
export function renderFile(fields: FileFields, body: string, base?: Document): string {
  const document = base ?? new Document({})
  const set = (key: string, value: unknown): void => {
    if (value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0) || value === '') document.delete(key)
    else document.set(key, value)
  }
  document.set('type', fields.type)
  document.set('status', fields.status)
  document.set('confidence', fields.confidence)
  document.set('source', fields.source)
  if (fields.sourceQuote === '' && fields.source === 'manual') document.delete('source_quote')
  else document.set('source_quote', fields.sourceQuote)
  document.set('created_at', isoSeconds(fields.createdAt))
  document.set('updated_at', isoSeconds(fields.updatedAt))
  set('review_after', fields.type === 'ongoing' ? fields.reviewAfter : null)
  set('supersedes', fields.supersedes.slice(0, SUPERSEDES_KEEP))
  set('proposal', fields.proposal)
  set('target', fields.proposal ? fields.target : null)
  set('auto_downgraded', fields.autoDowngraded)
  return `---\n${document.toString({ lineWidth: 0 })}---\n${body}\n`
}
