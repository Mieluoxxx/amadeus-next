/**
 * Amadeus scene shell — the normal Electron main window.
 *
 * The scene fills the window; the transcript and settings use a shared sidebar,
 * while the reply/input dock occupies the bottom region. The framing shifts so
 * the CRT cabinet is never covered. Nothing here may hide the
 * character, and the window never switches to a separate chat mode to talk.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Loader2,
  MessageSquare,
  Plus,
  RotateCw,
  SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '../../i18n'
import SettingsPage from '../SettingsPage'
import {
  sceneFrameStyle,
  toggleScenePanel,
  type SceneOverlay,
  type ScenePanelKind,
  type SceneRegion,
} from './sceneLayout'
import {
  prepareImageAttachment,
  supportsDirectImage,
  type VisualAttachment,
} from './visualAttachment'
import { useSceneBridge } from './useSceneBridge'
import { useSceneTransition } from './useSceneTransition'
import { useSceneSession } from './useSceneSession'
import SceneDock from './SceneDock'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

function overlayStyle(region: SceneRegion) {
  return { left: region.x, top: region.y, width: region.width, height: region.height }
}

export default function ScenePage({
  send,
  subscribe,
  connected,
}: {
  send: SendFn
  subscribe: SubscribeFn
  connected: boolean
}) {
  const { t } = useI18n()
  const session = useSceneSession({ send, subscribe, connected })
  const bridge = useSceneBridge({ send, subscribe, connected })
  const [panel, setPanel] = useState<ScenePanelKind | null>(null)
  const [acknowledgedNotices, setAcknowledgedNotices] = useState<string[]>([])
  const [pendingAttachment, setPendingAttachment] = useState<VisualAttachment | null>(null)
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setViewport({
      width: window.innerWidth,
      height: window.innerHeight,
    })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const transition = useSceneTransition(viewport.width, viewport.height, panel, bridge.frameRef, bridge.loadId)
  const layout = transition.layout
  const frameStyle = useMemo(() => sceneFrameStyle(layout.fit), [layout.fit])
  const notices = useMemo(
    () => session.error
      ? [{ key: `session-error:${session.error}`, tone: 'error' as const, text: session.error }]
      : [],
    [session.error],
  )
  const visibleNotices = useMemo(
    () => notices.filter(notice => !acknowledgedNotices.includes(notice.key)),
    [notices, acknowledgedNotices],
  )

  // Dismissal is per-task: an error the user hid in one task must not stay hidden in the next.
  useEffect(() => setAcknowledgedNotices([]), [session.sessionId])

  // React only to the accepted session-change record from useSceneSession. Raw
  // broadcasts are intentionally not consumed here: a stale event must not
  // reopen the transcript.
  useEffect(() => {
    const change = session.sessionChange
    if (!change) return
    if (change.source === 'slice') setPanel('transcript')
  }, [session.sessionChange])

  // ⌘N stays inside the scene: it starts a new task and shows it.
  useEffect(() => {
    const onNewSession = () => {
      setPanel('transcript')
      void session.createSession()
    }
    window.addEventListener('amadeus:new-session', onNewSession)
    return () => window.removeEventListener('amadeus:new-session', onNewSession)
  }, [session])

  const togglePanel = useCallback((kind: ScenePanelKind) => {
    setPanel(current => toggleScenePanel(current, kind))
  }, [])

  const toolbarRight = Math.max(12, viewport.width - (layout.scene.x + layout.scene.width) + 12)
  /**
   * One submit path for the button and for Enter. The attachment travels with
   * the same call in both cases, the send is awaited, and the composer is
   * cleared only after the backend accepted it — a failed send keeps the text
   * and the picture so nothing the user typed is lost.
   */
  const submit = useCallback(async () => {
    const attachment = pendingAttachment
    const sent = await session.sendText(session.draft, attachment)
    if (sent) {
      // Clear only the attachment that was actually sent: if a new one was
      // picked while the send was in flight, it must survive.
      setPendingAttachment(current => (current === attachment ? null : current))
    }
  }, [session, pendingAttachment])

  const dock = (
    <SceneDock
      connected={connected}
      draft={session.draft}
      onDraftChange={session.setDraft}
      onSubmit={() => { void submit() }}
      onToggleMic={session.toggleMic}
      asrListening={session.asrListening}
      streaming={session.streaming}
      sessionTitle={session.activeSession?.title || ''}
      model={session.model}
      models={session.models}
      onSelectModel={value => void session.selectModel(value)}
      attachment={pendingAttachment}
      onClearAttachment={() => setPendingAttachment(null)}
      onPickAttachment={file => {
        void (async () => {
          try {
            setPendingAttachment(await prepareImageAttachment(file))
          } catch (error) {
            const code = error instanceof Error ? error.message : ''
            session.reportProblem(
              code.startsWith('chat.error.') ? t(code as never, code) : String(error),
            )
          }
        })()
      }}
      canAttach={supportsDirectImage(session.provider)}
    />
  )

  return (
    <div className="h-full w-full relative overflow-clip bg-[#05070b] text-[var(--text)]" data-scene-transition={transition.animating ? 'running' : 'idle'}>
      <div
        className="absolute overflow-hidden"
        data-testid="scene-region"
        data-cabinet={JSON.stringify(layout.cabinet)}
        data-seam={layout.seam ? '1' : '0'}
        data-character={bridge.character === null ? 'unknown' : bridge.character ? 'drawn' : 'missing'}
        style={{
          left: layout.scene.x,
          top: layout.scene.y,
          width: layout.scene.width,
          height: layout.scene.height,
          // Behind the frame sits the same artwork, so a frame that had to drop
          // below cover scale still reads as one continuous picture.
          background: bridge.assetOrigin
            ? `#05070b url(${bridge.assetOrigin}/scene/room/background.png) center/cover no-repeat`
            : '#05070b',
        }}
      >
        {bridge.url ? (
          <iframe
            // Keyed by load generation: a restarted scene must get a fresh
            // document even when the asset URL is unchanged.
            key={bridge.loadId}
            ref={bridge.frameRef}
            title="Amadeus scene"
            data-testid="scene-frame"
            src={bridge.url}
            onError={bridge.reportFrameError}
            style={{ ...frameStyle, position: 'absolute', border: 'none', opacity: bridge.status === 'ready' ? 1 : 0 }}
            // No microphone permission: the scene only renders the character.
            allow="autoplay"
          />
        ) : (
          <ScenePlaceholder
            status={bridge.status}
            error={bridge.error}
            connected={connected}
            onRetry={bridge.retry}
            onImport={bridge.importAssets}
            importing={bridge.importingAssets}
          />
        )}
        {bridge.url && bridge.status !== 'ready' ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <ScenePlaceholder
              status={bridge.status}
              error={bridge.error}
              connected={connected}
              onRetry={bridge.retry}
              onImport={bridge.importAssets}
              importing={bridge.importingAssets}
            />
          </div>
        ) : null}
      </div>

      {/* Keep native window dragging above the iframe and below interactive chrome. */}
      <div
        aria-hidden="true"
        className="absolute z-10 select-none [-webkit-app-region:drag]"
        style={overlayStyle(layout.chrome.region)}
        data-testid="scene-drag-region"
      />

      <div
        className="absolute z-30 flex items-center gap-1 [-webkit-app-region:no-drag]"
        style={{ right: toolbarRight, top: 12 }}
        data-testid="scene-toolbar"
      >
        <SceneToolbarButton
          active={panel === 'transcript'}
          icon={<MessageSquare className="w-3.5 h-3.5" />}
          label={t('scene.transcript')}
          testId="scene-open-transcript"
          onClick={() => togglePanel('transcript')}
        />
        <SceneToolbarButton
          active={panel === 'more'}
          icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
          label={t('scene.settings')}
          testId="scene-open-more"
          onClick={() => togglePanel('more')}
        />
      </div>

      <div
        className="absolute z-30 flex flex-col gap-1 overflow-hidden pointer-events-none [&>*]:pointer-events-auto [&>*]:[-webkit-app-region:no-drag]"
        style={overlayStyle(layout.status.region)}
        data-testid="scene-event-tray"
      >
        <SceneNotices
          notices={visibleNotices}
          unresolvedCount={notices.length}
          onDismiss={key => setAcknowledgedNotices(previous => [...previous, key])}
          onOpenSettings={() => setPanel('more')}
        />
      </div>

      {transition.dock && (
        <div
          ref={transition.dockRef}
          inert={!layout.dock}
          aria-hidden={!layout.dock}
          className="scene-dock-frame absolute z-20"
          data-testid="scene-dock"
          style={overlayStyle(transition.dock.region)}
        >
          {dock}
        </div>
      )}

      {transition.panel && (
        <ScenePanelFrame
          panel={transition.panel}
          panelRef={transition.panelRef}
          exiting={!layout.panel}
          session={session}
          send={send}
          subscribe={subscribe}
        />
      )}
    </div>
  )
}

function SceneNotices({
  notices,
  unresolvedCount,
  onDismiss,
  onOpenSettings,
}: {
  notices: Array<{ key: string; tone: 'attention' | 'error'; text: string }>
  unresolvedCount: number
  onDismiss: (key: string) => void
  onOpenSettings: () => void
}) {
  const { t } = useI18n()
  if (unresolvedCount === 0) return null
  if (notices.length === 0) {
    // Acknowledged but still unresolved: the entry stays discoverable.
    return (
      <button
        onClick={onOpenSettings}
        data-testid="scene-notice-summary"
        className="flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-500/30 bg-[#1c1a12]/95 px-3 py-1.5 text-[11px] text-amber-200 backdrop-blur-xl"
      >
        <AlertTriangle className="w-3 h-3" />
        <span>{unresolvedCount}</span>
        <ArrowRight className="w-3 h-3" />
      </button>
    )
  }
  const [first] = notices
  return (
    // Bounded to the reserved chrome band so the notice stack can never reach
    // into the area the layout keeps clear for the character.
    <div
      className="flex max-w-full shrink-0 items-center gap-1.5 overflow-hidden"
      style={{ maxHeight: 44 }}
      data-testid="scene-notices"
    >
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 rounded-xl border px-3 py-1.5 text-[11px] backdrop-blur-xl',
          first.tone === 'error'
            ? 'border-rose-500/30 bg-[#1c1216]/95 text-rose-300'
            : 'border-amber-500/30 bg-[#1c1a12]/95 text-amber-200',
        )}
      >
        <AlertTriangle className="w-3 h-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{first.text}</span>
        {notices.length > 1 && (
          <span className="shrink-0 text-[10px] text-[var(--muted)]" data-testid="scene-notice-more">
            +{notices.length - 1}
          </span>
        )}
        <button
          onClick={onOpenSettings}
          className="shrink-0 underline decoration-dotted"
          data-testid="scene-notice-details"
        >
          {t('scene.settings')}
        </button>
        <button
          onClick={() => onDismiss(first.key)}
          className="shrink-0 text-[10px] text-[var(--muted)] hover:text-[var(--text)]"
          data-testid="scene-notice-dismiss"
        >
          {t('scene.dismiss')}
        </button>
      </div>
    </div>
  )
}

function ScenePanelFrame({
  panel,
  panelRef,
  exiting,
  session,
  send,
  subscribe,
}: {
  panel: SceneOverlay
  panelRef: RefObject<HTMLDivElement | null>
  exiting: boolean
  session: ReturnType<typeof useSceneSession>
  send: SendFn
  subscribe: SubscribeFn
}) {
  const { t } = useI18n()
  const kind = panel.kind
  return (
    <div
      ref={panelRef}
      inert={exiting}
      aria-hidden={exiting}
      className={cn(
        'scene-crt-panel absolute z-20 flex flex-col overflow-hidden',
        kind === 'transcript' ? 'scene-transcript-panel' : 'scene-settings-panel',
      )}
      data-testid="scene-panel"
      role="region"
      aria-label={kind === 'transcript' ? t('scene.transcript') : t('scene.settings')}
      data-placement={panel.placement}
      style={overlayStyle(panel.region)}
    >
      <div className={kind === 'transcript' ? 'scene-transcript-header' : 'scene-settings-header'}>
        <span className="scene-crt-title">
          {kind === 'transcript' ? t('scene.transcript') : t('scene.settings')}
        </span>
        {kind === 'transcript' && (
          <select
            value={session.sessionId}
            onChange={event => { void session.loadSession(event.target.value) }}
            aria-label={t('scene.current_task')}
            data-testid="scene-session-select"
            className="scene-transcript-session"
          >
            <option value={session.sessionId}>
              {session.activeSession?.title || session.sessionId || t('scene.current_task')}
            </option>
            {session.sessions
              .filter(item => item.id !== session.sessionId)
              .map(item => (
                <option key={item.id} value={item.id}>{item.title || item.id}</option>
              ))}
          </select>
        )}
        {kind === 'transcript' && (
          <button
            onClick={() => { void session.createSession() }}
            data-testid="scene-new-task"
            title={t('scene.new_task')}
            aria-label={t('scene.new_task')}
            className="scene-crt-action scene-transcript-new"
          >
            <Plus aria-hidden="true" />
          </button>
        )}
        {kind !== 'transcript' ? <div className="flex-1" /> : null}
      </div>

      <div
        className={cn('flex flex-1 min-h-0 flex-col overflow-y-auto select-text focus-visible:outline-2 focus-visible:outline-[var(--accent)]', kind === 'transcript' ? 'scene-transcript-scroll' : 'scene-settings-body')}
        tabIndex={0}
        aria-label={kind === 'transcript' ? t('scene.transcript') : t('scene.settings')}
      >
        {kind === 'transcript' && (
            <SceneTranscript
              messages={session.messages}
              streaming={session.streaming}
            />
        )}
        {kind === 'more' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="scene-aux">
            <SettingsPage send={send} subscribe={subscribe} />
          </div>
        )}
      </div>

    </div>
  )
}

function SceneToolbarButton({
  active,
  icon,
  label,
  testId,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  testId: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      title={label}
      data-active={active ? 'true' : 'false'}
      className="scene-toolbar-button"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function ScenePlaceholder({
  status,
  error,
  connected,
  onRetry,
  onImport,
  importing,
}: {
  status: string
  error: string
  connected: boolean
  onRetry: () => void
  onImport: () => void
  importing: boolean
}) {
  const { t } = useI18n()
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      {status === 'error' ? (
        <>
          <span className="text-[12px] text-rose-300">{t('scene.failed_title')}</span>
          <span className="max-w-[420px] text-[11px] text-[var(--muted)] break-words">{error}</span>
          <button
            onClick={onRetry}
            disabled={importing || !connected}
            className="mt-1 flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            <RotateCw className="w-3.5 h-3.5" />
            {t('scene.retry')}
          </button>
          <button
            onClick={onImport}
            disabled={importing || !connected}
            data-testid="scene-import-emote"
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text)] disabled:opacity-40"
          >
            {t(importing ? 'scene.importing_assets' : 'scene.import_assets')}
          </button>
        </>
      ) : (
        <>
          <Loader2 className="w-5 h-5 animate-spin text-[var(--muted)]" />
          <span className="text-[12px] text-[var(--muted)]">
            {connected ? t('scene.starting') : t('scene.waiting_backend')}
          </span>
        </>
      )}
    </div>
  )
}


function SceneTranscript({
  messages,
  streaming,
}: {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string; turnId?: string; streaming?: boolean; delivery?: string; id?: string }>
  streaming: boolean
}) {
  const { t } = useI18n()
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scroller = endRef.current?.closest<HTMLElement>('.scene-transcript-scroll')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [messages, streaming])

  if (messages.length === 0) {
    return (
      <div className="scene-transcript-empty" data-testid="scene-transcript">
        {t('scene.empty_transcript')}
      </div>
    )
  }
  return (
    <div className="scene-transcript-messages" data-testid="scene-transcript">
      {messages.map((message, index) => (
        <div
          key={`${message.turnId || 'msg'}-${index}`}
          data-message-id={message.id}
          data-turn-id={message.turnId}
          data-delivery={message.delivery}
          data-role={message.role}
          data-streaming={message.streaming ? 'true' : 'false'}
          className="scene-transcript-message"
        >
          <div className="scene-transcript-speaker">
            {message.role === 'user'
              ? t('scene.role_user')
              : message.role === 'system' ? t('scene.role_system') : t('scene.role_assistant')}
            {message.streaming ? ` · ${t('scene.streaming')}` : ''}
          </div>
          <div className="scene-transcript-text">{message.text}</div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
