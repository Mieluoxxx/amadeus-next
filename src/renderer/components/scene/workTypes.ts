/**
 * 工作面板的数据层（纯函数，便于单测）。
 * 列表 = work.list 的基线 + task.graph（打开着的会话的状态变化）+ task.activity（子代理的动作）的增量；
 * 请求在途时到达的增量先记下，响应落地后再按顺序重放，旧响应就不会盖掉新状态。
 */

import { field, isOpenStatus, isTaskStatus, text, type TaskStatus } from './taskTypes.ts'

export type WorkAction =
  | { id: string; type: 'brief' | 'text' | 'progress'; text: string; at: number }
  | {
    id: string
    type: 'tool'
    tool: string
    label: string
    status: 'running' | 'ok' | 'error'
    at: number
    durationMs?: number
    output?: string
  }

export type WorkTask = {
  sessionId: string
  /** work.list 给的会话标题；界面优先用会话列表里的最新标题。 */
  sessionTitle: string
  taskId: string
  kind: string
  title: string
  status: TaskStatus
  round: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  reason?: string
  question?: string
  progress?: { text: string; at: number }
  toolUses: number
  tokens: number
  /** 最近几个工具或进度动作，只在会话打开、子代理被监视时有。 */
  recent: WorkAction[]
}

export type WorkEvent =
  | { type: 'graph'; sessionId: string; tasks: unknown }
  | { type: 'activity'; sessionId: string; taskId: string; actions: unknown; toolUses: unknown; tokens: unknown }

type Params = Record<string, unknown>

export const RECENT_SHOWN = 3

export const workKey = (task: Pick<WorkTask, 'sessionId' | 'taskId'>): string => `${task.sessionId}/${task.taskId}`

const number = (value: unknown): number | undefined => {
  const result = Number(value)
  return value !== undefined && value !== null && value !== '' && Number.isFinite(result) ? result : undefined
}
const count = (value: unknown): number => Math.max(0, Math.floor(number(value) ?? 0))

export function normalizeAction(value: unknown): WorkAction | undefined {
  const item = value && typeof value === 'object' ? value as Params : {}
  const id = text(item.id)
  const at = number(item.at) ?? 0
  if (!id) return undefined
  if (item.type === 'brief' || item.type === 'text' || item.type === 'progress') return { id, type: item.type, text: text(item.text), at }
  if (item.type !== 'tool') return undefined
  const status = item.status === 'ok' || item.status === 'error' ? item.status : 'running'
  const durationMs = number(item.durationMs)
  const output = text(item.output)
  return {
    id, type: 'tool', tool: text(item.tool), label: text(item.label), status, at,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(output ? { output } : {}),
  }
}

export const normalizeActions = (items: unknown): WorkAction[] =>
  Array.isArray(items) ? items.flatMap(item => normalizeAction(item) ?? []) : []

/** 按 id 合并：已有的原地替换，新的按到达顺序追加。 */
export function mergeActions(base: readonly WorkAction[], incoming: readonly WorkAction[]): WorkAction[] {
  if (incoming.length === 0) return [...base]
  const next = [...base]
  const index = new Map(next.map((action, position) => [action.id, position]))
  for (const action of incoming) {
    const position = index.get(action.id)
    if (position === undefined) { index.set(action.id, next.length); next.push(action) } else next[position] = action
  }
  return next
}

const recentOf = (actions: readonly WorkAction[]): WorkAction[] =>
  actions.filter(action => action.type === 'tool' || action.type === 'progress').slice(-RECENT_SHOWN)

function normalizeTask(value: unknown, sessionId: string, sessionTitle: string): WorkTask | undefined {
  const item = value && typeof value === 'object' ? value as Params : {}
  const taskId = text(field(item, 'taskId', 'task_id', 'id'))
  if (!taskId) return undefined
  const status = field(item, 'status')
  const progress = item.progress && typeof item.progress === 'object' ? item.progress as Params : undefined
  const startedAt = number(item.startedAt)
  const endedAt = number(item.endedAt)
  return {
    sessionId,
    sessionTitle,
    taskId,
    kind: text(item.kind) || 'research',
    title: text(item.title),
    status: isTaskStatus(status) ? status : 'running',
    round: Math.max(1, count(item.round)),
    createdAt: number(item.createdAt) ?? 0,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(text(item.reason) ? { reason: text(item.reason) } : {}),
    ...(text(item.question) ? { question: text(item.question) } : {}),
    ...(progress && text(progress.text) ? { progress: { text: text(progress.text), at: number(progress.at) ?? 0 } } : {}),
    toolUses: count(item.toolUses),
    tokens: count(item.tokens),
    recent: normalizeActions(item.recent),
  }
}

export function normalizeWorkList(payload: unknown): WorkTask[] {
  const sessions = payload && typeof payload === 'object' && Array.isArray((payload as Params).sessions) ? (payload as Params).sessions as unknown[] : []
  return sessions.flatMap(value => {
    const session = value && typeof value === 'object' ? value as Params : {}
    const sessionId = text(field(session, 'sessionId', 'session_id', 'id'))
    if (!sessionId || !Array.isArray(session.tasks)) return []
    return session.tasks.flatMap(task => normalizeTask(task, sessionId, text(session.title)) ?? [])
  })
}

/** task.graph 是该会话的完整列表：整体替换，计数与最近动作沿用已知的。 */
function applyGraph(tasks: readonly WorkTask[], sessionId: string, items: unknown): WorkTask[] {
  if (!Array.isArray(items)) return [...tasks]
  const previous = new Map(tasks.filter(task => task.sessionId === sessionId).map(task => [task.taskId, task]))
  const sessionTitle = [...previous.values()][0]?.sessionTitle ?? ''
  const replaced = items.flatMap(item => {
    const task = normalizeTask(item, sessionId, sessionTitle)
    if (!task) return []
    const known = previous.get(task.taskId)
    return [{ ...task, toolUses: known?.toolUses ?? 0, tokens: known?.tokens ?? 0, recent: known?.recent ?? [] }]
  })
  return [...tasks.filter(task => task.sessionId !== sessionId), ...replaced]
}

function applyActivity(tasks: readonly WorkTask[], event: Extract<WorkEvent, { type: 'activity' }>): WorkTask[] {
  const actions = normalizeActions(event.actions)
  return tasks.map(task => {
    if (task.sessionId !== event.sessionId || task.taskId !== event.taskId) return task
    return {
      ...task,
      toolUses: number(event.toolUses) ?? task.toolUses,
      tokens: number(event.tokens) ?? task.tokens,
      recent: recentOf(mergeActions(task.recent, actions)),
    }
  })
}

export function applyWorkEvent(tasks: readonly WorkTask[], event: WorkEvent): WorkTask[] {
  return event.type === 'graph' ? applyGraph(tasks, event.sessionId, event.tasks) : applyActivity(tasks, event)
}

/** 本轮已运行多久：排队中算等待时长，结束后冻结在结束时刻。 */
export function elapsedOf(task: Pick<WorkTask, 'status' | 'createdAt' | 'startedAt' | 'endedAt'>, now: number): number | undefined {
  if (task.status === 'queued') return task.createdAt ? Math.max(0, now - task.createdAt) : undefined
  if (task.startedAt === undefined) return undefined
  const end = task.endedAt ?? (isOpenStatus(task.status) && task.status !== 'needs_input' ? now : undefined)
  return end === undefined ? undefined : Math.max(0, end - task.startedAt)
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens)
}

/** 进行中的在前（最近开始的在上），结束的按结束时间倒序。 */
export function sortWork(tasks: readonly WorkTask[]): { open: WorkTask[]; finished: WorkTask[] } {
  const recency = (task: WorkTask) => task.endedAt ?? task.startedAt ?? task.createdAt
  const open = tasks.filter(task => isOpenStatus(task.status)).sort((left, right) => recency(right) - recency(left))
  const finished = tasks.filter(task => !isOpenStatus(task.status)).sort((left, right) => recency(right) - recency(left))
  return { open, finished }
}
