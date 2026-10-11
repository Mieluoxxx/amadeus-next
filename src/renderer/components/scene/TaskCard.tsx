/**
 * 任务卡片、写操作确认与任务托盘。
 * 确认只能由这里的点击产生：红莉栖没有批准工具，语音里说"允许"也不会生效（工具约束 §4.3）。
 */

import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Clock, Loader2, MessageCircleQuestionMark, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { useI18n, type MessageKey } from '../../i18n'
import {
  ageOf,
  formatCountdown,
  isOpenStatus,
  type ApprovalDetail,
  type ApprovalTool,
  type SceneTask,
  type TaskApproval,
  type TaskProgress,
} from './taskTypes'

const SUMMARY_COLLAPSE_AT = 240
const RESOLVED_SHOWN = 3
const FINISHED_SHOWN = 2
// 进度行的相对时间不需要秒级精度；只在它显示期间走表，卡片结束后不再唤醒渲染。
const PROGRESS_TICK_MS = 5000

type Decide = (approval: TaskApproval, allow: boolean) => void

function StatusIcon({ status }: { status: string }) {
  if (status === 'running') return <Loader2 className="animate-spin" aria-hidden="true" />
  if (status === 'done') return <Check aria-hidden="true" />
  if (status === 'failed' || status === 'timeout') return <TriangleAlert aria-hidden="true" />
  if (status === 'cancelled') return <X aria-hidden="true" />
  if (status === 'needs_input') return <MessageCircleQuestionMark aria-hidden="true" />
  return <Clock aria-hidden="true" />
}

function ProgressLine({ progress }: { progress: TaskProgress }) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), PROGRESS_TICK_MS)
    return () => clearInterval(timer)
  }, [progress.at])
  const age = ageOf(now - progress.at)
  const label = age.unit === 'now' ? t('task.progress.now') : t(`task.progress.${age.unit}` as MessageKey, undefined, { count: age.count })
  return (
    <p className="task-card-progress" data-testid="task-card-progress">
      <span className="task-card-progress-text" title={progress.text}>{progress.text}</span>
      <span className="task-card-progress-age">{label}</span>
    </p>
  )
}

/** 子代理缺信息、停下来等主人回答。不抢焦点也不弹窗：红莉栖会在对话里问，这里只是让主人知道在等什么。 */
function QuestionBlock({ question }: { question: string }) {
  const { t } = useI18n()
  return (
    <div className="task-card-question" role="note" aria-label={t('task.question.label')} data-testid="task-card-question">
      <MessageCircleQuestionMark aria-hidden="true" />
      <div>
        {question ? <p className="task-card-question-text">{question}</p> : null}
        <p className="task-card-question-hint">{t('task.question.hint')}</p>
      </div>
    </div>
  )
}

const DETAIL_LABELS: Record<ApprovalTool, { path: MessageKey; preview: MessageKey }> = {
  bash: { path: 'task.detail.path', preview: 'task.detail.preview' },
  write: { path: 'task.detail.path.write', preview: 'task.detail.preview.write' },
  edit: { path: 'task.detail.path.edit', preview: 'task.detail.preview.edit' },
}

function DetailView({ detail }: { detail: ApprovalDetail }) {
  const { t } = useI18n()
  const labels = DETAIL_LABELS[detail.tool ?? 'bash']
  // command / preview 是用户批准所依据的原文，必须完整放进可滚动的等宽区域，不能截断。
  const rows: Array<[string, string, boolean]> = []
  if (detail.command) rows.push([t('task.detail.command'), detail.command, true])
  if (detail.cwd) rows.push([t('task.detail.cwd'), detail.cwd, false])
  if (detail.path) rows.push([t(labels.path), detail.path, false])
  if (detail.preview) rows.push([t(labels.preview), detail.preview, true])
  if (rows.length === 0) return null
  return (
    <dl className="task-approval-detail" data-testid="task-approval-detail">
      {rows.map(([label, value, block]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{block ? <pre tabIndex={0}>{value}</pre> : value}</dd>
        </div>
      ))}
    </dl>
  )
}

const hasDetail = (detail: ApprovalDetail) => Boolean(detail.command || detail.cwd || detail.path || detail.preview)

function ApprovalBlock({ approval, remaining, busy, onDecide }: {
  approval: TaskApproval
  /** `null` 表示 worker 没给过期时间，不显示倒计时。 */
  remaining: number | null
  busy: boolean
  onDecide: Decide
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const detailed = hasDetail(approval.detail)
  return (
    <div className="task-approval" data-state="pending" data-testid="task-approval" data-approval-id={approval.approvalId} role="group" aria-label={t('task.approval.heading')}>
      <div className="task-approval-head">
        <ShieldAlert aria-hidden="true" />
        <span className="task-approval-summary">{approval.summary}</span>
        {remaining !== null ? (
          <span className="task-approval-timer" data-testid="task-approval-timer">
            {t('task.approval.expires', undefined, { time: formatCountdown(remaining) })}
          </span>
        ) : null}
      </div>
      {detailed ? (
        <>
          {open ? null : <p className="task-approval-note" data-testid="task-approval-review">{t('task.approval.review')}</p>}
          <button type="button" className="crt-link" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            {open ? t('task.approval.hide') : t('task.approval.show')}
          </button>
        </>
      ) : <p className="task-approval-note" data-testid="task-approval-no-detail">{t('task.approval.no_detail')}</p>}
      {open ? <DetailView detail={approval.detail} /> : null}
      <div className="task-approval-actions">
        <button type="button" className="crt-button" data-variant="primary" data-testid="task-approval-allow" disabled={busy} onClick={() => onDecide(approval, true)}>
          {t('task.approval.allow')}
        </button>
        <button type="button" className="crt-button" data-testid="task-approval-deny" disabled={busy} onClick={() => onDecide(approval, false)}>
          {t('task.approval.deny')}
        </button>
      </div>
    </div>
  )
}

function ApprovalRecord({ approval, state }: { approval: TaskApproval; state: 'allow' | 'deny' | 'expired' }) {
  const { t } = useI18n()
  const label = t(`task.approval.${state === 'allow' ? 'allowed' : state === 'deny' ? 'denied' : 'expired'}` as MessageKey)
  return (
    <div className="task-approval-record" data-state={state} data-testid="task-approval-record">
      <span>{label}</span>
      <span className="task-approval-summary">{approval.summary}</span>
    </div>
  )
}

export type TaskCardTask = Pick<SceneTask, 'taskId' | 'kind' | 'title'> & {
  status: string
  round?: number
  progress?: TaskProgress
  question?: string
}

export function TaskCard({
  task,
  summary = '',
  live,
  approvals,
  now,
  cancelling,
  deciding,
  onCancel,
  onDecide,
}: {
  task: TaskCardTask
  summary?: string
  /** 任务仍在任务图里；历史汇报对应的任务可能已经不在，此时没有可操作的东西。 */
  live: boolean
  approvals: TaskApproval[]
  now: number
  cancelling: boolean
  deciding: ReadonlySet<string>
  onCancel: (taskId: string) => void
  onDecide: Decide
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const kindLabel = t(`task.kind.${task.kind}` as MessageKey, task.kind || t('task.card'))
  const statusLabel = t(`task.status.${task.status}` as MessageKey, task.status)
  const mine = approvals.filter(approval => approval.taskId === task.taskId)
  const expiresIn = (approval: TaskApproval) => (approval.expiresAt > 0 ? approval.expiresAt - now : null)
  const waiting = mine.filter(approval => approval.state === 'pending' && (expiresIn(approval) ?? 1) > 0)
  // 本地计时已过期但还没收到 resolved 事件的项，按"已过期"收起，别留着点不动的按钮。
  const records = mine
    .filter(approval => approval.state !== 'pending' || (expiresIn(approval) ?? 1) <= 0)
    .slice(-RESOLVED_SHOWN)
  const long = summary.length > SUMMARY_COLLAPSE_AT
  const round = task.round ?? 1
  const asking = task.status === 'needs_input'
  // 进度只对还在干活的任务有意义；结束或停下来等回答之后它就是过期信息。
  const working = task.status === 'queued' || task.status === 'running'

  return (
    <article className="task-card" data-testid="task-card" data-task-id={task.taskId} data-status={task.status}>
      <header className="task-card-head">
        <span className="task-card-kind">{kindLabel}</span>
        {round > 1 ? <span className="task-card-round" data-testid="task-card-round">{t('task.round', undefined, { count: round })}</span> : null}
        <span className="task-card-title" title={task.title}>{task.title || task.taskId}</span>
        <span className="task-card-status" data-testid="task-card-status">
          <StatusIcon status={task.status} />
          {statusLabel}
        </span>
      </header>
      {working && task.progress ? <ProgressLine progress={task.progress} /> : null}
      {asking ? <QuestionBlock question={task.question ?? ''} /> : null}
      {summary ? (
        <div className="task-card-summary" data-clamped={long && !expanded ? 'true' : 'false'}>{summary}</div>
      ) : null}
      {long ? (
        <button type="button" className="crt-link" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          {expanded ? t('task.collapse') : t('task.expand')}
        </button>
      ) : null}
      {waiting.map(approval => (
        <ApprovalBlock
          key={approval.approvalId}
          approval={approval}
          remaining={expiresIn(approval)}
          busy={deciding.has(approval.approvalId)}
          onDecide={onDecide}
        />
      ))}
      {records.map(approval => (
        <ApprovalRecord
          key={approval.approvalId}
          approval={approval}
          state={approval.state === 'pending' ? 'expired' : approval.state}
        />
      ))}
      {live && isOpenStatus(task.status) ? (
        <footer className="task-card-foot">
          <button type="button" className="crt-button" data-testid="task-cancel" disabled={cancelling} onClick={() => onCancel(task.taskId)}>
            {cancelling ? t('task.cancelling') : t('task.cancel')}
          </button>
        </footer>
      ) : null}
    </article>
  )
}

/** 还没有以卡片形式出现在记录里的任务：排队 / 进行中，以及已结束但汇报尚未播出的。 */
export function TaskTray({
  tasks,
  approvals,
  now,
  cancelling,
  deciding,
  onCancel,
  onDecide,
}: {
  tasks: SceneTask[]
  approvals: TaskApproval[]
  now: number
  cancelling: ReadonlySet<string>
  deciding: ReadonlySet<string>
  onCancel: (taskId: string) => void
  onDecide: Decide
}) {
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)
  if (tasks.length === 0) return null
  const active = tasks.filter(task => isOpenStatus(task.status))
  const finished = tasks.filter(task => !isOpenStatus(task.status))
  const shownFinished = showAll ? finished : finished.slice(-FINISHED_SHOWN)
  const hidden = finished.length - shownFinished.length
  const visible = [...active, ...shownFinished]
  return (
    <section className="task-tray" data-testid="task-tray" aria-label={t('task.title')}>
      <div className="task-tray-title">{t('task.title')}</div>
      {visible.map(task => (
        <TaskCard
          key={task.taskId}
          task={task}
          live
          approvals={approvals}
          now={now}
          cancelling={cancelling.has(task.taskId)}
          deciding={deciding}
          onCancel={onCancel}
          onDecide={onDecide}
        />
      ))}
      {hidden > 0 || showAll ? (
        <button type="button" className="crt-link" onClick={() => setShowAll(value => !value)}>
          {showAll ? t('task.hide_finished') : t('task.show_finished', undefined, { count: hidden })}
        </button>
      ) : null}
    </section>
  )
}
