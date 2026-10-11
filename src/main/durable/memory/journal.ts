import { randomBytes } from 'node:crypto'
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Chunk } from './indexdb.ts'
import { scan } from './redact.ts'
import type { MemoryStore } from './store.ts'
import { addDays, cpLength, fold, ftsTrigramQuery, isDateString, jaccard, localDate, normalizeBody, sha256, truncateCp } from './text.ts'
import { BODY_MAX } from './types.ts'

export type JournalSegment = { topic: string; mood: string; text: string; cues: string[] }

const SEGMENT_MAX = 3
const FILE = /^(\d{4}-\d{2}-\d{2})\.md$/
const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*\n/

const oneLine = (text: string): string => fold(text).replace(/^#+\s*/, '')

/** 日记只存主人愿意被想起的话：同样过敏感与结构扫描，超长截断，空段丢弃。 */
export function sanitizeSegments(raw: readonly JournalSegment[]): JournalSegment[] {
  const segments: JournalSegment[] = []
  for (const item of raw.slice(0, SEGMENT_MAX)) {
    const text = oneLine(String(item?.text ?? ''))
    if (text === '' || cpLength(text) > BODY_MAX) continue
    const topic = truncateCp(oneLine(String(item?.topic ?? '')), 60)
    const mood = truncateCp(oneLine(String(item?.mood ?? '')), 30)
    const cues = (Array.isArray(item?.cues) ? item.cues : []).map(cue => truncateCp(oneLine(String(cue)), 30)).filter(Boolean).slice(0, 6)
    // 结构类也按 explicit 的严格度拦：日记会被原样放进 prompt。
    if ([text, topic, mood, ...cues].some(part => scan(part, 'explicit'))) continue
    segments.push({ topic: topic || text.slice(0, 20), mood, text, cues })
  }
  return segments
}

export function parseJournal(date: string, raw: string): Chunk[] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const body = text.replace(FRONTMATTER, '')
  const chunks: Chunk[] = []
  for (const section of body.split(/^## /m).slice(1)) {
    const [heading, ...rest] = section.split('\n')
    let mood = ''
    let cues = ''
    const lines: string[] = []
    for (const line of rest) {
      if (/^mood:/i.test(line)) mood = fold(line.slice(5))
      else if (/^cues:/i.test(line)) cues = fold(line.slice(5))
      else if (line.trim() !== '') lines.push(fold(line))
    }
    const content = lines.join(' ').trim()
    if (content === '') continue
    chunks.push({ id: `${date}-${sha256(normalizeBody(content)).slice(0, 8)}`, date, file: `${date}.md`, topic: fold(heading), mood, cues, body: content })
  }
  return chunks
}

function renderJournal(date: string, chunks: readonly Chunk[]): string {
  const sections = chunks.map(chunk => [`## ${chunk.topic}`, ...(chunk.mood ? [`mood: ${chunk.mood}`] : []), ...(chunk.cues ? [`cues: ${chunk.cues}`] : []), chunk.body].join('\n'))
  return `---\ndate: ${date}\n---\n${sections.join('\n\n')}\n`
}

/** 对账 journal/：与 core/ 同样按 (mtime, size) 判断，变化则重建该日的块。 */
export function reconcileJournal(store: MemoryStore): Promise<void> {
  return store.run(() => reconcileLocked(store))
}

async function reconcileLocked(store: MemoryStore): Promise<void> {
  const known = store.db.journalFingerprints()
  const seen = new Set<string>()
  let names: string[] = []
  try {
    names = await readdir(store.journalDir)
  } catch {
    /* 目录不存在等同于没有日记 */
  }
  for (const name of names) {
    const match = FILE.exec(name)
    if (!match || !isDateString(match[1])) continue
    const file = path.join(store.journalDir, name)
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile()) continue
    seen.add(name)
    const fingerprint = known.get(name)
    if (fingerprint && fingerprint.mtimeMs === info.mtimeMs && fingerprint.size === info.size) continue
    const raw = await readFile(file, 'utf8').catch(() => undefined)
    if (raw === undefined) continue
    try {
      store.db.replaceJournalFile(name, info, parseJournal(match[1], raw))
    } catch (error) {
      // 一个日记文件索引失败不影响其余文件与核心记忆；指纹没更新，下次对账会再试。
      console.error(`[amadeus-next] journal ${name} could not be indexed:`, error)
    }
  }
  for (const name of known.keys()) if (!seen.has(name)) store.db.deleteJournalFile(name)
}

/** 把一批新段落并入当天的日记文件；已有的同义段落跳过，所以任务重跑是幂等的。 */
export function appendJournal(store: MemoryStore, date: string, segments: readonly JournalSegment[]): Promise<{ added: number }> {
  return store.run(async () => {
    const clean = sanitizeSegments(segments)
    if (clean.length === 0 || !isDateString(date)) return { added: 0 }
    const name = `${date}.md`
    const file = path.join(store.journalDir, name)
    const existing = await readFile(file, 'utf8').then(raw => parseJournal(date, raw), () => [] as Chunk[])
    const chunks = [...existing]
    let added = 0
    for (const segment of clean) {
      const norm = normalizeBody(segment.text)
      if (chunks.some(chunk => jaccard(normalizeBody(chunk.body), norm) >= 0.8)) continue
      chunks.push({ id: `${date}-${sha256(norm).slice(0, 8)}`, date, file: name, topic: segment.topic, mood: segment.mood, cues: segment.cues.join(', '), body: segment.text })
      added += 1
    }
    if (added === 0) return { added }
    const text = renderJournal(date, chunks)
    const tmp = path.join(store.journalDir, `.tmp-${randomBytes(6).toString('hex')}`)
    await writeFile(tmp, text, { mode: 0o600 })
    try {
      await rename(tmp, file)
    } catch (error) {
      await unlink(tmp).catch(() => rm(tmp, { force: true }))
      throw error
    }
    await reconcileLocked(store)
    store.db.audit(store.now(), 'journal', { detail: `${date}:${added}` })
    return { added }
  })
}

const CANDIDATES = 8
const FTS_SHARE = 6
const RECENT_DAYS = 2

/** FTS trigram 加最近 2 天的日记挑出最多 8 段（long-term-memory.md §6）；已注入过的不再进候选。 */
export async function journalCandidates(store: MemoryStore, input: string, exclude: ReadonlySet<string>): Promise<Chunk[]> {
  await reconcileJournal(store)
  const picked = new Map<string, Chunk>()
  const query = ftsTrigramQuery(input)
  if (query) for (const chunk of store.db.searchChunks(query, FTS_SHARE)) if (!exclude.has(chunk.id)) picked.set(chunk.id, chunk)
  const since = addDays(localDate(store.now()), -(RECENT_DAYS - 1))
  for (const chunk of store.db.chunksSince(since, CANDIDATES)) {
    if (picked.size >= CANDIDATES) break
    if (!exclude.has(chunk.id)) picked.set(chunk.id, chunk)
  }
  return [...picked.values()].slice(0, CANDIDATES)
}
