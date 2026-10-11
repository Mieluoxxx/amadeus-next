/**
 * Chat session state for the Amadeus scene shell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { ATTACHMENT_ONLY_TEXT, visualPayload, type VisualAttachment } from './visualAttachment'
import {
  asrDraftOutcome,
  interruptedTurns,
  isStaleTurn,
  mayApplySession,
} from './sceneStreamState'
import {
  reconcileLoadedMessages,
  type SceneMessage,
} from './sceneMessageReconciliation'
import { useSceneTasks } from './useSceneTasks'
import { useComposingReport } from './useComposingReport'
import { field, normalizeCard, text as textOf, type CardData } from './taskTypes'

export type { SceneMessage } from './sceneMessageReconciliation'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

export type SceneSession = {
  id: string
  title: string
  /** 旧会话分组：只能看，不能续。 */
  readonly: boolean
  pendingReports: number
  pendingApprovals: number
}

type SceneSessionChange = {
  sequence: number
  sessionId: string
  source: string
  clientRequestId: string
}

type SceneSessionOperationResult = {
  status: 'applied' | 'superseded' | 'rejected' | 'unknown'
  sessionId?: string
  clientRequestId?: string
  sequence?: number
  error?: string
}

function operationStatus(error: unknown): 'rejected' | 'unknown' {
  return error && typeof error === 'object' && (error as { kind?: unknown }).kind === 'rejected'
    ? 'rejected'
    : 'unknown'
}

function stableMessageHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function normalizeMessages(items: unknown, sessionId = ''): SceneMessage[] {
  if (!Array.isArray(items)) return []
  const occurrences = new Map<string, number>()
  return items
    .map(item => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const role = value.role === 'assistant' || value.role === 'system' || value.role === 'card' ? value.role : 'user'
      const turnId = String(value.turn_id ?? value.turnId ?? '') || undefined
      // worker 的历史把卡片数据放在嵌套的 `card` 里；`task.report` 事件则是平铺的，两种都认。
      const card = role === 'card'
        ? normalizeCard(value.card && typeof value.card === 'object' ? value.card as Record<string, unknown> : value)
        : undefined
      const text = card ? card.summary : String(value.content ?? value.text ?? '')
      const authoritativeId = String(value.id ?? value.message_id ?? value.messageId ?? '')
      const stableKey = `${role}\u0000${turnId || ''}\u0000${text}`
      const occurrence = occurrences.get(stableKey) || 0
      occurrences.set(stableKey, occurrence + 1)
      return {
        id: authoritativeId || `history:${stableMessageHash(stableKey)}:${occurrence}`,
        identity: authoritativeId ? 'authoritative' : 'derived',
        role,
        text,
        ...(card ? { card } : {}),
        sessionId: String(value.session_id ?? value.sessionId ?? sessionId) || undefined,
        turnId,
        streaming: false,
        local: false,
      } as SceneMessage
    })
    // 卡片的正文是汇报摘要，可以为空；标题和任务 id 才是它存在的依据。
    .filter(message => message.text || (message.card && (message.card.taskId || message.card.title)))
}

const counter = (value: unknown): number => {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

function normalizeSessions(items: unknown): SceneSession[] {
  if (!Array.isArray(items)) return []
  return items
    .map(item => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return {
        id: String(value.id || ''),
        title: String(value.title || ''),
        readonly: value.readonly === true,
        pendingReports: counter(value.pendingReports ?? value.pending_reports),
        pendingApprovals: counter(value.pendingApprovals ?? value.pending_approvals),
      }
    })
    .filter(session => session.id)
}

function providerMetadata(params: Record<string, unknown>): Record<string, unknown> {
  return params.metadata && typeof params.metadata === 'object'
    ? params.metadata as Record<string, unknown>
    : {}
}

function eventSessionId(params: Record<string, unknown>): string {
  const metadata = providerMetadata(params)
  return String(
    params.session_id
      ?? params.sessionId
      ?? metadata.session_id
      ?? metadata.sessionId
      ?? '',
  )
}

export function useSceneSession({
  send,
  subscribe,
  connected,
}: {
  send: SendFn
  subscribe: SubscribeFn
  connected: boolean
}) {
  const [messages, setMessages] = useState<SceneMessage[]>([])
  const [sessions, setSessions] = useState<SceneSession[]>([])
  const sessionsRef = useRef<SceneSession[]>([])
  const [sessionId, setSessionId] = useState('')
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [asrListening, setAsrListening] = useState(false)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<{ value: string; label: string }[]>([])
  const [sessionChange, setSessionChange] = useState<SceneSessionChange | null>(null)
  const [operationError, setOperationError] = useState('')
  const [replying, setReplying] = useState(false)
  const [stopping, setStopping] = useState(false)
  const { t } = useI18n()
  const tasksApi = useSceneTasks({ send, subscribe, connected, sessionId, onProblem: setOperationError })
  const { applyLoaded: applyLoadedTasks, forgetSession: forgetSessionTasks } = tasksApi
  const activeSessionRef = useRef('')
  const streamingTextRef = useRef('')
  const draftRef = useRef('')
  /** 单调递增的草稿编辑版本号：防止相同字符的编辑被在途的异步发送回执误清空。 */
  const draftEditRef = useRef(0)
  const updateDraft = useCallback((value: string) => {
    draftEditRef.current += 1
    setDraft(value)
  }, [])
  /** 防抖锁：防止用户重复连续触发消息发送。 */
  const sendingRef = useRef(false)
  // 记录用户主动中止的回合，忽略后续到达的残余流式 Token，防止已取消的回复继续增量上屏。
  const interruptedTurnsRef = useRef<Set<string>>(new Set())
  const activeTurnRef = useRef('')
  /** 回合 id 的唯一写入口：停止按钮要靠 state 重绘，ref 单独改不会触发。 */
  const setActiveTurn = useCallback((turnId: string) => {
    activeTurnRef.current = turnId
    setReplying(Boolean(turnId))
  }, [])
  /** 记录最新请求加载的目标会话与代数，用于异步响应时序判定。 */
  const requestedSessionRef = useRef('')
  const loadGenerationRef = useRef(0)
  /** 操作意图版本：用户最新操作覆盖旧的加载或创建请求，避免网络乱序导致画面错乱。 */
  const sessionIntentRef = useRef(0)
  const operationIntentsRef = useRef(new Map<string, number>())
  const pendingOperationRef = useRef<{ requestId: string; intent: number } | null>(null)
  const acknowledgedMessageKeysRef = useRef<ReadonlySet<string>>(new Set())
  const supersededOperationIdsRef = useRef(new Set<string>())
  const acceptedEventIdsRef = useRef(new Set<string>())
  const settledOperationIdsRef = useRef(new Set<string>())
  const sessionChangeSequenceRef = useRef(0)

  const beginOperation = useCallback(() => {
    if (pendingOperationRef.current) {
      supersededOperationIdsRef.current.add(pendingOperationRef.current.requestId)
    }
    const intent = ++sessionIntentRef.current
    const requestId = crypto.randomUUID()
    operationIntentsRef.current.set(requestId, intent)
    pendingOperationRef.current = { requestId, intent }
    return { requestId, intent }
  }, [])

  const finishOperation = useCallback((requestId: string) => {
    operationIntentsRef.current.delete(requestId)
    settledOperationIdsRef.current.add(requestId)
    if (settledOperationIdsRef.current.size > 64) {
      settledOperationIdsRef.current.delete(settledOperationIdsRef.current.values().next().value as string)
    }
    if (pendingOperationRef.current?.requestId === requestId) pendingOperationRef.current = null
  }, [])

  const applySessionPayload = useCallback((payload: Record<string, unknown>, options: { notify?: boolean } = {}) => {
    if (Array.isArray(payload.sessions)) setSessions(normalizeSessions(payload.sessions))
    const session = payload.session && typeof payload.session === 'object'
      ? payload.session as Record<string, unknown>
      : undefined
    const nextId = String(payload.current_session_id || session?.id || '')
    const switched = Boolean(nextId) && activeSessionRef.current !== nextId
    if (nextId && session?.readonly === true) {
      setSessions(previous => previous.map(item => item.id === nextId ? { ...item, readonly: true } : item))
    }
    if (nextId) applyLoadedTasks(nextId, payload.tasks)
    if (nextId) {
      activeSessionRef.current = nextId
      setSessionId(nextId)
      if (switched) {
        // 流式状态作用域属于单次回合而非会话：切换会话时重置流式标记，避免上个会话的中断状态污染新会话。
        interruptedTurnsRef.current = new Set()
        setActiveTurn('')
        streamingTextRef.current = ''
        setStreaming(false)
        acknowledgedMessageKeysRef.current = new Set()
      }
      if (switched || options.notify) {
        setOperationError('')
        setSessionChange({
          sequence: ++sessionChangeSequenceRef.current,
          sessionId: nextId,
          source: String(payload.source || ''),
          clientRequestId: String(payload.client_request_id || ''),
        })
      }
    }
    if (Array.isArray(payload.messages)) {
      const loaded = normalizeMessages(payload.messages, nextId)
      const preserveLiveStream = !switched && Boolean(activeTurnRef.current && streamingTextRef.current)
      const liveTurnIds = preserveLiveStream ? new Set([activeTurnRef.current]) : new Set<string>()
      acknowledgedMessageKeysRef.current = reconcileLoadedMessages(
        [],
        loaded,
        nextId,
        switched ? new Set() : acknowledgedMessageKeysRef.current,
        liveTurnIds,
      ).acknowledged
      const acknowledged = acknowledgedMessageKeysRef.current
      setMessages(previous => reconcileLoadedMessages(
        switched ? [] : previous,
        loaded,
        nextId,
        acknowledged,
        liveTurnIds,
      ).messages)
      if (!preserveLiveStream) {
        streamingTextRef.current = ''
        setStreaming(false)
      }
    } else if (switched) {
      // 切换会话时立即排空消息列表，防止加载过程中旧会话历史数据残留泄露到新界面。
      setMessages([])
      streamingTextRef.current = ''
      setStreaming(false)
    }
    return nextId
  }, [applyLoadedTasks, setActiveTurn])

  const loadSession = useCallback(async (id: string): Promise<SceneSessionOperationResult> => {
    // 仅采纳代数匹配且意图最新的加载回执，丢弃用户已离开会话的迟到响应。
    const { requestId, intent } = beginOperation()
    const generation = ++loadGenerationRef.current
    requestedSessionRef.current = id
    setOperationError('')
    try {
      const response = await send('session.load', { session_id: id, client_request_id: requestId })
      if (intent !== sessionIntentRef.current || generation !== loadGenerationRef.current) return { status: 'superseded' }
      if (response.ok === false) {
        const error = String(response.error || 'session not found')
        setOperationError(`任务加载失败：${error}`)
        return { status: 'rejected', error }
      }
      if (!mayApplySession(id, requestedSessionRef.current, false)) return { status: 'superseded' }
      const activeId = applySessionPayload(response)
      return activeId ? { status: 'applied', sessionId: activeId } : { status: 'unknown' }
    } catch (error) {
      if (intent === sessionIntentRef.current && generation === loadGenerationRef.current) {
        setOperationError(`${operationStatus(error) === 'rejected' ? '任务加载失败' : '任务加载状态未知'}：${error instanceof Error ? error.message : String(error)}`)
      }
      return { status: operationStatus(error), error: error instanceof Error ? error.message : String(error) }
    } finally {
      finishOperation(requestId)
    }
  }, [send, applySessionPayload])

  const createSession = useCallback(async (): Promise<SceneSessionOperationResult> => {
    const { requestId, intent } = beginOperation()
    const generation = ++loadGenerationRef.current
    requestedSessionRef.current = ''
    setOperationError('')
    try {
      const response = await send('session.create', { client_request_id: requestId })
      if (response.ok === false) {
        if (intent === sessionIntentRef.current) {
          setOperationError(`新建任务失败：${String(response.error || 'session.create rejected')}`)
        }
        return { status: 'rejected', error: String(response.error || 'session.create rejected') }
      }
      const responseId = String(
        response.current_session_id
          || (response.session && typeof response.session === 'object'
            ? (response.session as Record<string, unknown>).id
            : '')
          || '',
      )
      // 服务端广播 session.changed 可能先于 RPC 回执到达；只要回执会话与当前会话一致则视为有效，仅丢弃被后续操作覆盖的响应。
      if (intent !== sessionIntentRef.current) return { status: 'superseded' }
      if (generation !== loadGenerationRef.current && activeSessionRef.current !== responseId) return { status: 'superseded' }
      const activeId = applySessionPayload(response)
      return activeId ? { status: 'applied', sessionId: activeId } : { status: 'unknown' }
    } catch (error) {
      if (intent === sessionIntentRef.current) {
        setOperationError(`${operationStatus(error) === 'rejected' ? '新建任务失败' : '新建任务状态未知'}：${error instanceof Error ? error.message : String(error)}`)
      }
      return { status: operationStatus(error), error: error instanceof Error ? error.message : String(error) }
    } finally {
      finishOperation(requestId)
    }
  }, [send, applySessionPayload])

  const upsertAssistantMessage = useCallback((turnId: string, text: string, streamingValue: boolean) => {
    const session = activeSessionRef.current
    setMessages(previous => {
      if (turnId) {
        const index = previous.findIndex(message => (
          message.role === 'assistant'
          && message.turnId === turnId
          && (!message.sessionId || message.sessionId === session)
        ))
        if (index >= 0) {
          const next = [...previous]
          next[index] = { ...next[index], text, streaming: streamingValue }
          return next
        }
      }
      return [...previous, {
        id: `assistant:${session || 'current'}:${turnId || crypto.randomUUID()}`,
        role: 'assistant',
        text,
        sessionId: session || undefined,
        turnId,
        streaming: streamingValue,
        local: true,
      }]
    })
  }, [])

  const upsertCardMessage = useCallback((turnId: string, card: CardData) => {
    const session = activeSessionRef.current
    setMessages(previous => {
      const index = previous.findIndex(message => message.role === 'card'
        && (!message.sessionId || message.sessionId === session)
        && ((card.taskId && message.card?.taskId === card.taskId) || (turnId && message.turnId === turnId)))
      if (index >= 0) {
        const next = [...previous]
        next[index] = { ...next[index], text: card.summary, card }
        return next
      }
      const entry: SceneMessage = {
        id: `card:${session || 'current'}:${card.taskId || turnId || crypto.randomUUID()}`,
        role: 'card',
        text: card.summary,
        card,
        sessionId: session || undefined,
        turnId: turnId || undefined,
        local: true,
      }
      // 汇报的第一个 token 可能先于卡片事件到达；卡片是回答的前因，必须排在它前面。
      const reply = turnId
        ? previous.findIndex(message => message.role === 'assistant' && message.turnId === turnId)
        : -1
      return reply >= 0 ? [...previous.slice(0, reply), entry, ...previous.slice(reply)] : [...previous, entry]
    })
  }, [])

  // 首次初始化拉取会话列表并加载活跃会话历史。
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    void (async () => {
      const { requestId, intent } = beginOperation()
      try {
        const listed = await send('session.list', { client_request_id: requestId })
        if (cancelled || intent !== sessionIntentRef.current) return
        const activeId = applySessionPayload(listed)
        if (activeId) await loadSession(activeId)
      } catch {
        // 后端启动中偶发失败不中断渲染，后续就绪广播会自动触发同步。
      } finally {
        finishOperation(requestId)
      }
    })()
    return () => {
      cancelled = true
      sessionIntentRef.current += 1
      loadGenerationRef.current += 1
    }
  }, [connected, send, applySessionPayload, loadSession, beginOperation, finishOperation])

  useEffect(() => {
    if (connected) return
    sessionIntentRef.current += 1
    loadGenerationRef.current += 1
    operationIntentsRef.current.clear()
    supersededOperationIdsRef.current.clear()
    acceptedEventIdsRef.current.clear()
    settledOperationIdsRef.current.clear()
    pendingOperationRef.current = null
  }, [connected])

  // 监听全局配置同步 LLM Provider，保持场景界面与设置页状态一致。
  useEffect(() => {
    if (!connected) return
    const applyConfig = (payload: Record<string, unknown>) => {
      const values = payload.values && typeof payload.values === 'object'
        ? payload.values as Record<string, unknown>
        : payload
      if (values.llm_provider !== undefined) {
        setProvider(String(values.llm_provider))
      }
    }
    const unsubscribe = subscribe('system.config', payload => applyConfig(payload))
    send('system.get_config', {}).then(payload => applyConfig(payload)).catch(() => {})
    return () => unsubscribe()
  }, [connected, send, subscribe])

  // 会话切换时拉取当前可用模型；若遇流式响应中拒绝读取，延迟重试直到当前回合结束。
  const modelSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!connected) return
    return subscribe('pi.model', payload => {
      if (typeof payload.current === 'string') { setModel(payload.current); modelSessionRef.current = sessionId }
    })
  }, [connected, subscribe, sessionId])

  const [modelRetry, setModelRetry] = useState(0)
  useEffect(() => {
    if (!connected || streaming) return
    if (modelSessionRef.current === sessionId && model && models.length) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (modelSessionRef.current !== sessionId) setModel('')
    send('pi.models', {}).then(result => {
      if (cancelled) return
      if (!result.ok) {
        // 生成或热重载期间后端互斥锁定，指数退避重试拉取模型列表。
        if (modelRetry < 10) timer = setTimeout(() => setModelRetry(count => count + 1), 1000)
        return
      }
      if (typeof result.current === 'string') { setModel(result.current); modelSessionRef.current = sessionId }
      if (Array.isArray(result.models)) setModels(result.models as { value: string; label: string }[])
      setModelRetry(0)
    }).catch(() => {})
    return () => { cancelled = true; clearTimeout(timer) }
  }, [connected, send, sessionId, streaming, model, models.length, modelRetry])

  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  useComposingReport({ send, connected, draft, sessionId })

  useEffect(() => {
    const unsubscribers: Array<() => void> = []
    unsubscribers.push(subscribe('chat.token', params => {
      const turnId = String(params.turn_id ?? '')
      // 丢弃已被中断回合的残余流式数据，防止旧 Token 覆盖新回合流。
      if (isStaleTurn(turnId, interruptedTurnsRef.current)) return
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      if (turnId && activeTurnRef.current && turnId !== activeTurnRef.current) return
      if (turnId) setActiveTurn(turnId)
      streamingTextRef.current = String(params.token ?? '')
      setStreaming(true)
      upsertAssistantMessage(turnId, streamingTextRef.current, true)
    }))
    unsubscribers.push(subscribe('chat.complete', params => {
      const text = String(params.full_text ?? params.token ?? '')
      const turnId = String(params.turn_id ?? '')
      if (isStaleTurn(turnId, interruptedTurnsRef.current)) {
        streamingTextRef.current = ''
        if (activeTurnRef.current === turnId) {
          setStreaming(false)
          setActiveTurn('')
        }
        return
      }
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      if (turnId && activeTurnRef.current && turnId !== activeTurnRef.current) return
      upsertAssistantMessage(turnId, text, false)
      streamingTextRef.current = ''
      setStreaming(false)
      if (activeTurnRef.current === turnId) setActiveTurn('')
    }))
    unsubscribers.push(subscribe('chat.error', params => {
      const errorTurnId = String(params.turn_id ?? '')
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      if (errorTurnId && activeTurnRef.current && errorTurnId !== activeTurnRef.current) return
      if (!errorTurnId && !activeTurnRef.current) return
      if (errorTurnId) interruptedTurnsRef.current.add(errorTurnId)
      if (!errorTurnId || activeTurnRef.current === errorTurnId) setActiveTurn('')
      setStreaming(false)
      streamingTextRef.current = ''
      setMessages(previous => [...previous, {
        id: crypto.randomUUID(),
        role: 'system',
        text: `对话失败：${String(params.error ?? '')}`,
        sessionId: activeSessionRef.current || undefined,
        local: true,
      }])
    }))
    unsubscribers.push(subscribe('chat.interrupted', params => {
      const text = String(params.text ?? params.completed_text ?? '').trim()
      const eventTurnId = String(params.turn_id ?? '')
      const activeTurnId = activeTurnRef.current
      const turnId = eventTurnId || activeTurnId
      const streamed = streamingTextRef.current.trim()
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      if (eventTurnId && activeTurnId && eventTurnId !== activeTurnId) {
        // An old turn can finish its interruption after a new turn starts. Mark
        // only that old turn; never clear the newer turn's global stream state.
        interruptedTurnsRef.current = interruptedTurns(eventTurnId, '', interruptedTurnsRef.current)
        return
      }
      interruptedTurnsRef.current = interruptedTurns(
        eventTurnId,
        eventTurnId ? '' : activeTurnId,
        interruptedTurnsRef.current,
      )
      if (turnId) upsertAssistantMessage(turnId, text || streamed || '[interrupted by user]', false)
      streamingTextRef.current = ''
      setStreaming(false)
      if (activeTurnRef.current === turnId) setActiveTurn('')
    }))
    unsubscribers.push(subscribe('task.report', params => {
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      const card = normalizeCard(params)
      if (!card.taskId && !card.title) return
      upsertCardMessage(textOf(field(params, 'turnId', 'turn_id')), card)
    }))
    unsubscribers.push(subscribe('session.changed', params => {
      // 统一收敛会话变更入口，防止过期广播破坏当前正在进行的会话状态。
      const eventRequestId = String(params.client_request_id || '')
      const pendingOperation = pendingOperationRef.current
      const correlated = Boolean(eventRequestId && pendingOperation?.requestId === eventRequestId)
      const knownIntent = eventRequestId ? operationIntentsRef.current.get(eventRequestId) : undefined
      if (eventRequestId && (
        supersededOperationIdsRef.current.has(eventRequestId)
        || settledOperationIdsRef.current.has(eventRequestId)
        || acceptedEventIdsRef.current.has(eventRequestId)
      )) return
      if (knownIntent !== undefined && knownIntent < sessionIntentRef.current) return
      if (!correlated) {
        if (pendingOperation) supersededOperationIdsRef.current.add(pendingOperation.requestId)
        sessionIntentRef.current += 1
        loadGenerationRef.current += 1
      }
      requestedSessionRef.current = String(
        params.current_session_id
          || (params.session && typeof params.session === 'object'
            ? (params.session as Record<string, unknown>).id
            : '')
          || '',
      )
      if (eventRequestId) acceptedEventIdsRef.current.add(eventRequestId)
      applySessionPayload(params, { notify: true })
    }))
    // 首条消息发送后主进程分配正式标题，此处仅静默更新标题以保持列表同步。
    unsubscribers.push(subscribe('session.titled', params => {
      const id = String(params.session_id || '')
      const title = String(params.title || '')
      if (id && title) setSessions(previous => previous.map(item => item.id === id ? { ...item, title } : item))
    }))
    unsubscribers.push(subscribe('asr.recognized', params => {
      const text = String(params.text ?? '')
      if (!text || params.is_final !== true) return
      const outcome = asrDraftOutcome(String(params.source ?? ''), text, draftRef.current)
      if (outcome.alreadySubmitted) {
        // 语音识别上屏已被流式管线直接提交，直接以已发送消息渲染，防止用户二次重复提交。
        setMessages(previous => [...previous, {
          id: crypto.randomUUID(),
          role: 'user',
          text: text.trim(),
          sessionId: activeSessionRef.current || undefined,
          turnId: String(params.turn_id ?? '') || undefined,
          local: true,
        }])
      } else if (outcome.draft !== null) {
        updateDraft(outcome.draft)
      }
      setAsrListening(false)
    }))
    unsubscribers.push(subscribe('asr.status', params => {
      if (params.status === 'listening') setAsrListening(true)
      else if (['idle', 'processing', 'error'].includes(String(params.status))) setAsrListening(false)
      if (params.status === 'error') setOperationError(`语音识别失败：${String(params.error || 'Apple Speech unavailable')}`)
    }))
    return () => {
      unsubscribers.forEach(unsubscribe => unsubscribe())
      operationIntentsRef.current.clear()
      supersededOperationIdsRef.current.clear()
      acceptedEventIdsRef.current.clear()
      settledOperationIdsRef.current.clear()
      pendingOperationRef.current = null
    }
  }, [subscribe, upsertAssistantMessage, upsertCardMessage, applySessionPayload, updateDraft, setActiveTurn])

  const sendText = useCallback(async (rawText: string, attachment: VisualAttachment | null = null) => {
    // 旧会话是只读的，输入框已禁用；这里兜住快捷键等绕过输入框的入口。
    if (readonlyRef.current) return false
    const typed = rawText.trim()
    // 允许仅发送图片附件，自动填充占位文本以触发视觉理解流程。
    const text = typed || (attachment ? ATTACHMENT_ONLY_TEXT : '')
    if (!text) return false
    // 当前模型若不支持视觉解析，前置拦截报错，避免空耗后端资源。
    if (attachment && !visualPayload(attachment, provider)) {
      setMessages(previous => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: '当前提供方不支持图片，请切换到支持视觉的提供方。',
          sessionId: activeSessionRef.current || undefined,
          local: true,
        },
      ])
      return false
    }
    if (sendingRef.current) return false
    sendingRef.current = true
    const edit = draftEditRef.current
    const submittedProvider = provider
    const visual = visualPayload(attachment, submittedProvider)
    const sessionBeforeCreate = activeSessionRef.current
    try {
      let targetSession: string | null = activeSessionRef.current
      if (!targetSession) {
        // 发送前确保会话已初始化就绪，防止消息发送到未确认的无效目标。
        const creation = await createSession()
        if (creation.status !== 'applied') {
          if (activeSessionRef.current === sessionBeforeCreate) {
            setMessages(previous => [...previous, {
              id: crypto.randomUUID(),
              role: 'system',
              text: creation.status === 'rejected'
                ? `会话创建被后端拒绝：${creation.error || 'session.create rejected'}，草稿已保留。`
                : creation.status === 'unknown'
                  ? '会话创建状态未知，消息未发送，草稿已保留。'
                  : '会话创建请求已被更新的任务操作取代，消息未发送。',
              sessionId: activeSessionRef.current || undefined,
              local: true,
            }])
          }
          return false
        }
        targetSession = creation.sessionId || null
      }
      if (targetSession === null) {
        if (activeSessionRef.current === sessionBeforeCreate) {
          setMessages(previous => [...previous, {
            id: crypto.randomUUID(),
            role: 'system',
            text: '会话创建被后端拒绝，消息未发送，草稿已保留。',
            sessionId: activeSessionRef.current || undefined,
            local: true,
          }])
        }
        return false
      }
      if (!targetSession) return false

      const turnId = crypto.randomUUID()

      // 乐观插入用户消息并锁定回合 ID，防止快速到达的首字 Token 渲染在用户提问之前。
      setActiveTurn(turnId)
      interruptedTurnsRef.current.delete(turnId)
      const userMessageId = `user:${targetSession}:${turnId}`
      setMessages(previous => [...previous, {
        id: userMessageId,
        role: 'user',
        sessionId: targetSession,
        turnId,
        text,
        delivery: 'pending',
        local: true,
      }])
      let explicitRejection = false
      try {
        const response = await send('chat.send', {
          text,
          ...(submittedProvider ? { provider: submittedProvider } : {}),
          ...(visual ? { visual } : {}),
          turn_id: turnId,
          session_id: targetSession,
        })
        if (response.ok === false || response.rejected === true) {
          explicitRejection = true
          throw new Error(String(response.error || response.reason || 'chat.send rejected'))
        }
      } catch (failure) {
        // 请求超时或断连不代表服务端未受理，保留消息为未知状态，避免用户误判并重复重发。
        explicitRejection = explicitRejection
          || Boolean(failure && typeof failure === 'object' && (failure as { kind?: unknown }).kind === 'rejected')
        if (activeSessionRef.current === targetSession) {
          const failureText = failure instanceof Error ? failure.message : String(failure || '')
          setMessages(previous => [
            ...previous.map(message => message.id === userMessageId
              ? { ...message, delivery: explicitRejection ? 'rejected' as const : 'unknown' as const }
              : message),
            {
              id: crypto.randomUUID(),
              role: 'system',
              text: explicitRejection
                ? `消息被后端拒绝：${failureText}，草稿已保留。`
                : '消息发送状态未知，草稿已保留，请确认后再试。',
              sessionId: activeSessionRef.current || undefined,
              local: true,
            },
          ])
          if (activeTurnRef.current === turnId) setActiveTurn('')
        }
        return false
      }
      if (activeSessionRef.current === targetSession) {
        setMessages(previous => previous.map(message => message.id === userMessageId
          ? { ...message, delivery: 'accepted' as const }
          : message))
      }
      // 仅在输入框内容未被二次编辑时才清空，防止抹掉用户正在输入的新草稿。
      if (activeSessionRef.current === targetSession && draftEditRef.current === edit) {
        updateDraft('')
      }
      return activeSessionRef.current === targetSession
    } catch {
      // 会话创建或网络异常时完整保留草稿，方便用户重试。
      if (activeSessionRef.current === sessionBeforeCreate) {
        setMessages(previous => [...previous, {
          id: crypto.randomUUID(),
          role: 'system',
          text: '消息发送失败，草稿已保留，请重试。',
          sessionId: activeSessionRef.current || undefined,
          local: true,
        }])
      }
      return false
    } finally {
      sendingRef.current = false
    }
  }, [send, provider, createSession, updateDraft, setActiveTurn])

  /** 在对话流中显式提示附件处理异常，避免静默失败。 */
  const reportProblem = useCallback((text: string) => {
    setMessages(previous => [...previous, { id: crypto.randomUUID(), role: 'system', text }])
  }, [])

  const toggleMic = useCallback(async () => {
    if (!connected) return
    setOperationError('')
    try {
      if (asrListening) {
        const result = await send('asr.stop', {})
        if (result.ok === false) throw new Error(String(result.error || 'Apple Speech could not stop'))
        setAsrListening(false)
      } else {
        const result = await send('asr.start', {})
        if (result.ok === false) throw new Error(String(result.error || 'Apple Speech could not start'))
      }
    } catch (error) {
      setAsrListening(false)
      setOperationError(`语音识别失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [connected, send, asrListening])

  const selectModel = useCallback(async (value: string) => {
    try {
      const result = await send('pi.model.set', { model: value })
      if (!result.ok) throw new Error(String(result.error || 'Model switch failed'))
      if (typeof result.current === 'string') setModel(result.current)
    } catch (error) {
      reportProblem(error instanceof Error ? error.message : String(error))
    }
  }, [send, reportProblem])

  const activeSession = useMemo(
    () => sessions.find(session => session.id === sessionId) || null,
    [sessions, sessionId],
  )
  const readonly = activeSession?.readonly === true
  const readonlyRef = useRef(false)
  useEffect(() => { readonlyRef.current = readonly }, [readonly])

  const refreshSessions = useCallback(async () => {
    try {
      const listed = await send('session.list', {})
      if (listed.ok !== false && Array.isArray(listed.sessions)) setSessions(normalizeSessions(listed.sessions))
    } catch {
      // 列表刷新失败不影响当前会话，下次打开列表时会再试。
    }
  }, [send])

  // 非当前会话的汇报与确认只靠列表上的徽标提示；主进程在计数变化时推 session.updated，直接按条目替换，不必整表重拉。
  useEffect(() => {
    if (!connected) return
    return subscribe('session.updated', params => {
      const [entry] = normalizeSessions([params])
      if (!entry) return
      setSessions(previous => {
        const index = previous.findIndex(item => item.id === entry.id)
        if (index >= 0) {
          const next = [...previous]
          next[index] = { ...entry, readonly: previous[index].readonly || entry.readonly, title: entry.title || previous[index].title }
          return next
        }
        // 新会话排在可续写的会话之后、旧会话分组之前。
        const firstLegacy = previous.findIndex(item => item.readonly)
        return firstLegacy < 0 ? [...previous, entry] : [...previous.slice(0, firstLegacy), entry, ...previous.slice(firstLegacy)]
      })
    })
  }, [connected, subscribe])

  const stoppingRef = useRef(false)
  const abortReply = useCallback(async () => {
    const turnId = activeTurnRef.current
    if (!turnId || stoppingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    try {
      const session = activeSessionRef.current
      const result = await send('chat.abort', { session_id: session, sessionId: session, turn_id: turnId })
      if (result.ok === false) throw new Error(textOf(result.error) || 'chat.abort rejected')
      // 主进程取消进行中的回合时会先发 chat.interrupted；回执到了回合还在，说明没有事件可等，本地收口。
      if (activeTurnRef.current === turnId) {
        interruptedTurnsRef.current.add(turnId)
        setActiveTurn('')
        streamingTextRef.current = ''
        setStreaming(false)
        setMessages(previous => previous.map(message => (
          message.role === 'assistant' && message.turnId === turnId && message.streaming
            ? { ...message, streaming: false }
            : message
        )))
      }
    } catch (error) {
      setOperationError(t('scene.stop_failed', undefined, { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      stoppingRef.current = false
      setStopping(false)
    }
  }, [send, setActiveTurn, t])

  const renameSession = useCallback(async (id: string, title: string): Promise<boolean> => {
    const next = title.trim()
    if (!next) return false
    try {
      const result = await send('session.rename', { session_id: id, sessionId: id, title: next })
      if (result.ok === false) throw new Error(textOf(result.error) || 'session.rename rejected')
      setSessions(previous => previous.map(item => item.id === id ? { ...item, title: next } : item))
      return true
    } catch (error) {
      setOperationError(t('scene.session_rename_failed', undefined, { error: error instanceof Error ? error.message : String(error) }))
      return false
    }
  }, [send, t])

  const deleteSession = useCallback(async (id: string): Promise<boolean> => {
    try {
      const result = await send('session.delete', { session_id: id, sessionId: id })
      if (result.ok === false) throw new Error(textOf(result.error) || 'session.delete rejected')
    } catch (error) {
      setOperationError(t('scene.session_delete_failed', undefined, { error: error instanceof Error ? error.message : String(error) }))
      return false
    }
    forgetSessionTasks(id)
    let remaining: SceneSession[] | null = null
    let suggested = ''
    try {
      const listed = await send('session.list', {})
      if (listed.ok !== false && Array.isArray(listed.sessions)) {
        remaining = normalizeSessions(listed.sessions).filter(item => item.id !== id)
        suggested = String(listed.current_session_id || '')
      }
    } catch {
      // 删除已经成功；列表拿不到时按本地状态收缩。
    }
    setSessions(previous => remaining ?? previous.filter(item => item.id !== id))
    // 主进程删掉当前会话时会自己换会话并先发 session.changed，回执到达时界面通常已经切走了；还停在原处才需要自己换。
    if (activeSessionRef.current === id) {
      const pool = remaining ?? sessionsRef.current.filter(item => item.id !== id)
      // 优先主进程建议的会话，其次最近的可续写会话，最后才落到只读的旧会话。
      const next = pool.find(item => item.id === suggested) ?? pool.find(item => !item.readonly) ?? pool[0]
      if (next) await loadSession(next.id)
      else await createSession()
    }
    return true
  }, [send, t, forgetSessionTasks, loadSession, createSession])

  return {
    messages,
    sessions,
    sessionId,
    activeSession,
    draft,
    setDraft: updateDraft,
    streaming,
    asrListening,
    provider,
    model,
    models,
    selectModel,
    sessionChange,
    error: operationError,
    loadSession,
    createSession,
    sendText,
    reportProblem,
    toggleMic,
    readonly,
    replying,
    stopping,
    abortReply,
    renameSession,
    deleteSession,
    refreshSessions,
    tasks: tasksApi.tasks,
    approvals: tasksApi.approvals,
    approvalsNow: tasksApi.now,
    pendingApprovalCount: tasksApi.pendingApprovalCount,
    cancellingTasks: tasksApi.cancelling,
    decidingApprovals: tasksApi.deciding,
    cancelTask: tasksApi.cancelTask,
    decideApproval: tasksApi.decideApproval,
  }
}
