import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defineDoc } from '@earendil-works/pi-durable'
import type { TitleSource } from './sessionName.ts'

export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** 会话库里的 `app.session`：索引丢失时，靠它从各库重建（architecture §2.1）。 */
export const SessionDoc = defineDoc<{ title: string; createdAt: number; titleSource?: TitleSource }>({
  kind: 'app.session',
  version: 1,
  scope: 'session',
  initial: () => ({ title: '', createdAt: 0 }),
})

export type SessionEntry = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 先置后校：只会多、不会少，重启后才不会漏掉要续跑的会话（architecture §2）。 */
  hasActive: boolean
  pendingReports: number
  /** 只登记过、从未发过消息，没有目录也没有库。 */
  empty?: true
}

/** 对外（命令载荷与 session.updated）可见的字段，不含 `empty`。 */
export type SessionSummary = Omit<SessionEntry, 'empty'>

export type LoadStatus = 'ok' | 'missing' | 'corrupt'

const WRITE_DELAY_MS = 200
const OBSERVED = ['title', 'updatedAt', 'hasActive', 'pendingReports'] as const

const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

function normalize(value: unknown): SessionEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const id = text(item.id)
  if (!SESSION_ID.test(id)) return undefined
  const createdAt = count(item.createdAt)
  return {
    id,
    title: text(item.title),
    createdAt,
    updatedAt: count(item.updatedAt) || createdAt,
    hasActive: item.hasActive === true,
    pendingReports: Math.floor(count(item.pendingReports)),
    ...(item.empty === true ? { empty: true as const } : {}),
  }
}

export const summarize = ({ empty: _empty, ...summary }: SessionEntry): SessionSummary => summary

/**
 * `sessions/index.json`：派生缓存，缺失或损坏时由调用方扫描各库重建。
 * 写入一律临时文件加 rename；高频字段合并到 200ms 内最多落一次，登记 / 删除 / 切换当前会话立即落盘。
 */
export class SessionIndex {
  private readonly file: string
  private readonly entries = new Map<string, SessionEntry>()
  private readonly onError: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  currentId = ''

  constructor(directory: string, onError: (error: unknown) => void = () => {}) {
    this.file = path.join(directory, 'index.json')
    this.onError = onError
  }

  load(): LoadStatus {
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt'
    }
    try {
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.sessions)) return 'corrupt'
      this.entries.clear()
      for (const item of value.sessions) {
        const entry = normalize(item)
        if (entry) this.entries.set(entry.id, entry)
      }
      this.currentId = text(value.currentId)
      return 'ok'
    } catch { return 'corrupt' }
  }

  /** 重建或启动校验后整体替换。 */
  replace(entries: readonly SessionEntry[], currentId: string): void {
    this.entries.clear()
    for (const entry of entries) this.entries.set(entry.id, entry)
    this.currentId = currentId
    this.flush(true)
  }

  all(): SessionEntry[] { return [...this.entries.values()] }
  get(id: string): SessionEntry | undefined { return this.entries.get(id) }
  has(id: string): boolean { return this.entries.has(id) }

  /** 最近更新的在前，列表界面不必再排序。 */
  summaries(): SessionSummary[] {
    return this.all().sort((left, right) => right.updatedAt - left.updatedAt).map(summarize)
  }

  add(entry: SessionEntry): void {
    this.entries.set(entry.id, entry)
    this.flush(true)
  }

  /**
   * 合并补丁；`empty` 传 false 即清除标记。返回观察字段（标题、更新时间、活动标记、汇报数）是否真的变了，
   * 调用方据此决定发不发 `session.updated`。
   */
  update(id: string, patch: Partial<Omit<SessionEntry, 'id' | 'empty'>> & { empty?: boolean }, immediate = false): { entry: SessionEntry; changed: boolean } | undefined {
    const current = this.entries.get(id)
    if (!current) return undefined
    const { empty, ...rest } = patch
    const next: SessionEntry = { ...current, ...rest }
    if (empty === false) delete next.empty
    else if (empty === true) next.empty = true
    const changed = OBSERVED.some(key => next[key] !== current[key])
    const touched = changed || next.empty !== current.empty
    this.entries.set(id, next)
    if (touched) this.flush(immediate)
    return { entry: next, changed }
  }

  remove(id: string): boolean {
    const existed = this.entries.delete(id)
    if (this.currentId === id) this.currentId = ''
    if (existed) this.flush(true)
    return existed
  }

  setCurrent(id: string): void {
    if (this.currentId === id) return
    this.currentId = id
    this.flush(true)
  }

  /** 排在最前的会话；删除当前会话后，索引里先落一个合理的值，主进程随后会自己选定。 */
  latest(excluding?: string): SessionEntry | undefined {
    return this.all().filter(entry => entry.id !== excluding).sort((left, right) => right.updatedAt - left.updatedAt)[0]
  }

  flush(immediate = true): void {
    this.dirty = true
    if (!immediate) {
      if (this.timer) return
      this.timer = setTimeout(() => { this.timer = undefined; this.write() }, WRITE_DELAY_MS)
      this.timer.unref?.()
      return
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.write()
  }

  /** 关闭前把还没落盘的变更写掉。 */
  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.dirty) this.write()
  }

  private write(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const body = JSON.stringify({ version: 1, currentId: this.currentId, sessions: this.all() }, null, 2)
      const temporary = `${this.file}.${process.pid}.tmp`
      writeFileSync(temporary, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (error) {
      // 索引只是缓存，写失败不该拖垮会话；留着 dirty 让下一次变更重试。
      this.dirty = true
      this.onError(error)
    }
  }
}
