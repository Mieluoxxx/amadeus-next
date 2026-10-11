import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TaskSummary } from './handoff/index.ts'

/** 账本里的一条委托：TaskSummary 去掉易变的 progress，加上子代理的动作计数。 */
export type WorkRecord = Omit<TaskSummary, 'progress'> & { toolUses: number; tokens: number }

const WRITE_DELAY_MS = 200

const text = (value: unknown) => typeof value === 'string' ? value : ''
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const optional = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function normalize(value: unknown): WorkRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const taskId = text(item.taskId)
  if (!taskId) return undefined
  const startedAt = optional(item.startedAt)
  const endedAt = optional(item.endedAt)
  return {
    taskId,
    kind: text(item.kind),
    title: text(item.title),
    status: text(item.status) || 'failed',
    round: Math.max(1, Math.floor(count(item.round))),
    createdAt: count(item.createdAt),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(text(item.reason) ? { reason: text(item.reason) } : {}),
    ...(text(item.question) ? { question: text(item.question) } : {}),
    toolUses: Math.floor(count(item.toolUses)),
    tokens: Math.floor(count(item.tokens)),
  }
}

const same = (left: WorkRecord, right: WorkRecord) => JSON.stringify(left) === JSON.stringify(right)

/**
 * `sessions/work.json`：各会话委托的摘要，工作面板列出未打开会话的任务时读它，不必为了列表去打开会话库。
 * 打开的会话以库里的 HandoffsDoc 为准，每次变化同步到这里；账本建立之前的任务，等会话下次打开时补进来。
 */
export class WorkLedger {
  private readonly file: string
  private readonly sessions = new Map<string, WorkRecord[]>()
  private readonly onError: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false

  constructor(directory: string, onError: (error: unknown) => void = () => {}) {
    this.file = path.join(directory, 'work.json')
    this.onError = onError
  }

  /** 缺失或损坏都从空账本开始：它只是派生缓存。 */
  load(): void {
    this.sessions.clear()
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!value || value.version !== 1 || !value.sessions || typeof value.sessions !== 'object') return
      for (const [id, items] of Object.entries(value.sessions as Record<string, unknown>)) {
        if (!Array.isArray(items)) continue
        const records = items.flatMap(item => normalize(item) ?? [])
        if (records.length) this.sessions.set(id, records)
      }
    } catch { /* 没有账本或已损坏 */ }
  }

  get(sessionId: string): WorkRecord[] { return this.sessions.get(sessionId) ?? [] }
  entries(): Array<[string, WorkRecord[]]> { return [...this.sessions.entries()] }

  /** 用库里的最新列表替换该会话的记录；计数沿用账本里已有的值。 */
  sync(sessionId: string, tasks: readonly TaskSummary[]): void {
    const previous = new Map(this.get(sessionId).map(record => [record.taskId, record]))
    const next = tasks.map(({ progress: _progress, ...task }) => {
      const known = previous.get(task.taskId)
      return { ...task, toolUses: known?.toolUses ?? 0, tokens: known?.tokens ?? 0 }
    })
    const current = this.get(sessionId)
    if (next.length === current.length && next.every((record, index) => same(record, current[index]))) return
    if (next.length) this.sessions.set(sessionId, next)
    else this.sessions.delete(sessionId)
    this.flush(false)
  }

  count(sessionId: string, taskId: string, counts: { toolUses: number; tokens: number }): void {
    const record = this.get(sessionId).find(each => each.taskId === taskId)
    if (!record || (record.toolUses === counts.toolUses && record.tokens === counts.tokens)) return
    record.toolUses = counts.toolUses
    record.tokens = counts.tokens
    this.flush(false)
  }

  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.flush(true)
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

  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.dirty) this.write()
  }

  private write(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const body = JSON.stringify({ version: 1, sessions: Object.fromEntries(this.sessions) })
      const temporary = `${this.file}.${process.pid}.tmp`
      writeFileSync(temporary, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (error) {
      // 与索引一样只是缓存：写失败留着 dirty，下一次变更重试。
      this.dirty = true
      this.onError(error)
    }
  }
}
