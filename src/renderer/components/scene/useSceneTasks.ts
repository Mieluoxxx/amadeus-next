/**
 * 任务图与写操作确认的客户端状态。
 * 状态按会话分桶：非当前会话的确认请求也要收下，切回去时才看得到。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import {
  field,
  isActiveStatus,
  isOpenStatus,
  normalizeApproval,
  normalizeTasks,
  resolvedState,
  text,
  type SceneTask,
  type TaskApproval,
} from './taskTypes'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

const EMPTY_TASKS: SceneTask[] = []
const EMPTY_APPROVALS: TaskApproval[] = []
// 已处理的确认只保留一行记录，积累太多没有意义。
const RESOLVED_KEPT = 20

const withoutVoid = (approvals: TaskApproval[], tasks: SceneTask[]): TaskApproval[] => approvals.filter(approval => {
  if (approval.state !== 'pending') return true
  const task = tasks.find(item => item.taskId === approval.taskId)
  // 任务已经结束，它名下未决的确认不会再有人等待。
  return !task || isActiveStatus(task.status)
})

function trimResolved(approvals: TaskApproval[]): TaskApproval[] {
  const resolved = approvals.filter(approval => approval.state !== 'pending')
  if (resolved.length <= RESOLVED_KEPT) return approvals
  const drop = new Set(resolved.slice(0, resolved.length - RESOLVED_KEPT))
  return approvals.filter(approval => !drop.has(approval))
}

const isNotFound = (result: Record<string, unknown>) =>
  result.code === 'not_found' || /not[_ ]?found/i.test(text(result.error))

export function useSceneTasks({
  send,
  subscribe,
  connected,
  sessionId,
  onProblem,
}: {
  send: SendFn
  subscribe: SubscribeFn
  connected: boolean
  sessionId: string
  onProblem: (message: string) => void
}) {
  const { t } = useI18n()
  const [tasksBySession, setTasksBySession] = useState<Record<string, SceneTask[]>>({})
  const [approvalsBySession, setApprovalsBySession] = useState<Record<string, TaskApproval[]>>({})
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  const tasks = tasksBySession[sessionId] ?? EMPTY_TASKS
  const approvals = approvalsBySession[sessionId] ?? EMPTY_APPROVALS
  const hasPending = approvals.some(approval => approval.state === 'pending')

  // 只在有未决确认时才走秒表，空闲时不唤醒渲染。
  useEffect(() => {
    if (!hasPending) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasPending])

  const applyTasks = useCallback((id: string, next: SceneTask[]) => {
    setTasksBySession(previous => ({ ...previous, [id]: next }))
    setApprovalsBySession(previous => {
      const current = previous[id]
      if (!current) return previous
      const kept = withoutVoid(current, next)
      return kept.length === current.length ? previous : { ...previous, [id]: kept }
    })
    // 任务一旦终结，"正在取消"的临时标记就该撤掉。
    setCancelling(previous => {
      // 停下来等回答的任务仍可被取消，"正在取消"的标记要留到它真正结束。
      const settled = next.filter(task => !isOpenStatus(task.status)).map(task => task.taskId)
      if (!settled.some(taskId => previous.has(taskId))) return previous
      const copy = new Set(previous)
      for (const taskId of settled) copy.delete(taskId)
      return copy
    })
  }, [])

  const applyLoaded = useCallback((id: string, raw: unknown) => {
    if (id && Array.isArray(raw)) applyTasks(id, normalizeTasks(raw))
  }, [applyTasks])

  const forgetSession = useCallback((id: string) => {
    setTasksBySession(previous => {
      if (!(id in previous)) return previous
      const { [id]: _removed, ...rest } = previous
      return rest
    })
    setApprovalsBySession(previous => {
      if (!(id in previous)) return previous
      const { [id]: _removed, ...rest } = previous
      return rest
    })
  }, [])

  const settleApproval = useCallback((id: string, approvalId: string, state: TaskApproval['state']) => {
    setApprovalsBySession(previous => {
      const current = previous[id]
      if (!current?.some(item => item.approvalId === approvalId)) return previous
      return { ...previous, [id]: current.map(item => item.approvalId === approvalId ? { ...item, state } : item) }
    })
  }, [])

  useEffect(() => {
    if (!connected) return
    const unsubscribers = [
      subscribe('task.graph', params => {
        const id = text(field(params, 'sessionId', 'session_id'))
        if (id) applyTasks(id, normalizeTasks(params.tasks))
      }),
      subscribe('task.approval-request', params => {
        const approval = normalizeApproval(params, '')
        if (!approval?.sessionId) return
        setApprovalsBySession(previous => {
          const current = previous[approval.sessionId] ?? []
          const others = current.filter(item => item.approvalId !== approval.approvalId)
          return { ...previous, [approval.sessionId]: trimResolved([...others, approval]) }
        })
      }),
      subscribe('task.approval-resolved', params => {
        const id = text(field(params, 'sessionId', 'session_id'))
        const approvalId = text(field(params, 'approvalId', 'approval_id'))
        if (id && approvalId) settleApproval(id, approvalId, resolvedState(params.state))
      }),
    ]
    return () => unsubscribers.forEach(unsubscribe => unsubscribe())
  }, [connected, subscribe, applyTasks, settleApproval])

  const cancelTask = useCallback(async (taskId: string) => {
    if (!sessionId) return
    setCancelling(previous => new Set(previous).add(taskId))
    const release = () => setCancelling(previous => {
      if (!previous.has(taskId)) return previous
      const copy = new Set(previous)
      copy.delete(taskId)
      return copy
    })
    try {
      const result = await send('task.cancel', { sessionId, taskId })
      if (result.ok === false) throw new Error(text(result.error) || 'task.cancel rejected')
      // 任务已是终态时不会再有图更新，标记留着会一直卡在"正在取消"。
      if (result.status === 'terminal') release()
    } catch (error) {
      release()
      onProblem(t('task.cancel_failed', undefined, { error: error instanceof Error ? error.message : String(error) }))
    }
  }, [send, sessionId, onProblem, t])

  const decideApproval = useCallback(async (approval: TaskApproval, allow: boolean) => {
    setDeciding(previous => new Set(previous).add(approval.approvalId))
    try {
      const result = await send('task.approve', {
        sessionId: approval.sessionId,
        taskId: approval.taskId,
        approvalId: approval.approvalId,
        allow,
      })
      if (result.ok === false) {
        if (isNotFound(result)) {
          // 已处理或已过期：本地收起，不让一个失效的按钮留在界面上。
          settleApproval(approval.sessionId, approval.approvalId, 'expired')
          onProblem(t('task.approval.gone'))
          return
        }
        throw new Error(text(result.error) || 'task.approve rejected')
      }
      settleApproval(approval.sessionId, approval.approvalId, allow ? 'allow' : 'deny')
    } catch (error) {
      onProblem(t('task.approval.failed', undefined, { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setDeciding(previous => {
        const copy = new Set(previous)
        copy.delete(approval.approvalId)
        return copy
      })
    }
  }, [send, onProblem, settleApproval, t])

  const pendingApprovalCount = useMemo(
    () => approvals.filter(item => item.state === 'pending' && (item.expiresAt === 0 || item.expiresAt > now)).length,
    [approvals, now],
  )

  return {
    tasks,
    approvals,
    now,
    pendingApprovalCount,
    cancelling,
    deciding,
    applyLoaded,
    forgetSession,
    cancelTask,
    decideApproval,
  }
}
