import { DatabaseSync } from 'node:sqlite'
import type { Area, Confidence, InvalidFile, MemoryEntry, MemorySource, MemoryStatus, MemoryType, ProposalKind } from './types.ts'
import { ftsPhrase } from './text.ts'

const USER_VERSION = 1
const DAY = 86_400_000
export const REJECTION_BODY_TTL = 7 * DAY
const REJECTION_HASH_TTL = 365 * DAY
const AUDIT_TTL = 90 * DAY

// 派生表（meta、memory_fts、日记块）可由 Markdown 重建；账本表（rejections、audit、recall_log）不可重建，只能 ALTER 迁移。
// meta 比文档多 supersedes / auto_downgraded 两列：列表要展示"已降级"徽标，又不想为此逐个读文件。
const DERIVED = `
CREATE TABLE IF NOT EXISTS meta (
  id TEXT NOT NULL UNIQUE,
  area TEXT NOT NULL,
  type TEXT, status TEXT, confidence TEXT, source TEXT, source_quote TEXT,
  body TEXT, body_hash TEXT,
  created_at INTEGER, updated_at INTEGER, review_after TEXT,
  proposal TEXT, target TEXT,
  supersedes TEXT, auto_downgraded INTEGER,
  mtime_ms REAL NOT NULL, size INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS meta_body_hash ON meta(body_hash);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS journal_files (file TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT NOT NULL UNIQUE, date TEXT NOT NULL, file TEXT NOT NULL,
  topic TEXT, mood TEXT, cues TEXT, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_date ON chunks(date);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text, tokenize = 'trigram');
`

const LEDGERS = `
CREATE TABLE IF NOT EXISTS rejections (body_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT, rejected_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (at INTEGER NOT NULL, action TEXT NOT NULL, id TEXT, source TEXT, body_hash TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS recall_log (at INTEGER NOT NULL, mode TEXT NOT NULL, turn INTEGER, chunk_id TEXT, score REAL, injected INTEGER NOT NULL, body TEXT);
`

type Row = Record<string, unknown>

export type RejectionRow = { bodyHash: string; kind: 'rejected' | 'forgotten'; body: string | null; rejectedAt: number }
export type AuditRow = { at: number; action: string; id: string | null; source: string | null; bodyHash: string | null; detail: string | null }
export type Chunk = { id: string; date: string; file: string; topic: string; mood: string; cues: string; body: string }

function toEntry(row: Row): MemoryEntry {
  return {
    id: row.id as string,
    area: row.area as Area,
    type: row.type as MemoryType,
    status: row.status as MemoryStatus,
    confidence: row.confidence as Confidence,
    source: row.source as MemorySource,
    sourceQuote: (row.source_quote as string) ?? '',
    body: row.body as string,
    bodyHash: row.body_hash as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    reviewAfter: (row.review_after as string | null) ?? null,
    proposal: (row.proposal as ProposalKind | null) ?? null,
    target: (row.target as string | null) ?? null,
    supersedes: row.supersedes ? (JSON.parse(row.supersedes as string) as string[]) : [],
    autoDowngraded: row.auto_downgraded === 1,
    mtimeMs: row.mtime_ms as number,
    size: row.size as number,
  }
}

function toInvalid(row: Row): InvalidFile {
  const area = row.area as Area
  const id = row.id as string
  // 同名冲突的 archived 文件以 `archived/<名字>` 为 id，id 本身已带目录。
  const file = id.includes('/') ? `${id}.md` : area === 'archived' ? `archived/${id}.md` : `${id}.md`
  return { id, area, file, error: row.error as string, mtimeMs: row.mtime_ms as number, size: row.size as number }
}

export class IndexDb {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 2000')
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    this.db.exec(LEDGERS)
    // 版本变化只重建派生表；账本表此处按需 ALTER（目前只有 v1）。
    if (version !== USER_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS memory_fts; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS chunk_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS journal_files')
      this.db.exec(`PRAGMA user_version = ${USER_VERSION}`)
    }
    this.db.exec(DERIVED)
  }

  close(): void {
    this.db.close()
  }

  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params)
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 所有行（含无法解析的）的 id → (area, mtime, size)，供 reconcile 对账。 */
  fingerprints(): Map<string, { area: Area; mtimeMs: number; size: number }> {
    return new Map(this.all('SELECT id, area, mtime_ms, size FROM meta').map(row => [row.id as string, { area: row.area as Area, mtimeMs: row.mtime_ms as number, size: row.size as number }]))
  }

  entries(): MemoryEntry[] {
    return this.all('SELECT * FROM meta WHERE error IS NULL').map(toEntry)
  }

  entry(id: string): MemoryEntry | undefined {
    const row = this.get('SELECT * FROM meta WHERE id = ? AND error IS NULL', id)
    return row ? toEntry(row) : undefined
  }

  /** 无论是否可解析，凭 id 查到所在 area；IPC 的 id 一律先在这里查到再取路径。 */
  locate(id: string): { area: Area; invalid: boolean } | undefined {
    const row = this.get('SELECT area, error FROM meta WHERE id = ?', id)
    return row ? { area: row.area as Area, invalid: row.error !== null } : undefined
  }

  invalid(): InvalidFile[] {
    return this.all('SELECT id, area, error, mtime_ms, size FROM meta WHERE error IS NOT NULL ORDER BY id').map(toInvalid)
  }

  upsertEntry(entry: MemoryEntry): void {
    this.transaction(() => {
      const existing = this.get('SELECT rowid FROM meta WHERE id = ?', entry.id)
      const values = [
        entry.area, entry.type, entry.status, entry.confidence, entry.source, entry.sourceQuote, entry.body, entry.bodyHash,
        entry.createdAt, entry.updatedAt, entry.reviewAfter, entry.proposal, entry.target,
        JSON.stringify(entry.supersedes), entry.autoDowngraded ? 1 : 0, entry.mtimeMs, entry.size,
      ] as (string | number | null)[]
      let rowid: number
      if (existing) {
        rowid = existing.rowid as number
        this.run(
          `UPDATE meta SET area=?, type=?, status=?, confidence=?, source=?, source_quote=?, body=?, body_hash=?,
             created_at=?, updated_at=?, review_after=?, proposal=?, target=?, supersedes=?, auto_downgraded=?, mtime_ms=?, size=?, error=NULL
           WHERE id = ?`,
          ...values, entry.id,
        )
        this.run('DELETE FROM memory_fts WHERE rowid = ?', rowid)
      } else {
        this.run(
          `INSERT INTO meta (area, type, status, confidence, source, source_quote, body, body_hash,
             created_at, updated_at, review_after, proposal, target, supersedes, auto_downgraded, mtime_ms, size, id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ...values, entry.id,
        )
        rowid = (this.get('SELECT rowid FROM meta WHERE id = ?', entry.id) as Row).rowid as number
      }
      this.run('INSERT INTO memory_fts (rowid, body) VALUES (?, ?)', rowid, entry.body)
    })
  }

  upsertInvalid(invalid: InvalidFile): void {
    this.transaction(() => {
      const existing = this.get('SELECT rowid FROM meta WHERE id = ?', invalid.id)
      if (existing) {
        this.run('DELETE FROM memory_fts WHERE rowid = ?', existing.rowid as number)
        this.run(
          `UPDATE meta SET area=?, type=NULL, status=NULL, confidence=NULL, source=NULL, source_quote=NULL, body=NULL, body_hash=NULL,
             created_at=NULL, updated_at=NULL, review_after=NULL, proposal=NULL, target=NULL, supersedes=NULL, auto_downgraded=NULL,
             mtime_ms=?, size=?, error=? WHERE id = ?`,
          invalid.area, invalid.mtimeMs, invalid.size, invalid.error, invalid.id,
        )
      } else {
        this.run('INSERT INTO meta (id, area, mtime_ms, size, error) VALUES (?,?,?,?,?)', invalid.id, invalid.area, invalid.mtimeMs, invalid.size, invalid.error)
      }
    })
  }

  deleteMeta(id: string): void {
    this.transaction(() => {
      const existing = this.get('SELECT rowid FROM meta WHERE id = ?', id)
      if (!existing) return
      this.run('DELETE FROM memory_fts WHERE rowid = ?', existing.rowid as number)
      this.run('DELETE FROM meta WHERE id = ?', id)
    })
  }

  clearMeta(): void {
    this.transaction(() => {
      this.run('DELETE FROM memory_fts')
      this.run('DELETE FROM meta')
    })
  }

  /** `reviewed` 与 `unreviewed`（含 archived）按正文子串找；≥ 3 字走 FTS trigram，更短走 LIKE（trigram 对少于 3 字零命中）。 */
  searchBody(query: string, limit: number, ids?: ReadonlySet<string>): MemoryEntry[] {
    const rows =
      Array.from(query).length >= 3
        ? this.all(
            `SELECT meta.* FROM memory_fts JOIN meta ON meta.rowid = memory_fts.rowid
             WHERE memory_fts MATCH ? AND meta.error IS NULL ORDER BY rank LIMIT ?`,
            ftsPhrase(query), limit * 4,
          )
        : this.all(`SELECT * FROM meta WHERE error IS NULL AND body LIKE ? ESCAPE '\\' LIMIT ?`, `%${query.replace(/[\\%_]/g, '\\$&')}%`, limit * 4)
    const entries = rows.map(toEntry)
    return (ids ? entries.filter(entry => ids.has(entry.id)) : entries).slice(0, limit)
  }

  /** 宽松检索：任一三字窗口命中即可，只用来给 forget 凑候选，绝不据此自动删除。 */
  searchLoose(matchQuery: string, limit: number): MemoryEntry[] {
    return this.all(
      `SELECT meta.* FROM memory_fts JOIN meta ON meta.rowid = memory_fts.rowid
       WHERE memory_fts MATCH ? AND meta.error IS NULL ORDER BY rank LIMIT ?`,
      matchQuery, limit,
    ).map(toEntry)
  }

  rejection(hash: string): RejectionRow | undefined {
    const row = this.get('SELECT * FROM rejections WHERE body_hash = ?', hash)
    return row ? { bodyHash: row.body_hash as string, kind: row.kind as RejectionRow['kind'], body: (row.body as string | null) ?? null, rejectedAt: row.rejected_at as number } : undefined
  }

  /** 仍留着正文的拒绝记录（7 天内），供相似度比对与抽取提示词使用。 */
  recentRejections(limit = 200): RejectionRow[] {
    return this.all('SELECT * FROM rejections WHERE body IS NOT NULL ORDER BY rejected_at DESC LIMIT ?', limit).map(row => ({
      bodyHash: row.body_hash as string,
      kind: row.kind as RejectionRow['kind'],
      body: row.body as string,
      rejectedAt: row.rejected_at as number,
    }))
  }

  addRejection(hash: string, kind: RejectionRow['kind'], body: string, at: number): void {
    this.run('INSERT OR REPLACE INTO rejections (body_hash, kind, body, rejected_at) VALUES (?,?,?,?)', hash, kind, body, at)
  }

  deleteRejection(hash: string): void {
    this.run('DELETE FROM rejections WHERE body_hash = ?', hash)
  }

  audit(at: number, action: string, fields: { id?: string; source?: string; bodyHash?: string; detail?: string } = {}): void {
    this.run('INSERT INTO audit (at, action, id, source, body_hash, detail) VALUES (?,?,?,?,?,?)', at, action, fields.id ?? null, fields.source ?? null, fields.bodyHash ?? null, fields.detail ?? null)
  }

  countAudit(actions: readonly string[], source: string, since: number): number {
    const marks = actions.map(() => '?').join(',')
    const row = this.get(`SELECT COUNT(*) AS n FROM audit WHERE source = ? AND at >= ? AND action IN (${marks})`, source, since, ...actions)
    return (row?.n as number) ?? 0
  }

  latestAudit(action: string, filter: { bodyHash?: string; since?: number } = {}): AuditRow | undefined {
    const row = this.get(
      `SELECT * FROM audit WHERE action = ? AND (? IS NULL OR body_hash = ?) AND at >= ? ORDER BY at DESC, rowid DESC LIMIT 1`,
      action, filter.bodyHash ?? null, filter.bodyHash ?? null, filter.since ?? 0,
    )
    return row ? { at: row.at as number, action: row.action as string, id: (row.id as string | null) ?? null, source: (row.source as string | null) ?? null, bodyHash: (row.body_hash as string | null) ?? null, detail: (row.detail as string | null) ?? null } : undefined
  }

  /** 启动时清理：拒绝记录的正文只留 7 天，哈希留 365 天；审计留 90 天。 */
  prune(now: number): void {
    this.run('UPDATE rejections SET body = NULL WHERE body IS NOT NULL AND rejected_at < ?', now - REJECTION_BODY_TTL)
    this.run('DELETE FROM rejections WHERE rejected_at < ?', now - REJECTION_HASH_TTL)
    this.run('DELETE FROM audit WHERE at < ?', now - AUDIT_TTL)
    this.run('DELETE FROM recall_log WHERE at < ?', now - AUDIT_TTL)
  }

  // ---- 日记块（M3）----

  journalFingerprints(): Map<string, { mtimeMs: number; size: number }> {
    return new Map(this.all('SELECT * FROM journal_files').map(row => [row.file as string, { mtimeMs: row.mtime_ms as number, size: row.size as number }]))
  }

  replaceJournalFile(file: string, stat: { mtimeMs: number; size: number }, chunks: readonly Chunk[]): void {
    this.transaction(() => {
      this.dropJournalFileRows(file)
      this.run('INSERT OR REPLACE INTO journal_files (file, mtime_ms, size) VALUES (?,?,?)', file, stat.mtimeMs, stat.size)
      for (const chunk of chunks) {
        this.run('INSERT OR REPLACE INTO chunks (id, date, file, topic, mood, cues, body) VALUES (?,?,?,?,?,?,?)', chunk.id, chunk.date, file, chunk.topic, chunk.mood, chunk.cues, chunk.body)
        const { rowid } = this.get('SELECT rowid FROM chunks WHERE id = ?', chunk.id) as Row
        this.run('INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)', rowid as number, `${chunk.topic} ${chunk.body} ${chunk.cues}`)
      }
    })
  }

  deleteJournalFile(file: string): void {
    this.transaction(() => {
      this.dropJournalFileRows(file)
      this.run('DELETE FROM journal_files WHERE file = ?', file)
    })
  }

  private dropJournalFileRows(file: string): void {
    for (const row of this.all('SELECT rowid FROM chunks WHERE file = ?', file)) this.run('DELETE FROM chunk_fts WHERE rowid = ?', row.rowid as number)
    this.run('DELETE FROM chunks WHERE file = ?', file)
  }

  clearJournal(): void {
    this.transaction(() => {
      this.run('DELETE FROM chunk_fts')
      this.run('DELETE FROM chunks')
      this.run('DELETE FROM journal_files')
    })
  }

  /** 清空记忆时用：账本只留哈希与计数，日记原文（recall_log）和被拒绝 / 被忘掉的条目原文（rejections）不能留在磁盘上。 */
  scrubBodies(): void {
    this.transaction(() => {
      this.run('UPDATE recall_log SET body = NULL WHERE body IS NOT NULL')
      this.run('UPDATE rejections SET body = NULL WHERE body IS NOT NULL')
    })
  }

  searchChunks(matchQuery: string, limit: number): Chunk[] {
    return this.all(
      `SELECT chunks.* FROM chunk_fts JOIN chunks ON chunks.rowid = chunk_fts.rowid WHERE chunk_fts MATCH ? ORDER BY rank LIMIT ?`,
      matchQuery, limit,
    ).map(toChunk)
  }

  chunksSince(date: string, limit: number): Chunk[] {
    return this.all('SELECT * FROM chunks WHERE date >= ? ORDER BY date DESC, rowid DESC LIMIT ?', date, limit).map(toChunk)
  }

  logRecall(entry: { at: number; mode: string; turn: number | null; chunkId: string | null; score: number | null; injected: boolean; body: string | null }): void {
    this.run('INSERT INTO recall_log (at, mode, turn, chunk_id, score, injected, body) VALUES (?,?,?,?,?,?,?)', entry.at, entry.mode, entry.turn, entry.chunkId, entry.score, entry.injected ? 1 : 0, entry.body)
  }

  recallLog(limit: number): { at: number; mode: string; turn: number | null; chunkId: string | null; score: number | null; injected: boolean; body: string | null }[] {
    return this.all('SELECT * FROM recall_log ORDER BY at DESC, rowid DESC LIMIT ?', limit).map(row => ({
      at: row.at as number,
      mode: row.mode as string,
      turn: (row.turn as number | null) ?? null,
      chunkId: (row.chunk_id as string | null) ?? null,
      score: (row.score as number | null) ?? null,
      injected: row.injected === 1,
      body: (row.body as string | null) ?? null,
    }))
  }
}

function toChunk(row: Row): Chunk {
  return { id: row.id as string, date: row.date as string, file: row.file as string, topic: (row.topic as string) ?? '', mood: (row.mood as string) ?? '', cues: (row.cues as string) ?? '', body: row.body as string }
}
