/**
 * Chat + work session state for the Amadeus scene shell.
 *
 * Reuses the existing backend protocol and the existing chat/work activity
 * projections instead of introducing a second state model: the scene and the
 * legacy chat page both read the same session, messages and provider runs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  activitiesFromProviderRuns,
  applyProviderEvent,
  applyProviderResult,
  type ChatWorkActivityRun,
} from '../chatWorkActivity'
import type { ChatProjectSummary } from '../chatSessionTypes'
import { chatTranslationCandidates, chatTranslationKey } from '../chatTranslationState'
import { ATTACHMENT_ONLY_TEXT, visualPayload, type VisualAttachment } from './visualAttachment'
import {
  asrDraftOutcome,
  interruptedTurns,
  isStaleTurn,
  mayApplySession,
  observerNote,
} from './sceneStreamState'
import {
  reconcileLoadedMessages,
  type SceneMessage,
} from './sceneMessageReconciliation'

export type { SceneMessage } from './sceneMessageReconciliation'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

export type SceneSession = {
  id: string
  title: string
}

export type SceneSessionChange = {
  sequence: number
  sessionId: string
  source: string
  clientRequestId: string
}

export type SceneSessionOperationResult = {
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
      const role = value.role === 'assistant' || value.role === 'system' ? value.role : 'user'
      const turnId = String(value.turn_id ?? value.turnId ?? '') || undefined
      const text = String(value.content ?? value.text ?? '')
      const authoritativeId = String(value.id ?? value.message_id ?? value.messageId ?? '')
      const stableKey = `${role}\u0000${turnId || ''}\u0000${text}`
      const occurrence = occurrences.get(stableKey) || 0
      occurrences.set(stableKey, occurrence + 1)
      return {
        id: authoritativeId || `history:${stableMessageHash(stableKey)}:${occurrence}`,
        identity: authoritativeId ? 'authoritative' : 'derived',
        role,
        text,
        sessionId: String(value.session_id ?? value.sessionId ?? sessionId) || undefined,
        turnId,
        streaming: false,
        local: false,
      } as SceneMessage
    })
    .filter(message => message.text)
}

function normalizeSessions(items: unknown): SceneSession[] {
  if (!Array.isArray(items)) return []
  return items
    .map(item => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return { id: String(value.id || ''), title: String(value.title || '') }
    })
    .filter(session => session.id)
}

function normalizeProjects(items: unknown): ChatProjectSummary[] {
  if (!Array.isArray(items)) return []
  return items.flatMap(item => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const projectId = String(value.projectId ?? value.project_id ?? value.id ?? '')
    if (!projectId) return []
    const counts = value.counts && typeof value.counts === 'object'
      ? value.counts as Record<string, unknown>
      : value
    return [{
      projectId,
      name: String(value.name ?? value.projectName ?? value.project_name ?? projectId),
      latestTaskTitle: String(value.latestTaskTitle ?? value.latest_task_title ?? '') || undefined,
      counts: {
        current: Number(counts.current || 0),
        needsYou: Number(counts.needsYou ?? counts.needs_you ?? 0),
        running: Number(counts.running || 0),
        history: Number(counts.history || 0),
      },
    }]
  })
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
  const [projects, setProjects] = useState<ChatProjectSummary[]>([])
  const [sessionId, setSessionId] = useState('')
  const [activities, setActivities] = useState<ChatWorkActivityRun[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [asrListening, setAsrListening] = useState(false)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<{ value: string; label: string }[]>([])
  const [translationEnabled, setTranslationEnabled] = useState(false)
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const [sessionChange, setSessionChange] = useState<SceneSessionChange | null>(null)
  const [operationError, setOperationError] = useState('')
  const activeSessionRef = useRef('')
  const streamingTextRef = useRef('')
  const draftRef = useRef('')
  /**
   * Monotonic count of composer edits. Comparing it instead of the text means
   * deleting the draft and retyping the same characters still counts as a new
   * edit, so an in-flight acknowledgement cannot wipe it.
   */
  const draftEditRef = useRef(0)
  const updateDraft = useCallback((value: string) => {
    draftEditRef.current += 1
    setDraft(value)
  }, [])
  /** Guards against a second submit while one is in flight. */
  const sendingRef = useRef(false)
  /**
   * Turns whose stream the user has already stopped. Kept as its own set so a
   * new turn is never silenced by an older interrupt.
   */
  // Only live terminal transitions become completions. Runs loaded from the
  // activity journal are history: announcing them would notify the user about
  // work that finished before this window opened.
  const [completions, setCompletions] = useState<Array<{ runId: string; task: string; provider: string }>>([])
  const completionSeenRef = useRef<Set<string>>(new Set())
  // Turns the user stopped: the rest of their stream must be ignored, otherwise
  // an interrupted answer keeps growing after the user cancelled it.
  const interruptedTurnsRef = useRef<Set<string>>(new Set())
  const activeTurnRef = useRef('')
  /** Session the user most recently asked to load, and that request's order. */
  const requestedSessionRef = useRef('')
  const loadGenerationRef = useRef(0)
  /** User intents supersede older loads/creates even if the server reuses an id. */
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
  const observerNotesRef = useRef<Set<string>>(new Set())
  const translationGenerationRef = useRef(0)
  const translationRequestedRef = useRef<Set<string>>(new Set())

  const applySessionPayload = useCallback((payload: Record<string, unknown>, options: { notify?: boolean } = {}) => {
    if (Array.isArray(payload.sessions)) setSessions(normalizeSessions(payload.sessions))
    if (Array.isArray(payload.projects)) setProjects(normalizeProjects(payload.projects))
    const session = payload.session && typeof payload.session === 'object'
      ? payload.session as Record<string, unknown>
      : undefined
    const nextId = String(payload.current_session_id || session?.id || '')
    const switched = Boolean(nextId) && activeSessionRef.current !== nextId
    if (nextId) {
      activeSessionRef.current = nextId
      setSessionId(nextId)
      if (switched) {
        // Stream bookkeeping is per turn, not per session: switching sessions
        // must not let the previous session's interrupted stream silence the
        // new one.
        interruptedTurnsRef.current = new Set()
        activeTurnRef.current = ''
        observerNotesRef.current = new Set()
        streamingTextRef.current = ''
        setStreaming(false)
        setActivities([])
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
      translationGenerationRef.current += 1
      translationRequestedRef.current.clear()
      setTranslations({})
    } else if (switched) {
      // A session switch without a message payload is still a switch. Do not
      // leak the old conversation into the newly selected session while its
      // authoritative history is being loaded.
      setMessages([])
      streamingTextRef.current = ''
      setStreaming(false)
      translationGenerationRef.current += 1
      translationRequestedRef.current.clear()
      setTranslations({})
    }
    return nextId
  }, [])

  const hydrateActivities = useCallback(async (id: string) => {
    if (!id) return
    try {
      const response = await send('provider.activity.list', { session_id: id })
      if (activeSessionRef.current !== id) return
      const hydrated = activitiesFromProviderRuns(response.runs, id)
      setActivities(previous => [
        ...previous.filter(run => run.sessionId !== id),
        ...hydrated,
      ])
    } catch {
      // A missing activity feed must not blank the work log for other sessions.
    }
  }, [send])

  const loadSession = useCallback(async (id: string): Promise<SceneSessionOperationResult> => {
    // The user asked for `id`: mark that request as the newest one. A response
    // is accepted only when it still is the newest, so an out-of-order reply for
    // a session the user already left cannot overwrite the screen. Comparing
    // against the *previous* active session would reject the legitimate switch
    // the user just made.
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
      await hydrateActivities(activeId || id)
      return activeId ? { status: 'applied', sessionId: activeId } : { status: 'unknown' }
    } catch (error) {
      if (intent === sessionIntentRef.current && generation === loadGenerationRef.current) {
        setOperationError(`${operationStatus(error) === 'rejected' ? '任务加载失败' : '任务加载状态未知'}：${error instanceof Error ? error.message : String(error)}`)
      }
      return { status: operationStatus(error), error: error instanceof Error ? error.message : String(error) }
    } finally {
      finishOperation(requestId)
    }
  }, [send, applySessionPayload, hydrateActivities])

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
      // A session.changed event may be the server's broadcast for this create and
      // can legitimately arrive before the RPC acknowledgement. Accept it when
      // the acknowledgement names the session that is already on screen; reject
      // only a response superseded by a different session operation.
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

  const createProject = useCallback(async (workspacePath: string): Promise<Record<string, unknown> | null> => {
    const { requestId, intent } = beginOperation()
    const generation = ++loadGenerationRef.current
    setOperationError('')
    try {
      const response = await send('project.create', { workspace_path: workspacePath, client_request_id: requestId })
      if (intent !== sessionIntentRef.current || generation !== loadGenerationRef.current) return null
      if (response.ok === false) {
        setOperationError(`项目创建失败：${String(response.error || 'project.create rejected')}`)
        return null
      }
      applySessionPayload(response)
      return response
    } catch (error) {
      if (intent === sessionIntentRef.current) {
        const rejected = error && typeof error === 'object' && (error as { kind?: unknown }).kind === 'rejected'
        setOperationError(`${rejected ? '项目创建失败' : '项目创建状态未知'}：${error instanceof Error ? error.message : String(error)}`)
      }
      return null
    } finally {
      finishOperation(requestId)
    }
  }, [send, applySessionPayload])

  const createProjectSession = useCallback(async (projectId: string, title: string): Promise<boolean> => {
    const { requestId, intent } = beginOperation()
    const generation = ++loadGenerationRef.current
    setOperationError('')
    try {
      const response = await send('session.create', { project_id: projectId, title, client_request_id: requestId })
      const responseId = String(
        response.current_session_id
          || (response.session && typeof response.session === 'object'
            ? (response.session as Record<string, unknown>).id
            : '')
          || '',
      )
      if (intent !== sessionIntentRef.current) return false
      if (generation !== loadGenerationRef.current && activeSessionRef.current !== responseId) return false
      if (response.ok === false) {
        setOperationError(`项目任务创建失败：${String(response.error || 'session.create rejected')}`)
        return false
      }
      applySessionPayload(response)
      return true
    } catch (error) {
      if (intent === sessionIntentRef.current) {
        const rejected = error && typeof error === 'object' && (error as { kind?: unknown }).kind === 'rejected'
        setOperationError(`${rejected ? '项目任务创建失败' : '项目任务创建状态未知'}：${error instanceof Error ? error.message : String(error)}`)
      }
      return false
    } finally {
      finishOperation(requestId)
    }
  }, [send, applySessionPayload])

  const openContext = useCallback(async (projectId: string, workItemId: string): Promise<SceneSessionOperationResult> => {
    const { requestId, intent } = beginOperation()
    const generation = ++loadGenerationRef.current
    setOperationError('')
    try {
      const response = await send('session.open_context', {
        project_id: projectId,
        work_item_id: workItemId,
        client_request_id: requestId,
      })
      const responseId = String(
        response.current_session_id
          || (response.session && typeof response.session === 'object'
            ? (response.session as Record<string, unknown>).id
            : '')
          || '',
      )
      if (intent !== sessionIntentRef.current || response.ok === false) {
        if (intent === sessionIntentRef.current && response.ok === false) {
          setOperationError(`打开任务上下文失败：${String(response.error || 'session.open_context rejected')}`)
        }
        return response.ok === false
          ? { status: 'rejected', error: String(response.error || 'session.open_context rejected') }
          : { status: 'superseded' }
      }
      if (generation !== loadGenerationRef.current && activeSessionRef.current !== responseId) return { status: 'superseded' }
      const activeId = applySessionPayload(response)
      const accepted = activeId
        ? {
            status: 'applied' as const,
            sessionId: activeId,
            clientRequestId: String(response.client_request_id || requestId),
            sequence: sessionChangeSequenceRef.current,
          }
        : { status: 'unknown' as const }
      await hydrateActivities(activeId)
      if (
        accepted.status !== 'applied'
        || intent !== sessionIntentRef.current
        || generation !== loadGenerationRef.current
        || activeSessionRef.current !== accepted.sessionId
      ) return { status: 'superseded' }
      return accepted
    } catch (error) {
      if (intent === sessionIntentRef.current) {
        const rejected = error && typeof error === 'object' && (error as { kind?: unknown }).kind === 'rejected'
        setOperationError(`${rejected ? '打开任务上下文失败' : '打开任务上下文状态未知'}：${error instanceof Error ? error.message : String(error)}`)
      }
      return { status: operationStatus(error), error: error instanceof Error ? error.message : String(error) }
    } finally {
      finishOperation(requestId)
    }
  }, [send, applySessionPayload, hydrateActivities])

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

  // Initial session discovery: the current task's messages come from
  // `session.load`, exactly like the chat page does.
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
        // The backend may still be starting; events below keep the scene live.
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

  // Provider selection mirrors the chat page so both surfaces send the same model.
  useEffect(() => {
    if (!connected) return
    const applyConfig = (payload: Record<string, unknown>) => {
      const values = payload.values && typeof payload.values === 'object'
        ? payload.values as Record<string, unknown>
        : payload
      if (values.llm_provider !== undefined) {
        setProvider(String(values.llm_provider))
      }
      if (values.chat_translation_subtitles_enabled !== undefined) {
        setTranslationEnabled(values.chat_translation_subtitles_enabled === true)
      }
    }
    const unsubscribe = subscribe('system.config', payload => applyConfig(payload))
    send('system.get_config', {}).then(payload => applyConfig(payload)).catch(() => {})
    return () => unsubscribe()
  }, [connected, send, subscribe])

  // The model in use, for the composer. It belongs to the session (a new one starts on the default),
  // so it is re-read whenever the session changes. `pi.models` is refused while a reply is running,
  // so a read that could not happen is retried when the turn ends, not on every turn.
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
        // Refused while a reload or reply is in flight; nothing else re-triggers this read.
        if (modelRetry < 10) timer = setTimeout(() => setModelRetry(count => count + 1), 1000)
        return
      }
      if (typeof result.current === 'string') { setModel(result.current); modelSessionRef.current = sessionId }
      if (Array.isArray(result.models)) setModels(result.models as { value: string; label: string }[])
      setModelRetry(0)
    }).catch(() => {})
    return () => { cancelled = true; clearTimeout(timer) }
  }, [connected, send, sessionId, streaming, model, models.length, modelRetry])

  useEffect(() => {
    if (!translationEnabled) {
      translationGenerationRef.current += 1
      translationRequestedRef.current.clear()
      setTranslations({})
      return
    }
    const generation = translationGenerationRef.current
    for (const candidate of chatTranslationCandidates(messages)) {
      if (translationRequestedRef.current.has(candidate.key)) continue
      translationRequestedRef.current.add(candidate.key)
      void send('chat.translate', { text: candidate.text, turn_id: candidate.turnId })
        .then(response => {
          if (generation !== translationGenerationRef.current) return
          const translation = String(response.translation || '').trim()
          if (translation) setTranslations(previous => ({ ...previous, [candidate.key]: translation }))
        })
        .catch(() => {
          if (generation === translationGenerationRef.current) translationRequestedRef.current.delete(candidate.key)
        })
    }
  }, [messages, send, translationEnabled])

  useEffect(() => { draftRef.current = draft }, [draft])

  useEffect(() => {
    const unsubscribers: Array<() => void> = []
    unsubscribers.push(subscribe('chat.token', params => {
      const turnId = String(params.turn_id ?? '')
      // An interrupted turn is finished: it must not claim the active-turn slot,
      // otherwise its stale stream would suppress the next live turn.
      if (isStaleTurn(turnId, interruptedTurnsRef.current)) return
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      if (turnId && activeTurnRef.current && turnId !== activeTurnRef.current) return
      if (turnId) activeTurnRef.current = turnId
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
          activeTurnRef.current = ''
        }
        return
      }
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      if (turnId && activeTurnRef.current && turnId !== activeTurnRef.current) return
      upsertAssistantMessage(turnId, text, false)
      streamingTextRef.current = ''
      setStreaming(false)
      if (activeTurnRef.current === turnId) activeTurnRef.current = ''
    }))
    unsubscribers.push(subscribe('chat.error', params => {
      const errorTurnId = String(params.turn_id ?? '')
      const session = eventSessionId(params)
      if (session && session !== activeSessionRef.current) return
      if (errorTurnId && activeTurnRef.current && errorTurnId !== activeTurnRef.current) return
      if (!errorTurnId && !activeTurnRef.current) return
      if (errorTurnId) interruptedTurnsRef.current.add(errorTurnId)
      if (!errorTurnId || activeTurnRef.current === errorTurnId) activeTurnRef.current = ''
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
      if (activeTurnRef.current === turnId) activeTurnRef.current = ''
    }))
    unsubscribers.push(subscribe('chat.observer_decision', params => {
      const note = observerNote(params, activeSessionRef.current, observerNotesRef.current)
      if (!note) return
      const identity = note.turnId.slice('work-observer:'.length)
      observerNotesRef.current.add(identity)
      upsertAssistantMessage(note.turnId, note.text, false)
    }))
    unsubscribers.push(subscribe('provider.event', params => {
      const sessionId = String(providerMetadata(params).session_id || providerMetadata(params).sessionId || '')
      if (!sessionId) return
      setActivities(previous => applyProviderEvent(previous, params))
      const type = String(params.type || '').toLowerCase()
      const payload = params.payload && typeof params.payload === 'object'
        ? params.payload as Record<string, unknown>
        : {}
      const status = String(payload.status || '').toLowerCase()
      // An attempt ending is not WorkItem completion: the notice only claims
      // that this work attempt ended.
      const ended = type === 'run.finished'
        && (status === '' || status === 'done' || status === 'succeeded' || status === 'success')
      if (!ended) return
      const runId = String(params.run_id || params.runId || '')
      if (!runId || completionSeenRef.current.has(runId)) return
      completionSeenRef.current.add(runId)
      setCompletions(previous => [...previous, {
        runId,
        task: String(payload.task || ''),
        provider: String(params.provider || ''),
      }])
    }))
    unsubscribers.push(subscribe('provider.result', params => {
      const sessionId = String(providerMetadata(params).session_id || providerMetadata(params).sessionId || '')
      if (!sessionId) return
      setActivities(previous => applyProviderResult(previous, params))
      const status = String(params.status || '').toLowerCase()
      const runId = String(params.run_id || params.runId || '')
      if (!runId || completionSeenRef.current.has(runId)) return
      if (status !== 'done' && status !== 'succeeded' && status !== 'success') return
      completionSeenRef.current.add(runId)
      setCompletions(previous => [...previous, {
        runId,
        task: String(params.task || ''),
        provider: String(params.provider || ''),
      }])
    }))
    unsubscribers.push(subscribe('session.changed', params => {
      // This is the only accepted session-change path for the scene. Other
      // consumers react to the resulting sessionChange record instead of
      // interpreting this raw broadcast, so ignored stale events cannot clear
      // unrelated UI state.
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
      const activeId = applySessionPayload(params, { notify: true })
      if (activeId) void hydrateActivities(activeId)
    }))
    // 首次发送后主进程才会给默认标题落时间戳；这里只更新列表标题，不触碰其它会话状态。
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
        // The wake pipeline already sent this utterance; showing it as a user
        // message (not a draft) is what keeps it from being sent twice.
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
  }, [subscribe, upsertAssistantMessage, applySessionPayload, hydrateActivities, updateDraft])

  const sendText = useCallback(async (rawText: string, attachment: VisualAttachment | null = null) => {
    const typed = rawText.trim()
    // A picture with no typed text is still a message, exactly like the chat page.
    const text = typed || (attachment ? ATTACHMENT_ONLY_TEXT : '')
    if (!text) return false
    // A picture the backend cannot read must not be sent as if it were handled.
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
        // A conversation needs a session: sending without one would post into a
        // session the loader never acknowledged.
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

      // The user's message and its turn identity exist BEFORE the request is
      // sent. A token that arrives before the confirmation then lands on a
      // conversation that already has this turn, instead of appearing above a
      // user message that has not been added yet.
      activeTurnRef.current = turnId
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
        // A timeout/disconnect does not prove the server rejected the request;
        // keep the turn as unknown rather than deleting a possibly accepted
        // message and encouraging a duplicate submission.
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
          if (activeTurnRef.current === turnId) activeTurnRef.current = ''
        }
        return false
      }
      if (activeSessionRef.current === targetSession) {
        setMessages(previous => previous.map(message => message.id === userMessageId
          ? { ...message, delivery: 'accepted' as const }
          : message))
      }
      // Clear only when the composer still holds the text that was sent: an
      // edit (including deleting and retyping the same characters) counts as a
      // new draft and must not be wiped.
      if (activeSessionRef.current === targetSession && draftEditRef.current === edit) {
        updateDraft('')
      }
      return activeSessionRef.current === targetSession
    } catch {
      // Session creation or an unexpected failure: keep the composer intact.
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
  }, [send, provider, createSession, updateDraft])

  /** Surfaces an attachment/vision failure in the conversation, not silently. */
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

  return {
    messages,
    sessions,
    projects,
    sessionId,
    activeSession,
    activities,
    draft,
    setDraft: updateDraft,
    streaming,
    asrListening,
    provider,
    model,
    models,
    selectModel,
    translationEnabled,
    translations,
    translationKey: chatTranslationKey,
    sessionChange,
    error: operationError,
    completions,
    loadSession,
    createSession,
    createProject,
    createProjectSession,
    openContext,
    sendText,
    reportProblem,
    toggleMic,
  }
}
