/**
 * Scene bridge lifecycle for the Amadeus main window.
 *
 * The scene art, character renderer and CRT are served by the existing
 * wallpaper asset/bridge host. The main window embeds that surface instead of
 * launching the macOS desktop companion, so the desktop wallpaper host stays an
 * optional projection rather than a prerequisite for the app window.
 *
 * Deliberate constraints:
 *   - "the backend returned a URL" is NOT "the scene rendered"; readiness comes
 *     from the embedded page itself, and a frame that never reports readiness
 *     times out into an error state rather than pretending to be a scene;
 *   - readiness messages are only trusted from this hook's own iframe, at the
 *     validated asset origin, for the current load generation.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

type SceneBridgeStatus = 'idle' | 'starting' | 'ready' | 'error'

/**
 * Whether the character sprite is actually drawn.
 *
 * `null` means the scene has not reported it yet. The scene and the character
 * are separate facts: a rendered room can still be missing Amadeus, and the user
 * asked for the character to be always visible, so this is tracked rather than
 * assumed.
 */
type CharacterPresence = boolean | null

type SceneBridgeState = {
  url: string
  /**
   * Opaque per-load token. It travels to the embedded page as a query parameter
   * and must come back on every readiness message, so a delayed message from an
   * earlier load (same origin, same frame) cannot be mistaken for the current
   * one. This is the "which load is this?" check that origin and frame identity
   * cannot provide.
   */
  loadToken: string
  assetOrigin: string
  status: SceneBridgeStatus
  error: string
  character: CharacterPresence
  /**
   * Increments for every adopted scene URL. Restarting the host can produce the
   * same URL, so the embedding surface keys the frame on this value: without it
   * React reuses the element, the document is never reloaded, and a recovered
   * scene would keep showing the old (failed) render forever.
   */
  loadId: number
}

const MAX_START_ATTEMPTS = 3
const SCENE_LOAD_TOKEN_PARAM = 'sceneLoadToken'
const RETRY_BASE_MS = 2000
const READY_TIMEOUT_MS = 20000

/** 每次加载生成独立的生命周期令牌，用于区分不同批次的页面握手。 */
function sceneLoadToken(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function isCurrentLoadMessage(
  messageToken: unknown,
  token: string,
): boolean {
  return Boolean(token) && String(messageToken || '') === token
}

/** 仅允许加载本地环回地址资源，隔离外部网络潜在的安全风险。 */
function validateSceneUrl(rawUrl: string): { url: string; assetOrigin: string } | null {
  try {
    const parsed = new URL(String(rawUrl || ''))
    if (parsed.protocol !== 'http:') return null
    if (parsed.hostname !== '127.0.0.1') return null
    if (parsed.username || parsed.password || parsed.hash) return null
    if (parsed.pathname !== '/scene/stage/index.html' && parsed.pathname !== '/render/web/wallpaper_engine.html') return null
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { url: parsed.toString(), assetOrigin: `http://127.0.0.1:${port}` }
  } catch {
    return null
  }
}

/**
 * True when a readiness message genuinely comes from the scene iframe at the
 * asset origin it was loaded from. Anything else (another window, another
 * origin, a frame that is not ours) is ignored.
 */
export function isTrustedSceneMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  frame: HTMLIFrameElement | null,
  assetOrigin: string,
): boolean {
  if (!frame || !assetOrigin) return false
  if (event.source !== frame.contentWindow) return false
  if (event.origin !== assetOrigin) return false
  const payload = event.data
  return Boolean(payload && typeof payload === 'object' && (payload as Record<string, unknown>).source === 'amadeus-scene')
}

export function useSceneBridge({
  send,
  subscribe,
  connected,
}: {
  send: SendFn
  subscribe: SubscribeFn
  connected: boolean
}) {
  const [state, setState] = useState<SceneBridgeState>({
    url: '',
    loadToken: '',
    assetOrigin: '',
    status: 'idle',
    error: '',
    character: null,
    loadId: 0,
  })
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [importingAssets, setImportingAssets] = useState(false)
  const tokenRef = useRef('')
  const generationRef = useRef(0)
  /** 标记当前有权报告就绪状态的加载代数，防止历史异步回调引发状态倒退。 */
  const activeGenerationRef = useRef(-1)
  const originRef = useRef('')
  const attemptsRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  const readyTimerRef = useRef<number | null>(null)
  const startRef = useRef<() => Promise<void>>(async () => {})

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    if (readyTimerRef.current !== null) {
      window.clearTimeout(readyTimerRef.current)
      readyTimerRef.current = null
    }
  }, [])

  const adopt = useCallback((payload: Record<string, unknown>, generation: number): boolean => {
    const validated = validateSceneUrl(String(payload.url || ''))
    if (!validated) {
      setState(previous => ({ ...previous, url: '', loadToken: '', assetOrigin: '', status: 'error', error: '场景后端返回了不可信的资源地址', character: null }))
      return false
    }
    attemptsRef.current = 0
    // 令牌由宿主生成并附带于 URL，使子页面只能回传宿主指定的认证值。
    const token = sceneLoadToken()
    const sceneUrl = new URL(validated.url)
    sceneUrl.searchParams.set(SCENE_LOAD_TOKEN_PARAM, token)
    tokenRef.current = token
    originRef.current = validated.assetOrigin
    activeGenerationRef.current = generation
    setState(previous => ({
      ...validated,
      url: sceneUrl.toString(),
      loadToken: token,
      status: 'starting',
      error: '',
      character: null,
      loadId: previous.loadId + 1,
    }))
    if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
    readyTimerRef.current = window.setTimeout(() => {
      readyTimerRef.current = null
      if (activeGenerationRef.current !== generation) return
      setState(previous => previous.status === 'ready'
        ? previous
        : { ...previous, status: 'error', error: '场景已加载但未完成渲染' })
    }, READY_TIMEOUT_MS)
    return true
  }, [])

  const start = useCallback(async () => {
    const generation = ++generationRef.current
    activeGenerationRef.current = -1
    tokenRef.current = ''
    originRef.current = ''
    clearTimers()
    setState(previous => previous.status === 'starting'
      ? previous
      : { ...previous, url: '', loadToken: '', assetOrigin: '', status: 'starting', error: '' })
    let retryable = true
    try {
      const response = await send('wallpaper.start', { scene: true, slice_host: 'wallpaper' })
      if (generationRef.current !== generation) return
      if (String(response.status) === 'error') {
        retryable = response.retryable !== false
        throw new Error(String(response.error || '场景后端启动失败'))
      }
      if (!adopt(response, generation)) return
    } catch (error) {
      if (generationRef.current !== generation) return
      const detail = error instanceof Error ? error.message : String(error)
      attemptsRef.current += 1
      setState(previous => ({ ...previous, url: '', loadToken: '', assetOrigin: '', status: 'error', error: detail, character: null }))
      if (retryable && attemptsRef.current < MAX_START_ATTEMPTS) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          void startRef.current()
        }, RETRY_BASE_MS * attemptsRef.current)
      }
    }
  }, [send, adopt, clearTimers])

  startRef.current = start

  const retry = useCallback(async () => {
    attemptsRef.current = 0
    await start()
  }, [start])

  const importAssets = useCallback(async () => {
    clearTimers()
    const generation = ++generationRef.current
    activeGenerationRef.current = -1
    tokenRef.current = ''
    originRef.current = ''
    setImportingAssets(true)
    try {
      const result = await send('emote.import')
      if (generationRef.current !== generation || result.cancelled) return
      if (!result.ok) throw new Error(String(result.error || '角色资源导入失败'))
      await retry()
    } catch (error) {
      if (generationRef.current === generation) setState(previous => ({ ...previous, status: 'error', error: error instanceof Error ? error.message : String(error) }))
    } finally { setImportingAssets(false) }
  }, [clearTimers, retry, send])

  const reportSceneMessage = useCallback((event: MessageEvent) => {
    if (!isTrustedSceneMessage(event, frameRef.current, originRef.current)) return
    const payload = event.data as Record<string, unknown>
    // 异步握手消息可能跨生命周期到达，需依赖每轮加载唯一的令牌过滤陈旧消息。
    if (!isCurrentLoadMessage(payload.sceneLoadToken, tokenRef.current)) return
    if (payload.status === 'ready') {
      if (readyTimerRef.current !== null) {
        window.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
      }
      setState(previous => ({
        ...previous,
        status: 'ready',
        error: '',
        character: typeof payload.character === 'boolean' ? payload.character : previous.character,
      }))
    } else if (payload.status === 'character') {
      // 收到第一帧画面作为渲染真正就绪的终态信号。
      setState(previous => (
        typeof payload.character === 'boolean' ? { ...previous, character: payload.character } : previous
      ))
    } else if (payload.status === 'failed') {
      setState(previous => ({ ...previous, status: 'error', error: '场景渲染失败' }))
    }
  }, [])

  const reportFrameError = useCallback(() => {
    setState(previous => ({ ...previous, status: 'error', error: '场景页面加载失败' }))
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => reportSceneMessage(event)
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [reportSceneMessage])

  useEffect(() => {
    if (!connected) {
      // 后端连接断开时取消所有挂起流程，防止残留回调意外激活失效场景。
      generationRef.current += 1
      activeGenerationRef.current = -1
      clearTimers()
      setState(previous => ({ ...previous, url: '', assetOrigin: '', status: 'idle', error: '' }))
      return
    }
    void start()
    return subscribe('scene.reload', () => { void startRef.current() })
  }, [connected, start, subscribe, clearTimers])

  useEffect(() => () => {
    generationRef.current += 1
    activeGenerationRef.current = -1
    clearTimers()
  }, [clearTimers])

  return { ...state, frameRef: frameRef as RefObject<HTMLIFrameElement | null>, retry, importAssets, importingAssets, reportFrameError }
}
