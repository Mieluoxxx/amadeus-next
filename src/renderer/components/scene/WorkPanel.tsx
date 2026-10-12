/**
 * 工作面板：所有会话里委派出去的子代理，以及它们每一步在做什么。
 * 列表像 Claude Code 的子代理行（N 次工具调用 · 用时 · 最近几步），点进去是完整的执行过程，运行中实时追加。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, RotateCw, TriangleAlert } from 'lucide-react'
import { useI18n, type MessageKey } from '../../i18n'
import { StatusIcon } from './TaskCard'
import { isOpenStatus } from './taskTypes'
import type { SceneSession } from './useSceneSession'
import type { useWorkPanel } from './useWorkPanel'
import {
  elapsedOf,
  formatElapsed,
  formatTokens,
  sortWork,
  workKey,
  type WorkAction,
  type WorkTask,
} from './workTypes'

type Work = ReturnType<typeof useWorkPanel>
type ToolAction = Extract<WorkAction, { type: 'tool' }>

const FINISHED_SHOWN = 20
// 跟随到底部的判定余量：用户往上翻超过这个距离就不再自动滚动。
const FOLLOW_SLACK_PX = 48

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

function ToolStatus({ status }: { status: ToolAction['status'] }) {
  if (status === 'running') return <Loader2 className="animate-spin" aria-hidden="true" />
  if (status === 'ok') return <Check aria-hidden="true" />
  return <TriangleAlert aria-hidden="true" />
}

function ActionLine({ action }: { action: WorkAction }) {
  const { t } = useI18n()
  if (action.type === 'tool') {
    return (
      <li className="work-step" data-type="tool" data-status={action.status}>
        <ToolStatus status={action.status} />
        <span className="work-step-tool">{action.tool}</span>
        <span className="work-step-label" title={action.label}>{action.label}</span>
      </li>
    )
  }
  return (
    <li className="work-step" data-type={action.type}>
      <span className="work-step-tool">{action.type === 'progress' ? t('work.progress') : '›'}</span>
      <span className="work-step-label" title={action.text}>{action.text}</span>
    </li>
  )
}

function useMeta(task: WorkTask, now: number, sessionTitle: string): string[] {
  const { t } = useI18n()
  const elapsed = elapsedOf(task, now)
  return [
    t(`task.kind.${task.kind}` as MessageKey, task.kind) + (task.target ? ` @${task.target}` : ''),
    ...(sessionTitle ? [sessionTitle] : []),
    ...(task.round > 1 ? [t('task.round', undefined, { count: task.round })] : []),
    ...(task.toolUses ? [t('work.tool_uses', undefined, { count: task.toolUses })] : []),
    ...(elapsed !== undefined ? [task.status === 'queued' ? t('work.waiting', undefined, { time: formatElapsed(elapsed) }) : formatElapsed(elapsed)] : []),
    ...(task.tokens ? [t('work.tokens', undefined, { count: formatTokens(task.tokens) })] : []),
  ]
}

function WorkRow({ task, now, sessionTitle, onOpen }: { task: WorkTask; now: number; sessionTitle: string; onOpen: () => void }) {
  const { t } = useI18n()
  const meta = useMeta(task, now, sessionTitle)
  const working = task.status === 'queued' || task.status === 'running'
  return (
    <li>
      <button type="button" className="work-row" data-testid="work-row" data-task-id={task.taskId} data-session-id={task.sessionId} data-status={task.status} onClick={onOpen}>
        <span className="work-row-head">
          <span className="work-row-status"><StatusIcon status={task.status} /></span>
          <span className="work-row-title" title={task.title}>{task.title || task.taskId}</span>
          <span className="work-row-state">{t(`task.status.${task.status}` as MessageKey, task.status)}</span>
          <ChevronRight className="work-row-chevron" aria-hidden="true" />
        </span>
        <span className="work-row-meta">{meta.join(' · ')}</span>
        {working && task.recent.length ? (
          <ul className="work-steps" data-testid="work-recent">{task.recent.map(action => <ActionLine key={action.id} action={action} />)}</ul>
        ) : null}
        {working && !task.recent.length && task.progress ? <span className="work-row-note">{task.progress.text}</span> : null}
        {task.status === 'needs_input' && task.question ? <span className="work-row-note" data-tone="ask">{task.question}</span> : null}
        {task.reason ? <span className="work-row-note" data-tone="error">{task.reason}</span> : null}
      </button>
    </li>
  )
}

function TimelineStep({ action }: { action: WorkAction }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (action.type === 'tool') {
    const expandable = Boolean(action.output)
    return (
      <li className="work-event" data-type="tool" data-status={action.status} data-testid="work-event">
        <button type="button" className="work-event-tool" disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={() => setOpen(value => !value)}>
          <ToolStatus status={action.status} />
          <span className="work-step-tool">{action.tool}</span>
          <span className="work-step-label" title={action.label}>{action.label}</span>
          {action.durationMs !== undefined ? <span className="work-event-time">{formatElapsed(action.durationMs)}</span> : null}
          {expandable ? <ChevronDown className="work-event-chevron" data-open={open || undefined} aria-hidden="true" /> : null}
        </button>
        {open && action.output ? <pre className="work-event-output" tabIndex={0}>{action.output}</pre> : null}
      </li>
    )
  }
  const label = action.type === 'brief' ? t('work.brief') : action.type === 'progress' ? t('work.progress') : ''
  return (
    <li className="work-event" data-type={action.type} data-testid="work-event">
      {label ? <span className="work-event-label">{label}</span> : null}
      <p className="work-event-text">{action.text}</p>
    </li>
  )
}

function WorkDetail({ task, work, now, sessionTitle, onJump }: { task: WorkTask; work: Work; now: number; sessionTitle: string; onJump: () => void }) {
  const { t } = useI18n()
  const meta = useMeta(task, now, sessionTitle)
  const trace = work.trace?.key === workKey(task) ? work.trace : null
  const listRef = useRef<HTMLOListElement>(null)
  const follow = useRef(true)
  const count = trace?.actions.length ?? 0

  // 用户往上翻看时不跟随；在底部附近时新步骤到达就滚到底。
  useLayoutEffect(() => {
    const scroller = listRef.current?.closest('.scene-work-body')
    if (scroller && follow.current) scroller.scrollTop = scroller.scrollHeight
  }, [count])
  useEffect(() => {
    const scroller = listRef.current?.closest('.scene-work-body')
    if (!scroller) return
    const onScroll = () => { follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK_PX }
    scroller.addEventListener('scroll', onScroll)
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])

  const cancelling = work.cancelling.has(workKey(task))
  return (
    <section className="work-detail" data-testid="work-detail" data-task-id={task.taskId}>
      <button type="button" className="crt-link work-back" onClick={work.closeTrace} data-testid="work-back">
        <ArrowLeft aria-hidden="true" />{t('work.back')}
      </button>
      <header className="work-detail-head" data-status={task.status}>
        <span className="work-row-status"><StatusIcon status={task.status} /></span>
        <h3 className="work-detail-title">{task.title || task.taskId}</h3>
        <span className="work-row-state">{t(`task.status.${task.status}` as MessageKey, task.status)}</span>
      </header>
      <p className="work-row-meta">{meta.join(' · ')}</p>
      {task.status === 'needs_input' && task.question ? <p className="work-row-note" data-tone="ask">{task.question}</p> : null}
      {task.reason ? <p className="work-row-note" data-tone="error">{t('work.reason')}：{task.reason}</p> : null}
      <div className="work-detail-actions">
        <button type="button" className="crt-button" onClick={onJump} data-testid="work-jump"><ExternalLink aria-hidden="true" />{t('work.jump')}</button>
        {isOpenStatus(task.status) ? (
          <button type="button" className="crt-button" data-variant="danger" disabled={cancelling} onClick={() => { void work.cancel(task) }} data-testid="work-cancel">
            {cancelling ? t('task.cancelling') : t('task.cancel')}
          </button>
        ) : null}
      </div>
      {!trace || trace.loading ? <p className="settings-card-note">{t('work.loading')}</p> : null}
      {trace?.error ? <p className="work-row-note" data-tone="error">{t('work.trace_failed', undefined, { error: trace.error })}</p> : null}
      {trace && !trace.loading && !trace.error && count === 0 ? <p className="settings-card-note">{t('work.trace_empty')}</p> : null}
      <ol className="work-timeline" ref={listRef} data-testid="work-timeline">
        {trace?.actions.map(action => <TimelineStep key={action.id} action={action} />)}
      </ol>
      {task.status === 'running' ? <p className="work-live" aria-live="polite"><Loader2 className="animate-spin" aria-hidden="true" />{t('work.not_live')}</p> : null}
    </section>
  )
}

export default function WorkPanel({ work, sessions, onJump }: {
  work: Work
  sessions: readonly SceneSession[]
  onJump: (sessionId: string) => void
}) {
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)
  const titles = new Map(sessions.map(session => [session.id, session.title]))
  // 会话列表已知时，删掉的会话下的任务不再显示（列表下一次重拉前它们还在缓存里）。
  const visible = sessions.length ? work.tasks.filter(task => titles.has(task.sessionId)) : work.tasks
  const { open, finished } = sortWork(visible)
  const selected = work.trace ? visible.find(task => workKey(task) === work.trace!.key) : undefined
  const now = useNow(visible.some(task => task.status === 'queued' || task.status === 'running'))
  const titleOf = (task: WorkTask) => titles.get(task.sessionId) || task.sessionTitle

  if (selected) return <WorkDetail task={selected} work={work} now={now} sessionTitle={titleOf(selected)} onJump={() => onJump(selected.sessionId)} />

  const shownFinished = showAll ? finished : finished.slice(0, FINISHED_SHOWN)
  const row = (task: WorkTask) => <WorkRow key={workKey(task)} task={task} now={now} sessionTitle={titleOf(task)} onOpen={() => { void work.openTrace(task) }} />
  return (
    <div className="work-list" data-testid="work-list">
      {/* 标题栏右侧被工具栏盖住，刷新放在列表顶部。 */}
      <button type="button" className="crt-link work-refresh" onClick={() => { void work.refresh() }} disabled={work.loading} data-testid="work-refresh">
        <RotateCw aria-hidden="true" className={work.loading ? 'animate-spin' : undefined} />{t('work.refresh')}
      </button>
      {work.error ? <p className="work-row-note" data-tone="error">{t('work.load_failed', undefined, { error: work.error })}</p> : null}
      {!work.loaded && !work.error ? <p className="settings-card-note">{t('work.loading')}</p> : null}
      {work.loaded && visible.length === 0 ? <p className="scene-transcript-empty" data-testid="work-empty">{t('work.empty')}</p> : null}
      {open.length ? (
        <section className="work-group" data-testid="work-group-open">
          <h3 className="work-group-title">{t('work.open', undefined, { count: open.length })}</h3>
          <ul className="work-rows">{open.map(row)}</ul>
        </section>
      ) : null}
      {finished.length ? (
        <section className="work-group" data-testid="work-group-finished">
          <h3 className="work-group-title">{t('work.finished', undefined, { count: finished.length })}</h3>
          <ul className="work-rows">{shownFinished.map(row)}</ul>
          {finished.length > shownFinished.length ? (
            <button type="button" className="crt-link" onClick={() => setShowAll(true)}>{t('work.show_more', undefined, { count: finished.length - shownFinished.length })}</button>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
