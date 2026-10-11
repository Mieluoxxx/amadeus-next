import { useCallback, useEffect, useRef, useState } from 'react'
import { text } from './taskTypes'
import {
  applyWorkEvent,
  mergeActions,
  normalizeActions,
  normalizeWorkList,
  workKey,
  type WorkAction,
  type WorkEvent,
  type WorkTask,
} from './workTypes'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

export type WorkTrace = { key: string; actions: WorkAction[]; loading: boolean; error: string }

const failure = (result: Record<string, unknown>, fallback: string) => text(result.error) || fallback

/**
 * 工作面板的状态。列表常驻（工具栏的提醒点要用），基线在面板打开、worker 重连时重拉；
 * 详情只在选中某个任务时拉一次完整历史，之后靠 task.activity 增量追加。
 */
export function useWorkPanel({ send, subscribe, connected, active }: {
  send: SendFn
  subscribe: SubscribeFn
  connected: boolean
  /** 面板正在显示：此时才因会话变化重拉基线。 */
  active: boolean
}) {
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [trace, setTrace] = useState<WorkTrace | null>(null)
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const request = useRef(0)
  // 基线请求在途时到达的增量；响应落地后在它上面重放。
  const inflight = useRef<WorkEvent[] | null>(null)
  const traceKey = useRef('')
  const traceBuffer = useRef<WorkAction[] | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const refresh = useCallback(async () => {
    const id = ++request.current
    inflight.current = []
    setLoading(true)
    try {
      const result = await send('work.list', {})
      if (id !== request.current) return
      if (result.ok === false) throw new Error(failure(result, 'work.list failed'))
      const replay = inflight.current ?? []
      inflight.current = null
      setTasks(replay.reduce(applyWorkEvent, normalizeWorkList(result)))
      setLoaded(true)
      setError('')
    } catch (cause) {
      if (id !== request.current) return
      inflight.current = null
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [send])

  const dispatch = useCallback((event: WorkEvent) => {
    inflight.current?.push(event)
    setTasks(current => applyWorkEvent(current, event))
  }, [])

  useEffect(() => {
    if (!connected) return
    void refresh()
    const stops = [
      subscribe('task.graph', params => dispatch({ type: 'graph', sessionId: text(params.sessionId), tasks: params.tasks })),
      subscribe('task.activity', params => {
        const sessionId = text(params.sessionId)
        const taskId = text(params.taskId)
        dispatch({ type: 'activity', sessionId, taskId, actions: params.actions, toolUses: params.toolUses, tokens: params.tokens })
        const key = workKey({ sessionId, taskId })
        if (key !== traceKey.current) return
        const actions = normalizeActions(params.actions)
        if (traceBuffer.current) { traceBuffer.current.push(...actions); return }
        setTrace(current => current && current.key === key ? { ...current, actions: mergeActions(current.actions, actions) } : current)
      }),
      // worker 重启或会话增删后，打开着的面板重拉一次；收起时不必。
      subscribe('session.changed', () => { if (activeRef.current) void refresh() }),
    ]
    return () => { for (const stop of stops) stop() }
  }, [connected, subscribe, dispatch, refresh])

  useEffect(() => {
    if (active && connected) void refresh()
  }, [active, connected, refresh])

  const openTrace = useCallback(async (task: Pick<WorkTask, 'sessionId' | 'taskId'>) => {
    const key = workKey(task)
    traceKey.current = key
    traceBuffer.current = []
    setTrace({ key, actions: [], loading: true, error: '' })
    try {
      const result = await send('work.trace', { session_id: task.sessionId, task_id: task.taskId })
      if (traceKey.current !== key) return
      if (result.ok === false) throw new Error(failure(result, 'work.trace failed'))
      const actions = mergeActions(normalizeActions(result.actions), traceBuffer.current ?? [])
      traceBuffer.current = null
      setTrace({ key, actions, loading: false, error: '' })
      // 完整历史里数出来的计数比账本里的准，顺手校正列表。
      const counted = result.task && typeof result.task === 'object' ? result.task as Record<string, unknown> : {}
      dispatch({ type: 'activity', sessionId: task.sessionId, taskId: task.taskId, actions: [], toolUses: counted.toolUses, tokens: counted.tokens })
    } catch (cause) {
      if (traceKey.current !== key) return
      traceBuffer.current = null
      setTrace({ key, actions: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [send, dispatch])

  const closeTrace = useCallback(() => {
    traceKey.current = ''
    traceBuffer.current = null
    setTrace(null)
  }, [])

  const cancel = useCallback(async (task: Pick<WorkTask, 'sessionId' | 'taskId'>): Promise<boolean> => {
    const key = workKey(task)
    setCancelling(current => new Set(current).add(key))
    try {
      const result = await send('task.cancel', { session_id: task.sessionId, task_id: task.taskId })
      return result.ok !== false
    } catch {
      return false
    } finally {
      setCancelling(current => { const next = new Set(current); next.delete(key); return next })
    }
  }, [send])

  return { tasks, loaded, loading, error, refresh, trace, openTrace, closeTrace, cancel, cancelling }
}
