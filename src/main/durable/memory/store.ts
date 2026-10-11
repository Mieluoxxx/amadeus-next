import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { evaluate, isLive, queryOverlapsBody, rejectionKey, type GateInput, type GateWorld, type WritePlan } from './gate.ts'
import { IndexDb, REJECTION_BODY_TTL } from './indexdb.ts'
import { parseMemoryFile, renderFile, type FileFields, type ParsedFile } from './file.ts'
import { isInjectable, selectForSnapshot, type SnapshotSelection } from './render.ts'
import {
  SNAPSHOT_LIMIT,
  isMemoryType,
  type Area,
  type Confidence,
  type DropReason,
  type ErrorCode,
  type InvalidFile,
  type MemoryChange,
  type MemoryEntry,
  type MemorySource,
  type MemoryType,
  type Outcome,
  type ProposalKind,
} from './types.ts'
import { addDays, fold, ftsTrigramQuery, isDateString, localDate, normalizeBody, sha256 } from './text.ts'

const DAY = 86_400_000
const TRASH_TTL = 7 * DAY
const STALE_PROPOSAL = 30 * DAY
const UNREVIEWED_LIMIT = 50
const TMP_STALE = 60_000
const MAX_FILE_BYTES = 64 * 1024
const FORGET_PER_MINUTE = 3

export type StoreOptions = {
  dir: string
  now?: () => number
  onChange?: (change: MemoryChange) => void
}

export type WriteAction = 'created' | 'updated' | 'promoted' | 'exists'
export type WriteOk = { action: WriteAction; entry: MemoryEntry; similar: MemoryEntry[] }

export type PlanOp = {
  op: 'write' | 'update' | 'delete'
  id?: string
  type: MemoryType
  body: string
  confidence: Confidence
  source_quote: string
}

export type ApplyResult = { proposed: number; dropped: Record<string, number> }

export type ForgetOutcome =
  | { kind: 'forgot'; id: string; body: string }
  | { kind: 'gone' }
  | { kind: 'none' }
  | { kind: 'candidates'; items: { id: string; body: string }[] }

// truncated 给设置页用（有没有条目因预算没进快照）；条数另放 truncatedCount。
export type StoreStats = { reviewed: number; unreviewed: number; archived: number; invalid: number; due: number; snapshotBytes: number; snapshotLimit: number; truncated: boolean; truncatedCount: number }

export type ListItem = {
  id: string
  type: MemoryType
  status: 'reviewed' | 'unreviewed' | 'archived'
  body: string
  confidence: Confidence
  source: MemorySource
  sourceQuote: string
  createdAt: string
  updatedAt: string
  reviewAfter: string | null
  expired: boolean
  injected: boolean
  autoDowngraded: boolean
  proposal?: { kind: ProposalKind; targetId: string; targetBody: string }
}

const errorCode = (code: DropReason): ErrorCode => (code === 'rejected_before' || code === 'duplicate' || code === 'too_many' ? 'invalid' : code)
const fail = (code: ErrorCode, length?: number): Outcome<never> => ({ ok: false, code, ...(length === undefined ? {} : { length }) })
const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * Markdown 文件是唯一数据源，`index.sqlite3` 只是索引与账本。所有写操作进同一个异步互斥队列，
 * 读-改-写在队列内完成（long-term-memory.md §2.5）；业务失败一律返回 `{ ok: false, code }`，不 throw。
 */
export class MemoryStore {
  readonly dir: string
  readonly coreDir: string
  readonly archivedDir: string
  readonly journalDir: string
  readonly trashDir: string
  enabled = true
  db!: IndexDb

  readonly now: () => number
  private readonly onChange: (change: MemoryChange) => void
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(options: StoreOptions) {
    this.dir = options.dir
    this.coreDir = path.join(options.dir, 'core')
    this.archivedDir = path.join(this.coreDir, 'archived')
    this.journalDir = path.join(options.dir, 'journal')
    this.trashDir = path.join(options.dir, '.trash')
    this.now = options.now ?? Date.now
    this.onChange = options.onChange ?? (() => {})
  }

  /** 异步互斥：前一项失败不影响后一项。 */
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => {})
    return next
  }

  /** 初始化排在互斥队列最前：open 之前就到达的工具调用会等它完成，而不是撞上没建好的索引。 */
  open(): Promise<void> {
    const opened = this.tail.then(async () => {
      for (const directory of [this.archivedDir, this.journalDir]) await mkdir(directory, { recursive: true, mode: 0o700 })
      this.db = new IndexDb(path.join(this.dir, 'index.sqlite3'))
      await this.cleanTemporary()
      await this.purgeTrash()
      this.db.prune(this.now())
      await this.reconcileLocked(false)
      await this.archiveStaleLocked()
    })
    this.tail = opened.catch(() => {})
    return opened
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.tail.catch(() => {})
    this.db?.close()
  }

  emit(reason: MemoryChange['reason'], ids?: string[]): void {
    this.onChange({ reason, ...(ids && ids.length > 0 ? { ids } : {}) })
  }

  today(): string {
    return localDate(this.now())
  }

  entries(): MemoryEntry[] {
    return this.db.entries()
  }

  entry(id: unknown): MemoryEntry | undefined {
    return typeof id === 'string' ? this.db.entry(id) : undefined
  }

  selection(): SnapshotSelection {
    return selectForSnapshot(this.entries(), this.today())
  }

  private world(): GateWorld {
    const entries = this.entries()
    const now = this.now()
    return {
      enabled: this.enabled,
      now,
      entries: () => entries,
      rejection: hash => this.db.rejection(hash),
      recentRejections: () => this.db.recentRejections(),
      recentExplicitWrites: () => this.db.countAudit(['create', 'update', 'promote'], 'explicit', now - 60_000),
    }
  }

  reconcile(notify = true): Promise<boolean> {
    return this.run(() => this.reconcileLocked(notify))
  }

  private reviewedSignature(): string {
    return JSON.stringify(
      this.entries()
        .filter(isLive)
        .map(entry => [entry.id, entry.type, entry.body, entry.reviewAfter])
        .sort(),
    )
  }

  /** 返回"reviewed 集合是否变化"；任何索引变化都会通知设置页刷新。 */
  private async reconcileLocked(notify: boolean): Promise<boolean> {
    const before = this.reviewedSignature()
    const known = this.db.fingerprints()
    const seen = new Set<string>()
    const touched: string[] = []
    for (const area of ['core', 'archived'] as const) {
      const directory = area === 'core' ? this.coreDir : this.archivedDir
      let names: string[]
      try {
        names = await readdir(directory)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.startsWith('.') || !name.endsWith('.md')) continue
        const file = path.join(directory, name)
        let info
        try {
          // lstat：符号链接不是常规文件，跳过——否则一个指向别处的链接会把任意文件读进 prompt。
          info = await lstat(file)
        } catch {
          continue
        }
        if (!info.isFile()) continue
        const id = name.slice(0, -3)
        // 两个 area 出现同名文件：core 优先，archived 的那份只作为"无法解析"列出，不进索引主体。
        const key = seen.has(id) ? `${area}/${id}` : id
        seen.add(key)
        const known1 = known.get(key)
        if (known1 && known1.area === area && known1.mtimeMs === info.mtimeMs && known1.size === info.size) continue
        // 展示用的文件名由 IndexDb 按 area 与 id 推出，这里的 file 只是为了满足类型。
        const invalid = (error: string): InvalidFile => ({ id: key, area, file: `${key}.md`, error, mtimeMs: info.mtimeMs, size: info.size })
        if (info.size > MAX_FILE_BYTES) {
          this.db.upsertInvalid(invalid('文件过大（超过 64KB），不会读取'))
        } else if (key !== id) {
          this.db.upsertInvalid(invalid(`与 core 中的同名文件冲突：${id}.md`))
        } else {
          let raw: string
          try {
            raw = await readFile(file, 'utf8')
          } catch {
            seen.delete(key)
            continue
          }
          try {
            this.indexParsed(parseMemoryFile(id, area, raw, info))
          } catch (error) {
            // 一个文件的意外失败不能让整个记忆服务起不来：把它列为无法解析，其余照常。
            this.db.upsertInvalid(invalid(`文件无法处理：${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`))
          }
        }
        touched.push(key)
      }
    }
    for (const id of known.keys()) {
      if (seen.has(id)) continue
      this.db.deleteMeta(id)
      this.db.audit(this.now(), 'external', { id, detail: 'removed' })
      touched.push(id)
    }
    const changed = before !== this.reviewedSignature()
    if (notify && touched.length > 0) this.emit('external', touched)
    return changed
  }

  private indexParsed(parsed: ParsedFile): void {
    if (parsed.entry) this.db.upsertEntry(parsed.entry)
    else if (parsed.invalid) this.db.upsertInvalid(parsed.invalid)
  }

  private pathOf(area: Area, id: string): string {
    return path.join(area === 'archived' ? this.archivedDir : this.coreDir, `${id}.md`)
  }

  private async cleanTemporary(): Promise<void> {
    const cutoff = this.now() - TMP_STALE
    for (const directory of [this.coreDir, this.archivedDir, this.journalDir]) {
      let names: string[]
      try {
        names = await readdir(directory)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.startsWith('.tmp-')) continue
        const file = path.join(directory, name)
        const info = await stat(file).catch(() => undefined)
        if (info && info.mtimeMs < cutoff) await rm(file, { force: true })
      }
    }
  }

  private async purgeTrash(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.trashDir)
    } catch {
      return
    }
    const now = this.now()
    for (const name of names) {
      const file = path.join(this.trashDir, name)
      // 单条是 `<毫秒>-<id>.md`，清空的整桶是 `<毫秒>/`。
      const stamp = Number(/^(\d{10,})(?:-|$)/.exec(name)?.[1])
      const at = Number.isFinite(stamp) ? stamp : (await stat(file).catch(() => undefined))?.mtimeMs
      if (at !== undefined && now - at > TRASH_TTL) await rm(file, { recursive: true, force: true })
    }
  }

  /** 先写同目录临时文件再替换目标，读者永远看不到半截文件。 */
  private async writeTemp(directory: string, text: string): Promise<string> {
    const tmp = path.join(directory, `.tmp-${randomBytes(6).toString('hex')}`)
    await writeFile(tmp, text, { mode: 0o600 })
    return tmp
  }

  /** 新建：目标已存在则 EEXIST，绝不覆盖；文件系统不支持硬链接时退到排他创建。 */
  private async linkNew(tmp: string, target: string, text: string): Promise<'ok' | 'exists'> {
    try {
      await link(tmp, target)
      await rm(tmp, { force: true })
      return 'ok'
    } catch (error) {
      await rm(tmp, { force: true })
      if (errnoOf(error) === 'EEXIST') return 'exists'
      try {
        await writeFile(target, text, { flag: 'wx', mode: 0o600 })
        return 'ok'
      } catch (inner) {
        if (errnoOf(inner) === 'EEXIST') return 'exists'
        throw inner
      }
    }
  }

  private async readEntry(area: Area, id: string): Promise<{ parsed: ParsedFile; info: { mtimeMs: number; size: number } } | undefined> {
    const file = this.pathOf(area, id)
    try {
      const info = await stat(file)
      const raw = await readFile(file, 'utf8')
      return { parsed: parseMemoryFile(id, area, raw, info), info }
    } catch {
      return undefined
    }
  }

  private async createFile(fields: FileFields, body: string, idBase: string): Promise<Outcome<{ entry: MemoryEntry }>> {
    const text = renderFile(fields, body)
    for (let attempt = 1; attempt <= 50; attempt++) {
      const id = attempt === 1 ? idBase : `${idBase}-${attempt}`
      if (this.db.locate(id)) continue
      const target = this.pathOf('core', id)
      const tmp = await this.writeTemp(this.coreDir, text)
      let result: 'ok' | 'exists'
      try {
        result = await this.linkNew(tmp, target, text)
      } catch {
        return fail('io')
      }
      if (result === 'exists') continue
      const loaded = await this.readEntry('core', id)
      if (!loaded?.parsed.entry) return fail('io')
      this.db.upsertEntry(loaded.parsed.entry)
      return { ok: true, entry: loaded.parsed.entry }
    }
    return fail('io')
  }

  /**
   * 覆盖既有文件：读取、计算、写临时文件，再核对 (mtime, size) 没变才替换；
   * 与外部编辑竞争时重读重算一次，仍不同则返回 conflict_external，不覆盖主人的改动。
   */
  private async rewrite(
    entry: MemoryEntry,
    change: (current: MemoryEntry) => { fields: FileFields; body: string },
    destArea: Area = entry.area,
  ): Promise<Outcome<{ entry: MemoryEntry }>> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const loaded = await this.readEntry(entry.area, entry.id)
      if (!loaded?.parsed.entry) return fail('conflict_external')
      const { fields, body } = change(loaded.parsed.entry)
      const text = renderFile(fields, body, loaded.parsed.document)
      const from = this.pathOf(entry.area, entry.id)
      const to = this.pathOf(destArea, entry.id)
      const tmp = await this.writeTemp(destArea === 'archived' ? this.archivedDir : this.coreDir, text)
      const after = await stat(from).catch(() => undefined)
      if (!after || after.mtimeMs !== loaded.info.mtimeMs || after.size !== loaded.info.size) {
        await rm(tmp, { force: true })
        if (attempt === 1) continue
        return fail('conflict_external')
      }
      try {
        if (from === to) {
          await rename(tmp, to)
        } else {
          const moved = await this.linkNew(tmp, to, text)
          if (moved === 'exists') return fail('conflict_external')
          await unlink(from)
        }
      } catch {
        await rm(tmp, { force: true })
        return fail('io')
      }
      const written = await this.readEntry(destArea, entry.id)
      if (!written?.parsed.entry) return fail('io')
      this.db.upsertEntry(written.parsed.entry)
      return { ok: true, entry: written.parsed.entry }
    }
    return fail('conflict_external')
  }

  /** 删除与清空都先进 .trash/ 保留 7 天；文件已被外部删掉时只清索引。 */
  private async trash(entry: { id: string; area: Area }): Promise<void> {
    await mkdir(this.trashDir, { recursive: true, mode: 0o700 })
    const now = this.now()
    for (let suffix = 0; ; suffix++) {
      const target = path.join(this.trashDir, `${now}-${entry.id}${suffix === 0 ? '' : `-${suffix}`}.md`)
      try {
        await link(this.pathOf(entry.area, entry.id), target)
        await unlink(this.pathOf(entry.area, entry.id))
        break
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') continue
        if (errnoOf(error) === 'ENOENT') break
        // 不支持硬链接：直接改名，目标重名的概率可以忽略。
        await rename(this.pathOf(entry.area, entry.id), target).catch(() => {})
        break
      }
    }
    this.db.deleteMeta(entry.id)
  }

  private fieldsOf(entry: MemoryEntry, overrides: Partial<FileFields> = {}): FileFields {
    return {
      type: entry.type,
      status: entry.status,
      confidence: entry.confidence,
      source: entry.source,
      sourceQuote: entry.sourceQuote,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      reviewAfter: entry.reviewAfter,
      proposal: entry.proposal,
      target: entry.target,
      supersedes: entry.supersedes,
      autoDowngraded: entry.autoDowngraded,
      ...overrides,
    }
  }

  /** 抽取超限时不拒绝，而是把最旧的待确认条目归档，给新提议腾地方。 */
  private async makeRoom(): Promise<void> {
    for (;;) {
      const pending = this.entries().filter(entry => entry.area === 'core' && entry.status === 'unreviewed')
      if (pending.length < UNREVIEWED_LIMIT) return
      const oldest = pending.sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))[0]
      if (!(await this.archiveOne(oldest))) return
    }
  }

  private async archiveOne(entry: MemoryEntry): Promise<boolean> {
    const result = await this.rewrite(entry, current => ({ fields: this.fieldsOf(current), body: current.body }), 'archived')
    if (!result.ok) return false
    this.db.audit(this.now(), 'archive', { id: entry.id, bodyHash: entry.bodyHash })
    return true
  }

  private async archiveStaleLocked(): Promise<void> {
    const cutoff = this.now() - STALE_PROPOSAL
    for (const entry of this.entries()) {
      if (entry.area === 'core' && entry.status === 'unreviewed' && entry.updatedAt < cutoff) await this.archiveOne(entry)
    }
  }

  archiveStale(): Promise<void> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      await this.archiveStaleLocked()
    })
  }

  private async applyWrite(plan: WritePlan, input: { source: MemorySource }): Promise<Outcome<WriteOk>> {
    const now = this.now()
    const { source } = input
    let result: Outcome<WriteOk>
    if (plan.action === 'exists' && plan.target) {
      return { ok: true, action: 'exists', entry: plan.target, similar: [] }
    }
    if (plan.action === 'create') {
      if (plan.needsRoom) await this.makeRoom()
      const fields: FileFields = {
        type: plan.type,
        status: plan.status,
        confidence: plan.confidence,
        source: plan.source,
        sourceQuote: plan.sourceQuote,
        createdAt: now,
        updatedAt: now,
        reviewAfter: plan.reviewAfter,
        proposal: plan.proposal?.kind ?? null,
        target: plan.proposal?.target ?? null,
        supersedes: [],
        autoDowngraded: plan.autoDowngraded,
      }
      // 提议的 id 带上种类与目标：remove 提议的正文就是目标条目的原文，只靠正文哈希会与目标重名。
      const salt = plan.proposal ? sha256(`${plan.proposal.kind}:${plan.proposal.target}:${normalizeBody(plan.body)}`) : plan.bodyHash
      const created = await this.createFile(fields, plan.body, `${plan.type}-${salt.slice(0, 8)}`)
      if (!created.ok) return created
      this.db.audit(now, 'create', { id: created.entry.id, source, bodyHash: plan.bodyHash })
      result = { ok: true, action: 'created', entry: created.entry, similar: plan.similar }
    } else {
      const target = plan.target as MemoryEntry
      const promoted = !isLive(target) && plan.status === 'reviewed'
      const bodyChanged = plan.bodyHash !== target.bodyHash || (plan.editing === true && plan.body !== target.body)
      const destArea: Area = promoted ? 'core' : target.area
      const updated = await this.rewrite(
        target,
        current => ({
          body: bodyChanged ? plan.body : current.body,
          fields: this.fieldsOf(current, {
            type: plan.editing ? plan.type : current.type,
            status: plan.status,
            updatedAt: now,
            reviewAfter: (plan.editing ? plan.type : current.type) === 'ongoing' ? plan.reviewAfter ?? current.reviewAfter : null,
            supersedes: bodyChanged ? [current.body, ...current.supersedes].slice(0, 3) : current.supersedes,
            ...(plan.editing
              ? {}
              : {
                  source: plan.source,
                  sourceQuote: plan.sourceQuote || current.sourceQuote,
                  confidence: plan.confidence,
                  autoDowngraded: plan.autoDowngraded,
                  proposal: null,
                  target: null,
                }),
          }),
        }),
        destArea,
      )
      if (!updated.ok) return updated
      const action = promoted && !bodyChanged ? 'promoted' : 'updated'
      this.db.audit(now, action === 'promoted' ? 'promote' : 'update', { id: target.id, source, bodyHash: plan.bodyHash })
      result = { ok: true, action, entry: updated.entry, similar: [] }
    }
    this.clearRejections(plan, source)
    return result
  }

  remember(args: { type: unknown; body: unknown; source_quote: unknown }, userTurns: readonly string[]): Promise<Outcome<WriteOk>> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      const gated = evaluate({ source: 'explicit', type: args.type, body: args.body, sourceQuote: args.source_quote, userTurns }, this.world())
      if (!gated.ok) return fail(errorCode(gated.code), gated.length)
      const written = await this.applyWrite(gated.plan, { source: 'explicit' })
      if (written.ok && written.action !== 'exists') this.emit('tool', [written.entry.id])
      return written
    })
  }

  write(params: { id?: unknown; type?: unknown; body?: unknown; reviewAfter?: unknown }): Promise<Outcome<{ entry: MemoryEntry; action: WriteAction }>> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      if (params.id === undefined) {
        const gated = evaluate({ source: 'manual', type: params.type, body: params.body, reviewAfter: params.reviewAfter }, this.world())
        if (!gated.ok) return fail(errorCode(gated.code), gated.length)
        const written = await this.applyWrite(gated.plan, { source: 'manual' })
        if (written.ok && written.action !== 'exists') this.emit('manual', [written.entry.id])
        return written.ok ? { ok: true, entry: written.entry, action: written.action } : written
      }

      const current = this.entry(params.id)
      if (!current) return fail('not_found')
      const type = params.type === undefined ? current.type : params.type
      if (!isMemoryType(type)) return fail('invalid')
      const body = params.body === undefined ? current.body : params.body
      if (typeof body !== 'string') return fail('empty')
      const reviewAfterGiven = params.reviewAfter !== undefined && params.reviewAfter !== null
      if (reviewAfterGiven && !isDateString(params.reviewAfter)) return fail('invalid')

      const sameText = fold(body) === current.body && type === current.type
      // 只改 reviewAfter（"仍然成立"）时正文不变，不重新过扫描：那可能是主人手写、规则不认的内容。
      const gated = sameText ? undefined : evaluate({ source: 'manual', type, body, reviewAfter: params.reviewAfter, editing: current }, this.world())
      if (gated && !gated.ok) return fail(errorCode(gated.code), gated.length)
      const plan = gated?.ok ? gated.plan : undefined

      const nextBody = plan?.body ?? current.body
      const nextAfter = type === 'ongoing' ? (plan?.reviewAfter ?? (reviewAfterGiven ? (params.reviewAfter as string) : current.reviewAfter)) : null
      if (nextBody === current.body && type === current.type && nextAfter === current.reviewAfter) return { ok: true, entry: current, action: 'exists' }

      const now = this.now()
      const updated = await this.rewrite(current, latest => ({
        body: nextBody,
        fields: this.fieldsOf(latest, {
          type,
          updatedAt: now,
          reviewAfter: nextAfter,
          supersedes: nextBody === latest.body ? latest.supersedes : [latest.body, ...latest.supersedes].slice(0, 3),
        }),
      }))
      if (!updated.ok) return updated
      this.clearRejections(plan, 'manual')
      this.db.audit(now, 'update', { id: current.id, source: 'manual', bodyHash: updated.entry.bodyHash })
      this.emit('manual', [current.id])
      return { ok: true, entry: updated.entry, action: 'updated' }
    })
  }

  /** 主人改了主意：亲口写的内容优先于自动提议的拒绝。 */
  private clearRejections(plan: WritePlan | undefined, source: MemorySource): void {
    for (const hash of plan?.clearRejections ?? []) {
      this.db.deleteRejection(hash)
      this.db.audit(this.now(), 'unreject', { bodyHash: hash, source })
    }
  }

  delete(id: unknown): Promise<Outcome> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      const found = typeof id === 'string' && !id.includes('/') ? this.db.locate(id) : undefined
      if (!found || typeof id !== 'string') return fail('not_found')
      const entry = this.db.entry(id)
      await this.trash({ id, area: found.area })
      this.db.audit(this.now(), 'delete', { id, ...(entry ? { bodyHash: entry.bodyHash } : {}) })
      this.emit('manual', [id])
      return { ok: true }
    })
  }

  reject(id: unknown): Promise<Outcome> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      const entry = this.entry(id)
      if (!entry) return fail('not_found')
      if (entry.status !== 'unreviewed') return fail('invalid')
      const key = rejectionKey(entry.bodyHash, normalizeBody(entry.body), entry.proposal && entry.target ? { kind: entry.proposal, target: { id: entry.target } } : undefined)
      const now = this.now()
      this.db.addRejection(key, 'rejected', entry.body, now)
      await this.trash(entry)
      this.db.audit(now, 'reject', { id: entry.id, source: entry.source, bodyHash: key })
      this.emit('manual', [entry.id])
      return { ok: true }
    })
  }

  accept(id: unknown, edit: { type?: unknown; body?: unknown; reviewAfter?: unknown } = {}): Promise<Outcome<{ entry?: MemoryEntry; removed?: string }>> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      const proposal = this.entry(id)
      if (!proposal) return fail('not_found')
      if (proposal.status !== 'unreviewed') return fail('invalid')
      const now = this.now()

      if (proposal.proposal === 'remove') {
        const targetEntry = proposal.target ? this.entry(proposal.target) : undefined
        if (targetEntry) await this.trash(targetEntry)
        await this.trash(proposal)
        this.db.audit(now, 'accept', { id: proposal.id, source: proposal.source, detail: `remove:${proposal.target}` })
        this.emit('manual', [proposal.id, ...(proposal.target ? [proposal.target] : [])])
        return { ok: true, removed: proposal.target ?? proposal.id }
      }

      let type: MemoryType = proposal.type
      let body = proposal.body
      let reviewAfter = proposal.reviewAfter
      const edited = edit.type !== undefined || edit.body !== undefined || edit.reviewAfter !== undefined
      if (edited) {
        const gated = evaluate(
          { source: 'manual', type: edit.type ?? proposal.type, body: edit.body ?? proposal.body, reviewAfter: edit.reviewAfter, editing: proposal },
          this.world(),
        )
        if (!gated.ok) return fail(errorCode(gated.code), gated.length)
        type = gated.plan.type
        body = gated.plan.body
        reviewAfter = gated.plan.reviewAfter
        this.clearRejections(gated.plan, 'manual')
      }
      if (type === 'ongoing' && reviewAfter === null) reviewAfter = addDays(this.today(), 30)

      const target = proposal.proposal === 'replace' && proposal.target ? this.entry(proposal.target) : undefined
      if (target) {
        const replaced = await this.rewrite(target, latest => ({
          body,
          fields: this.fieldsOf(latest, {
            type,
            updatedAt: now,
            reviewAfter: type === 'ongoing' ? reviewAfter : null,
            supersedes: [latest.body, ...latest.supersedes].slice(0, 3),
          }),
        }))
        if (!replaced.ok) return replaced
        await this.trash(proposal)
        this.db.audit(now, 'accept', { id: proposal.id, source: proposal.source, detail: `replace:${target.id}` })
        this.emit('manual', [proposal.id, target.id])
        return { ok: true, entry: replaced.entry }
      }

      if (this.entries().filter(isLive).length >= 200) return fail('limit')
      const accepted = await this.rewrite(
        proposal,
        latest => ({
          body,
          fields: this.fieldsOf(latest, {
            type,
            status: 'reviewed',
            updatedAt: now,
            reviewAfter: type === 'ongoing' ? reviewAfter : null,
            proposal: null,
            target: null,
            supersedes: body === latest.body ? latest.supersedes : [latest.body, ...latest.supersedes].slice(0, 3),
          }),
        }),
        'core',
      )
      if (!accepted.ok) return accepted
      this.db.audit(now, 'accept', { id: proposal.id, source: proposal.source, bodyHash: accepted.entry.bodyHash })
      this.emit('manual', [proposal.id])
      return { ok: true, entry: accepted.entry }
    })
  }

  clear(): Promise<Outcome<{ trashed: number }>> {
    return this.run(async () => {
      await this.reconcileLocked(false)
      const now = this.now()
      let trashed = 0
      const count = async (directory: string): Promise<number> => {
        const names = await readdir(directory).catch(() => [] as string[])
        return names.filter(name => !name.startsWith('.') && name.endsWith('.md')).length
      }
      trashed += (await count(this.coreDir)) + (await count(this.archivedDir)) + (await count(this.journalDir))
      const bucket = path.join(this.trashDir, String(now))
      await mkdir(bucket, { recursive: true, mode: 0o700 })
      try {
        await rename(this.coreDir, path.join(bucket, 'core'))
        await rename(this.journalDir, path.join(bucket, 'journal'))
      } catch {
        return fail('io')
      } finally {
        for (const directory of [this.archivedDir, this.journalDir]) await mkdir(directory, { recursive: true, mode: 0o700 })
      }
      this.db.clearMeta()
      this.db.clearJournal()
      this.db.scrubBodies()
      this.db.audit(now, 'clear', { detail: String(trashed) })
      this.emit('clear')
      return { ok: true, trashed }
    })
  }

  /**
   * `candidateIds`：本会话上一次 forget 返回过的候选 id（由工具在 commit 里读回）。带 id 删除必须在其中，或 query 与该条正文有字面重叠。
   * 限流放在真正删除处：崩溃重放时上一次已经完成的删除走"10 分钟内已忘掉"分支，不会被限流误伤。
   */
  forget(args: { query: unknown; id?: unknown }, candidateIds: ReadonlySet<string> = new Set()): Promise<Outcome<{ result: ForgetOutcome }>> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      if (!this.enabled) return fail('disabled')
      const now = this.now()
      const remove = async (entry: MemoryEntry): Promise<Outcome<{ result: ForgetOutcome }>> => {
        if (this.db.countAudit(['forget'], 'explicit', now - 60_000) >= FORGET_PER_MINUTE) return fail('limit')
        this.db.addRejection(entry.bodyHash, 'forgotten', entry.body, now)
        await this.trash(entry)
        this.db.audit(now, 'forget', { id: entry.id, source: 'explicit', bodyHash: entry.bodyHash })
        this.emit('tool', [entry.id])
        return { ok: true, result: { kind: 'forgot', id: entry.id, body: entry.body } }
      }

      if (typeof args.id === 'string' && args.id.trim() !== '') {
        const id = args.id.trim()
        const entry = this.entry(id)
        if (!entry) return { ok: true, result: { kind: 'gone' } }
        const said = typeof args.query === 'string' ? fold(args.query) : ''
        if (!candidateIds.has(id) && !queryOverlapsBody(said, entry.body)) return fail('unconfirmed')
        return remove(entry)
      }

      const query = typeof args.query === 'string' ? fold(args.query) : ''
      if (query === '') return fail('empty')
      const norm = normalizeBody(query)
      const all = this.entries()
      const exact = all.filter(entry => entry.bodyHash === sha256(norm))
      if (exact.length > 0) return remove(exact.find(isLive) ?? exact[0])

      const hits = this.db.searchBody(query, 5)
      if (hits.length === 1) return remove(hits[0])
      if (hits.length > 1) return { ok: true, result: { kind: 'candidates', items: hits.slice(0, 3).map(entry => ({ id: entry.id, body: entry.body })) } }

      // 零命中时先看上一次执行是否已经完成（崩溃重放安全）：10 分钟内同样的内容已被忘掉，就原样回报成功。
      for (const row of this.db.recentRejections()) {
        if (row.kind !== 'forgotten' || row.body === null || now - row.rejectedAt > 10 * 60_000) continue
        const forgotten = normalizeBody(row.body)
        if (forgotten === norm || forgotten.includes(norm)) {
          const id = this.db.latestAudit('forget', { bodyHash: row.bodyHash, since: now - 10 * 60_000 })?.id ?? ''
          return { ok: true, result: { kind: 'forgot', id, body: row.body } }
        }
      }
      // 模型常把"偏好"说成"喜欢"：整句子串找不到时，用三字窗口宽松凑几个候选让它去问主人，绝不据此自动删除。
      const loose = ftsTrigramQuery(query)
      const candidates = loose ? this.db.searchLoose(loose, 3) : []
      if (candidates.length > 0) return { ok: true, result: { kind: 'candidates', items: candidates.map(entry => ({ id: entry.id, body: entry.body })) } }
      return { ok: true, result: { kind: 'none' } }
    })
  }

  /**
   * 应用抽取任务的计划（long-term-memory.md §5.2）。引用已在抽取阶段按窗口核对过，这里只过闸门其余各步。
   * 幂等靠内容：id 来自正文哈希，已存在且相同的提议直接跳过。
   */
  applyPlan(ops: readonly PlanOp[]): Promise<ApplyResult> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      await this.archiveStaleLocked()
      const dropped: Record<string, number> = {}
      const drop = (reason: string): void => {
        dropped[reason] = (dropped[reason] ?? 0) + 1
      }
      const touched: string[] = []
      let proposed = 0
      for (const op of ops) {
        const target = this.entry(op.id)
        const base: GateInput = { source: 'extracted', type: op.type, body: op.body, sourceQuote: op.source_quote, confidence: op.confidence, userTurns: 'trusted' }
        let input: GateInput | undefined = base
        if (op.op === 'update' && target && !target.proposal) {
          input = isLive(target) ? { ...base, proposal: { kind: 'replace', target } } : { ...base, editing: target }
        } else if (op.op === 'delete') {
          if (!target || target.proposal) {
            drop('invalid')
            continue
          }
          if (!isLive(target)) {
            // 撤回尚未确认的提议：不写拒绝记忆，主人从没认可过它。
            await this.trash(target)
            this.db.audit(this.now(), 'delete', { id: target.id, source: 'extracted', bodyHash: target.bodyHash })
            touched.push(target.id)
            continue
          }
          input = { ...base, type: target.type, body: target.body, proposal: { kind: 'remove', target } }
        }
        const gated = evaluate(input, this.world())
        if (!gated.ok) {
          drop(gated.code)
          continue
        }
        const written = await this.applyWrite(gated.plan, { source: 'extracted' })
        if (!written.ok) {
          drop(written.code)
          continue
        }
        if (written.action === 'created' || written.action === 'updated') {
          proposed += 1
          touched.push(written.entry.id)
        }
      }
      if (touched.length > 0) this.emit('extract', touched)
      return { proposed, dropped }
    })
  }

  list(): Promise<{ items: ListItem[]; invalid: InvalidFile[]; stats: StoreStats }> {
    return this.run(async () => {
      await this.reconcileLocked(true)
      return this.snapshotList()
    })
  }

  private snapshotList(): { items: ListItem[]; invalid: InvalidFile[]; stats: StoreStats } {
    const today = this.today()
    const entries = this.entries()
    const selection = selectForSnapshot(entries, today)
    const injected = new Set(selection.items.map(item => item.id))
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    const rank = { feedback: 0, relationship: 1, preference: 2, profile: 3, ongoing: 4 } as const
    const confidenceRank = { high: 0, medium: 1, low: 2 } as const
    const items = entries.map((entry): ListItem => {
      const targetEntry = entry.target ? byId.get(entry.target) : undefined
      return {
        id: entry.id,
        type: entry.type,
        status: entry.area === 'archived' ? 'archived' : entry.status,
        body: entry.body,
        confidence: entry.confidence,
        source: entry.source,
        sourceQuote: entry.sourceQuote,
        createdAt: new Date(entry.createdAt).toISOString(),
        updatedAt: new Date(entry.updatedAt).toISOString(),
        reviewAfter: entry.reviewAfter,
        expired: isLive(entry) && entry.type === 'ongoing' && !isInjectable(entry, today),
        injected: injected.has(entry.id),
        autoDowngraded: entry.autoDowngraded,
        ...(entry.proposal && entry.target ? { proposal: { kind: entry.proposal, targetId: entry.target, targetBody: targetEntry?.body ?? '' } } : {}),
      }
    })
    const order = { reviewed: 0, unreviewed: 1, archived: 2 } as const
    items.sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        (a.status === 'reviewed' ? rank[a.type] - rank[b.type] : confidenceRank[a.confidence] - confidenceRank[b.confidence]) ||
        (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
        (a.id < b.id ? -1 : 1),
    )
    const invalid = this.db.invalid()
    return {
      items,
      invalid,
      stats: {
        reviewed: items.filter(item => item.status === 'reviewed').length,
        unreviewed: items.filter(item => item.status === 'unreviewed').length,
        archived: items.filter(item => item.status === 'archived').length,
        invalid: invalid.length,
        due: items.filter(item => item.expired).length,
        snapshotBytes: selection.bytes,
        snapshotLimit: SNAPSHOT_LIMIT,
        truncated: selection.truncated > 0,
        truncatedCount: selection.truncated,
      },
    }
  }

  stats(): StoreStats {
    return this.snapshotList().stats
  }

  item(id: string): ListItem | undefined {
    return this.snapshotList().items.find(item => item.id === id)
  }

  recentRejectionBodies(limit: number): string[] {
    const cutoff = this.now() - REJECTION_BODY_TTL
    return this.db
      .recentRejections(limit * 2)
      .filter(row => row.rejectedAt >= cutoff && row.body)
      .slice(0, limit)
      .map(row => row.body as string)
  }

  lastExtractRun(): { at: number; detail: string } | undefined {
    const row = this.db.latestAudit('extract-run')
    return row?.detail ? { at: row.at, detail: row.detail } : undefined
  }

  recordExtractRun(detail: unknown): void {
    this.db.audit(this.now(), 'extract-run', { detail: JSON.stringify(detail) })
  }
}
