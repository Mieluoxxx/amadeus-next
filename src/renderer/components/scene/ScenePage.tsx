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
  Activity,
  AlertTriangle,
  ArrowRight,
  Loader2,
  MessageSquare,
  Plus,
  RotateCw,
  ShieldAlert,
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
import { useSceneSession, type SceneMessage } from './useSceneSession'
import type { SceneTask, TaskApproval } from './taskTypes'
import SceneDock from './SceneDock'
import SessionPicker from './SessionPicker'
import { TaskCard, TaskTray } from './TaskCard'
import WorkPanel from './WorkPanel'
import { useWorkPanel } from './useWorkPanel'

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
  const work = useWorkPanel({ send, subscribe, connected, active: panel === 'work' })
  const workAsking = work.tasks.some(task => task.status === 'needs_input')
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

  // 错误已读状态按会话隔离，切换会话时重置，避免旧任务的隐藏状态阻断新任务暴露异常。
  useEffect(() => setAcknowledgedNotices([]), [session.sessionId])

  // 仅响应经由状态钩子收敛后的会话变更，防止底层广播乱序导致已关闭的面板被误开。
  useEffect(() => {
    const change = session.sessionChange
    if (!change) return
    if (change.source === 'slice') setPanel('transcript')
  }, [session.sessionChange])

  // 快捷键聚焦场景上下文，新建会话并同步展开记录面板，保持交互连贯。
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
  // 统一发送通道并等待后端确认后再清空输入，防止发送失败丢失草稿与附件。
  const submit = useCallback(async () => {
    const attachment = pendingAttachment
    const sent = await session.sendText(session.draft, attachment)
    if (sent) {
      // 仅清空已成功提交的附件实例，避免误删发送并发期间新选取的图片。
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
      replying={session.replying}
      stopping={session.stopping}
      onStop={() => { void session.abortReply() }}
      sessionTitle={session.activeSession?.title || ''}
      model={session.model}
      models={session.models}
      onSelectModel={value => void session.selectModel(value)}
      attachment={pendingAttachment}
      onClearAttachment={() => setPendingAttachment(null)}
      onPickAttachment={file => {
        if (!supportsDirectImage(session.provider)) {
          session.reportProblem(t('scene.attach_needs_visual_provider'))
          return
        }
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
          // 容器垫底相同壁纸，在窗口形变或帧缩放未填满时保持视觉连续性。
          background: bridge.assetOrigin
            ? `#05070b url(${bridge.assetOrigin}/scene/room/background.png) center/cover no-repeat`
            : '#05070b',
        }}
      >
        {bridge.url ? (
          <iframe
            // 使用加载代数作为 key 强制重建 iframe DOM，防止热重启时残留已损坏的 WebGL 状态。
            key={bridge.loadId}
            ref={bridge.frameRef}
            title="Amadeus scene"
            data-testid="scene-frame"
            src={bridge.url}
            onError={bridge.reportFrameError}
            style={{ ...frameStyle, position: 'absolute', border: 'none', opacity: bridge.status === 'ready' ? 1 : 0 }}
            // 限制子页面仅专注视效渲染，防止内嵌帧越权访问系统音频设备。
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

      {/* 拖拽区域置于 iframe 之上、可交互控件之下，保证窗口可拖动且不阻断按钮点击。 */}
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
          attention={session.pendingApprovalCount > 0 && panel !== 'transcript'}
          onClick={() => togglePanel('transcript')}
        />
        <SceneToolbarButton
          active={panel === 'work'}
          icon={<Activity className="w-3.5 h-3.5" />}
          label={t('scene.work')}
          testId="scene-open-work"
          attention={workAsking && panel !== 'work'}
          onClick={() => togglePanel('work')}
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
        {/* 确认请求不抢焦点也不打断语音，但面板收起时得有个看得见的入口，否则 10 分钟后就静悄悄过期了。 */}
        {session.pendingApprovalCount > 0 && panel !== 'transcript' ? (
          <button
            onClick={() => setPanel('transcript')}
            data-testid="scene-approval-chip"
            className="flex shrink-0 items-center gap-1.5 self-start rounded-xl border border-amber-500/30 bg-[#1c1a12]/95 px-3 py-1.5 text-[11px] text-amber-200 backdrop-blur-xl"
          >
            <ShieldAlert className="w-3 h-3" />
            <span>{t('task.approval.waiting', undefined, { count: session.pendingApprovalCount })}</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        ) : null}
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
          work={work}
          onJump={id => { setPanel('transcript'); void session.loadSession(id) }}
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
    // 已忽略但未解决的异常收折为汇总按钮，保持界面清爽同时保留可发现性。
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
    // 限制通知浮层最大高度在工具栏保留区内，避免横幅向下遮挡立绘主体。
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
  work,
  onJump,
  send,
  subscribe,
}: {
  panel: SceneOverlay
  panelRef: RefObject<HTMLDivElement | null>
  exiting: boolean
  session: ReturnType<typeof useSceneSession>
  work: ReturnType<typeof useWorkPanel>
  onJump: (sessionId: string) => void
  send: SendFn
  subscribe: SubscribeFn
}) {
  const { t } = useI18n()
  const kind = panel.kind
  const title = t(kind === 'transcript' ? 'scene.transcript' : kind === 'work' ? 'scene.work' : 'scene.settings')
  const bodyClass = kind === 'transcript' ? 'scene-transcript-scroll' : kind === 'work' ? 'scene-work-body' : 'scene-settings-body'
  return (
    <div
      ref={panelRef}
      inert={exiting}
      aria-hidden={exiting}
      className={cn(
        'scene-crt-panel absolute z-20 flex flex-col overflow-hidden',
        kind === 'transcript' ? 'scene-transcript-panel' : kind === 'work' ? 'scene-work-panel' : 'scene-settings-panel',
      )}
      data-testid="scene-panel"
      role="region"
      aria-label={title}
      data-placement={panel.placement}
      style={overlayStyle(panel.region)}
    >
      <div className={kind === 'transcript' ? 'scene-transcript-header' : 'scene-settings-header'}>
        <span className="scene-crt-title">{title}</span>
        {kind === 'transcript' && (
          <SessionPicker
            sessions={session.sessions}
            currentId={session.sessionId}
            onSelect={id => { void session.loadSession(id) }}
            onOpen={() => { void session.refreshSessions() }}
            onRename={session.renameSession}
            onDelete={session.deleteSession}
          />
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
        className={cn('flex flex-1 min-h-0 flex-col overflow-y-auto select-text focus-visible:outline-2 focus-visible:outline-[var(--accent)]', bodyClass)}
        tabIndex={0}
        aria-label={title}
      >
        {kind === 'transcript' && (
            <SceneTranscript
              messages={session.messages}
              streaming={session.streaming}
              tasks={session.tasks}
              approvals={session.approvals}
              now={session.approvalsNow}
              cancelling={session.cancellingTasks}
              deciding={session.decidingApprovals}
              onCancel={taskId => { void session.cancelTask(taskId) }}
              onDecide={(approval, allow) => { void session.decideApproval(approval, allow) }}
            />
        )}
        {kind === 'work' && <WorkPanel work={work} sessions={session.sessions} onJump={onJump} />}
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
  attention = false,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  testId: string
  attention?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      title={label}
      data-active={active ? 'true' : 'false'}
      data-attention={attention ? 'true' : undefined}
      className="scene-toolbar-button"
    >
      {icon}
      <span>{label}</span>
      {attention ? <i className="scene-toolbar-dot" aria-hidden="true" /> : null}
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
  tasks,
  approvals,
  now,
  cancelling,
  deciding,
  onCancel,
  onDecide,
}: {
  messages: SceneMessage[]
  streaming: boolean
  tasks: SceneTask[]
  approvals: TaskApproval[]
  now: number
  cancelling: ReadonlySet<string>
  deciding: ReadonlySet<string>
  onCancel: (taskId: string) => void
  onDecide: (approval: TaskApproval, allow: boolean) => void
}) {
  const { t } = useI18n()
  const endRef = useRef<HTMLDivElement>(null)
  // 已经以卡片形式出现在记录里的任务不再进托盘，免得同一个任务出现两次。
  const inlineTaskIds = useMemo(
    () => new Set(messages.flatMap(message => message.card?.taskId ? [message.card.taskId] : [])),
    [messages],
  )
  const trayTasks = useMemo(() => tasks.filter(task => !inlineTaskIds.has(task.taskId)), [tasks, inlineTaskIds])
  const waiting = approvals.filter(approval => approval.state === 'pending').length
  useEffect(() => {
    const scroller = endRef.current?.closest<HTMLElement>('.scene-transcript-scroll')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    // 托盘增减或新的确认到达时也要滚到底，否则等待确认的卡片会落在视野外。
  }, [messages, streaming, trayTasks.length, waiting])

  if (messages.length === 0 && trayTasks.length === 0) {
    return (
      <div className="scene-transcript-empty" data-testid="scene-transcript">
        {t('scene.empty_transcript')}
      </div>
    )
  }
  return (
    <div className="scene-transcript-messages" data-testid="scene-transcript">
      {messages.map((message, index) => {
        if (message.role === 'card' && message.card) {
          const live = tasks.find(task => task.taskId === message.card?.taskId)
          return (
            <TaskCard
              key={`${message.id}-${index}`}
              task={{
                taskId: message.card.taskId,
                kind: live?.kind || 'research',
                title: live?.title || message.card.title,
                status: live?.status || message.card.status || 'done',
                round: live?.round ?? message.card.round,
                progress: live?.progress,
                question: live?.question ?? message.card.question,
                ...(live?.target ? { target: live.target } : {}),
              }}
              summary={message.card.summary}
              live={Boolean(live)}
              approvals={approvals}
              now={now}
              cancelling={cancelling.has(message.card.taskId)}
              deciding={deciding}
              onCancel={onCancel}
              onDecide={onDecide}
            />
          )
        }
        return (
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
        )
      })}
      <TaskTray
        tasks={trayTasks}
        approvals={approvals}
        now={now}
        cancelling={cancelling}
        deciding={deciding}
        onCancel={onCancel}
        onDecide={onDecide}
      />
      <div ref={endRef} />
    </div>
  )
}
