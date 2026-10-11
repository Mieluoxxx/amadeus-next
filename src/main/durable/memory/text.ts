import { createHash } from 'node:crypto'

// \u000B、\u000C 属于 \s，会被折成空格；其余控制字符直接丢弃，免得混进 YAML 或围栏。
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F]/g

export const fold = (text: string): string => text.replace(CONTROL, '').replace(/\s+/g, ' ').trim()

export const cpLength = (text: string): number => {
  let count = 0
  for (const _ of text) count += 1
  return count
}

export const truncateCp = (text: string, max: number): string => (cpLength(text) <= max ? text : Array.from(text).slice(0, max).join(''))

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// 系统追加的记录日期不计入 120 字，也不参与去重与哈希（崩溃重放跨午夜也要得到同一个 id）。
const RECORDED = /\s*\(recorded on \d{4}-\d{2}-\d{2}\)\s*$/
export const stripRecorded = (body: string): string => body.replace(RECORDED, '')
export const hasRecorded = (body: string): boolean => RECORDED.test(body)

export function normalizeBody(body: string): string {
  return stripRecorded(fold(body.normalize('NFKC'))).trim().replace(/[。.!！;；]+$/u, '').toLowerCase()
}

export const bodyHash = (body: string): string => sha256(normalizeBody(body))

/** 引用核对用：NFKC 后去掉所有空白与标点，只比较字面。 */
export const normalizeQuote = (text: string): string => text.normalize('NFKC').replace(/[\p{White_Space}\p{P}]/gu, '')

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/**
 * 引用的"份量"：CJK 每字算 1/4，其余每个词（字母数字连续段）算 1/3，加起来 ≥ 1 才够用来核对
 * （即 4 个 CJK 字，或 3 个词，或两者混合如"我喜欢 Rust"）。入参是折叠空白后的原引用，词界还在。
 */
export function quoteWeight(quote: string): number {
  const text = quote.normalize('NFKC')
  const cjk = text.match(CJK_CHAR)?.length ?? 0
  const words = text.replace(CJK_CHAR, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0
  return cjk / 4 + words / 3
}

const QUOTE_WINDOW = 3

/** 正文里有多大比例的字落在"与引用共有的 ≥ 3 字窗口"中（NFKC、去空白标点、忽略大小写；系统追加的记录日期不计）。 */
export function quoteCoverage(body: string, quote: string): number {
  const prepare = (text: string): string[] => Array.from(normalizeQuote(text).toLowerCase())
  const bodyChars = prepare(stripRecorded(body))
  const quoteChars = prepare(quote)
  if (bodyChars.length === 0) return 0
  const grams = new Set<string>()
  for (let index = 0; index + QUOTE_WINDOW <= quoteChars.length; index++) grams.add(quoteChars.slice(index, index + QUOTE_WINDOW).join(''))
  const covered = new Array<boolean>(bodyChars.length).fill(false)
  for (let index = 0; index + QUOTE_WINDOW <= bodyChars.length; index++) {
    if (!grams.has(bodyChars.slice(index, index + QUOTE_WINDOW).join(''))) continue
    for (let offset = 0; offset < QUOTE_WINDOW; offset++) covered[index + offset] = true
  }
  return covered.filter(Boolean).length / bodyChars.length
}

function trigrams(text: string): Set<string> {
  const chars = Array.from(text)
  if (chars.length === 0) return new Set()
  if (chars.length < 3) return new Set([chars.join('')])
  const grams = new Set<string>()
  for (let index = 0; index <= chars.length - 3; index++) grams.add(chars.slice(index, index + 3).join(''))
  return grams
}

/** 字符三元组 Jaccard；入参应已归一化。 */
export function jaccard(a: string, b: string): number {
  const left = trigrams(a)
  const right = trigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function localDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return localDate(new Date(year, month - 1, day + days).getTime())
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function parseTime(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 文本里的 FTS5 短语需要把双引号成对转义。 */
export const ftsPhrase = (text: string): string => `"${text.replace(/"/g, '""')}"`

/** 把查询切成三字窗口再 OR 起来：中文没有空格，整句当短语几乎命不中。 */
export function ftsTrigramQuery(text: string, maxGrams = 40): string | undefined {
  const chars = Array.from(fold(text).replace(/[\p{P}\p{S}]/gu, ' '))
  const grams = new Set<string>()
  for (let index = 0; index <= chars.length - 3 && grams.size < maxGrams; index++) {
    const gram = chars.slice(index, index + 3).join('')
    if (!gram.includes(' ')) grams.add(gram)
  }
  return grams.size === 0 ? undefined : [...grams].map(ftsPhrase).join(' OR ')
}
