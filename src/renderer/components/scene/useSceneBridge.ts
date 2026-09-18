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
 *     validated asset origin, for the current load generation;
 *   - a deliberate stop is not a crash: it must not auto-restart.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

export type SceneBridgeStatus = 'idle' | 'starting' | 'ready' | 'error'

/**
 * Whether the character sprite is actually drawn.
 *
 * `null` means the scene has not reported it yet. The scene and the character
 * are separate facts: a rendered room can still be missing Amadeus, and the user
 * asked for the character to be always visible, so this is tracked rather than
 * assumed.
 */
export type CharacterPresence = boolean | null

export type SceneBridgeState = {
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

/** Random per-load token; never a secret, only proof of "which load". */
export function sceneLoadToken(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * True when a readiness message belongs to the load identified by `token`.
 * A message without the token, or with an outdated one, is ignored: it cannot
 * describe the scene that is mounted now.
 */
export function isCurrentLoadMessage(
  messageToken: unknown,
  token: string,
): boolean {
  return Boolean(token) && String(messageToken || '') === token
}

/** The embedded scene may only come from this exact loopback page. */
export function validateSceneUrl(rawUrl: string): { url: string; assetOrigin: string } | null {
  try {
    const parsed = new URL(String(rawUrl || ''))
    if (parsed.protocol !== 'http:') return null
    if (parsed.hostname !== '127.0.0.1') return null
    if (parsed.username || parsed.password || parsed.hash) return null
    if (parsed.pathname !== '/render/web/wallpaper_engine.html') return null
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    const bridgePort = Number(parsed.searchParams.get('bridgePort'))
    if (!Number.isInteger(bridgePort) || bridgePort <= 0 || bridgePort > 65535) return null
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
  const tokenRef = useRef('')
  const generationRef = useRef(0)
  /** Generation whose load may still report readiness. Not the same as `generationRef`. */
  const activeGenerationRef = useRef(-1)
  const urlRef = useRef('')
  const originRef = useRef('')
  const attemptsRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  const readyTimerRef = useRef<number | null>(null)
  /** Set while a deliberate stop is in flight, so the exit event is not a crash. */
  const deliberateStopRef = useRef(false)
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
    // The token is generated here and appended to the URL, so the page echoes a
    // value this hook chose rather than one the page could pick itself.
    const token = sceneLoadToken()
    const sceneUrl = new URL(validated.url)
    // Work and Artifacts live in the main window, including when this view
    // reuses a desktop host whose URL still enables the wallpaper canvas.
    sceneUrl.searchParams.set('sliceHost', 'electron')
    sceneUrl.searchParams.set(SCENE_LOAD_TOKEN_PARAM, token)
    urlRef.current = sceneUrl.toString()
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
    urlRef.current = ''
    tokenRef.current = ''
    originRef.current = ''
    clearTimers()
    deliberateStopRef.current = false
    setState(previous => previous.status === 'starting'
      ? previous
      : { ...previous, url: '', loadToken: '', assetOrigin: '', status: 'starting', error: '' })
    try {
      const response = await send('wallpaper.start', { scene: true, slice_host: 'wallpaper' })
      if (generationRef.current !== generation) return
      if (String(response.status) === 'error') {
        throw new Error(String(response.error || '场景后端启动失败'))
      }
      if (!adopt(response, generation)) return
    } catch (error) {
      if (generationRef.current !== generation) return
      const detail = error instanceof Error ? error.message : String(error)
      attemptsRef.current += 1
      setState(previous => ({ ...previous, url: '', loadToken: '', assetOrigin: '', status: 'error', error: detail, character: null }))
      if (attemptsRef.current < MAX_START_ATTEMPTS) {
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

  /**
   * Stops the asset/bridge host behind the scene. Only the debug backend console
   * exposes this. A deliberate stop must not be mistaken for a crash, so it
   * invalidates the generation and suppresses the restart that the exit event
   * would otherwise trigger.
   */
  const stop = useCallback(async () => {
    generationRef.current += 1
    activeGenerationRef.current = -1
    deliberateStopRef.current = true
    clearTimers()
    urlRef.current = ''
    tokenRef.current = ''
    originRef.current = ''
    setState(previous => ({ url: '', loadToken: '', assetOrigin: '', status: 'idle', error: '', character: null, loadId: previous.loadId }))
    try {
      await send('wallpaper.stop', {})
    } catch {
      // The host may already be gone.
    }
  }, [send, clearTimers])

  const reportSceneMessage = useCallback((event: MessageEvent) => {
    if (!isTrustedSceneMessage(event, frameRef.current, originRef.current)) return
    const payload = event.data as Record<string, unknown>
    // Delayed messages from a previous load share origin and frame identity, so
    // the per-load token is what actually separates them.
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
      // Frames arrive after the scene is ready; this is the later signal.
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
      // The backend connection that owns this scene went away: cancel every
      // in-flight start so a stale response cannot revive the scene.
      generationRef.current += 1
      activeGenerationRef.current = -1
      clearTimers()
      setState(previous => ({ ...previous, url: '', assetOrigin: '', status: 'idle', error: '' }))
      return
    }
    void start()
    const unsubscribeReady = subscribe('wallpaper.ready', () => {
      // The host announced readiness; if this hook has no validated URL yet,
      // ask again. Read the URL from a ref so the handler never acts on a stale
      // render closure.
      if (!urlRef.current) void startRef.current()
    })
    const unsubscribeExited = subscribe('wallpaper.exited', () => {
      if (deliberateStopRef.current) return
      attemptsRef.current = 0
      urlRef.current = ''
      tokenRef.current = ''
      originRef.current = ''
      setState(previous => ({ ...previous, url: '', loadToken: '', assetOrigin: '', status: 'starting', error: '' }))
      void startRef.current()
    })
    return () => {
      unsubscribeReady()
      unsubscribeExited()
    }
  }, [connected, start, subscribe, clearTimers])

  useEffect(() => () => {
    generationRef.current += 1
    activeGenerationRef.current = -1
    clearTimers()
  }, [clearTimers])

  return { ...state, frameRef: frameRef as RefObject<HTMLIFrameElement | null>, retry, stop, reportFrameError }
}
