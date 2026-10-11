/**
 * 任务卡片与写操作确认的数据形状和归一化。
 * 主进程事件的字段名在 camelCase 与 snake_case 之间还没有统一，这里集中兜底，界面代码只看归一化后的类型。
 */

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'cancelled' | 'needs_input'

const TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'done', 'failed', 'timeout', 'cancelled', 'needs_input']

/** 子代理最近一次 report_progress；`at` 是毫秒时间戳。 */
export type TaskProgress = { text: string; at: number }

export type SceneTask = {
  taskId: string
  kind: string
  title: string
  status: TaskStatus
  /** 从 1 开始；handoff_send 续接已结束的任务时加一。 */
  round: number
  progress?: TaskProgress
  /** 仅 `needs_input`：子代理需要主人回答的问题。 */
  question?: string
}

export type ApprovalState = 'pending' | 'allow' | 'deny' | 'expired'

export type ApprovalTool = 'bash' | 'write' | 'edit'

const APPROVAL_TOOLS: readonly ApprovalTool[] = ['bash', 'write', 'edit']

/** 与 worker 的确认事件一致：command / preview 是批准所依据的完整原文，界面不得截断。 */
export type ApprovalDetail = {
  tool?: ApprovalTool
  command?: string
  cwd?: string
  path?: string
  preview?: string
}

export type TaskApproval = {
  sessionId: string
  taskId: string
  approvalId: string
  summary: string
  detail: ApprovalDetail
  /** 毫秒时间戳，由 worker 给出；本地倒计时以它为准。 */
  expiresAt: number
  state: ApprovalState
}

/** 历史里的 `card` 消息与实时的 `task.report` 共用的卡片数据。 */
export type CardData = {
  taskId: string
  title: string
  status: string
  summary: string
  round?: number
  question?: string
}

type Params = Record<string, unknown>

export function field(params: Params, ...keys: string[]): unknown {
  for (const key of keys) if (params[key] !== undefined && params[key] !== null) return params[key]
  return undefined
}

export const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value))

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/** 占用并发名额的状态（排队中、进行中）；needs_input 不占名额，不在此列。 */
export const isActiveStatus = (status: string): boolean => status === 'queued' || status === 'running'

/** 任务还没有结束：除了进行中的，也包括停下来等主人回答的（它可以被续接，也可以被取消）。 */
export const isOpenStatus = (status: string): boolean => isActiveStatus(status) || status === 'needs_input'

/** 轮次从 1 开始；缺失或非法的值当作未知，由调用方决定是否显示。 */
function normalizeRound(value: unknown): number | undefined {
  const round = Number(value)
  return Number.isInteger(round) && round >= 1 ? round : undefined
}

const toMillis = (value: number): number => (value > 0 && value < 1e11 ? value * 1000 : value)

function normalizeProgress(value: unknown): TaskProgress | undefined {
  const progress = value && typeof value === 'object' ? value as Params : {}
  const body = text(progress.text).trim()
  const at = Number(progress.at)
  return body && Number.isFinite(at) ? { text: body, at: toMillis(at) } : undefined
}

const normalizeQuestion = (value: unknown): string | undefined => text(value).trim() || undefined

export function normalizeTasks(items: unknown): SceneTask[] {
  if (!Array.isArray(items)) return []
  const tasks: SceneTask[] = []
  for (const item of items) {
    const value = item && typeof item === 'object' ? item as Params : {}
    const taskId = text(field(value, 'taskId', 'task_id', 'id'))
    if (!taskId) continue
    const status = field(value, 'status')
    const progress = normalizeProgress(field(value, 'progress'))
    const question = normalizeQuestion(field(value, 'question'))
    tasks.push({
      taskId,
      kind: text(field(value, 'kind')) || 'research',
      title: text(field(value, 'title')),
      // 未知状态当作进行中展示，比静默丢掉任务更不容易让人误判。
      status: isTaskStatus(status) ? status : 'running',
      round: normalizeRound(field(value, 'round')) ?? 1,
      ...(progress ? { progress } : {}),
      ...(question ? { question } : {}),
    })
  }
  return tasks
}

function normalizeDetail(value: unknown): ApprovalDetail {
  const detail = value && typeof value === 'object' ? value as Params : {}
  const out: ApprovalDetail = {}
  if ((APPROVAL_TOOLS as readonly unknown[]).includes(detail.tool)) out.tool = detail.tool as ApprovalTool
  if (typeof detail.command === 'string') out.command = detail.command
  if (typeof detail.cwd === 'string') out.cwd = detail.cwd
  if (typeof detail.path === 'string') out.path = detail.path
  if (typeof detail.preview === 'string') out.preview = detail.preview
  return out
}

export function normalizeApproval(params: Params, fallbackSession: string): TaskApproval | null {
  const approvalId = text(field(params, 'approvalId', 'approval_id'))
  const taskId = text(field(params, 'taskId', 'task_id'))
  if (!approvalId || !taskId) return null
  const rawExpiry = Number(field(params, 'expiresAt', 'expires_at'))
  // 秒级时间戳（< 1e11）折算成毫秒，避免倒计时一上来就判为过期。
  const expiresAt = Number.isFinite(rawExpiry) ? toMillis(rawExpiry) : 0
  return {
    sessionId: text(field(params, 'sessionId', 'session_id')) || fallbackSession,
    taskId,
    approvalId,
    summary: text(field(params, 'summary')),
    detail: normalizeDetail(field(params, 'detail')),
    expiresAt,
    state: 'pending',
  }
}

export function resolvedState(value: unknown): ApprovalState {
  const state = text(value).toLowerCase()
  if (state === 'allow' || state === 'allowed') return 'allow'
  if (state === 'deny' || state === 'denied') return 'deny'
  return 'expired'
}

export function normalizeCard(value: Params): CardData {
  const summary = text(field(value, 'summary')) || text(field(value, 'text', 'content'))
  const round = normalizeRound(field(value, 'round'))
  const question = normalizeQuestion(field(value, 'question'))
  return {
    taskId: text(field(value, 'taskId', 'task_id')),
    title: text(field(value, 'title')),
    status: text(field(value, 'status')),
    summary,
    ...(round ? { round } : {}),
    ...(question ? { question } : {}),
  }
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export type Age = { unit: 'now' | 'seconds' | 'minutes' | 'hours'; count: number }

/** 进度行的相对时间。时钟回拨或跨进程的小误差归到"刚刚"。 */
export function ageOf(elapsedMs: number): Age {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  if (seconds < 5) return { unit: 'now', count: 0 }
  if (seconds < 60) return { unit: 'seconds', count: seconds }
  if (seconds < 3600) return { unit: 'minutes', count: Math.floor(seconds / 60) }
  return { unit: 'hours', count: Math.floor(seconds / 3600) }
}
