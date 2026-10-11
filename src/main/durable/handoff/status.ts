import type { HandoffItem, HandoffStatus } from './docs.ts'
import { roundOf } from './rounds.ts'

const LIST_MAX = 10

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const STATUS_TEXT: Record<HandoffStatus, string> = {
  queued: 'queued, waiting for a free slot',
  running: 'running',
  done: 'done',
  failed: 'failed',
  timeout: 'timed out',
  cancelled: 'cancelled',
  needs_input: "needs_input, waiting for the user's answer",
}

/** 失败原因已由 Reporter 清洗后写在 result.text 的 `Reason:` 行里；没有时退回原始 reason。 */
const reasonOf = (item: HandoffItem): string => /^Reason: (.*)$/m.exec(item.result?.text ?? '')?.[1] ?? item.failure?.reason ?? 'unknown'

function describe(item: HandoffItem, now: number): string {
  const lines = [`${item.taskId} "${item.title}" (${item.kind})`, `Status: ${STATUS_TEXT[item.status]}`, `Round: ${roundOf(item)}`]
  if (item.status === 'queued') lines.push(`Waiting: ${formatDuration(now - item.createdAt)}`)
  else if (item.startedAt !== undefined) lines.push(`Elapsed: ${formatDuration((item.endedAt ?? now) - item.startedAt)}`)
  if (item.status === 'running' && item.progress) lines.push(`Latest progress (${formatDuration(now - item.progress.at)} ago): ${item.progress.text}`)
  if (item.status === 'needs_input' && item.question) lines.push(`Question: ${item.question}`)
  if (item.status === 'failed' || item.status === 'timeout') lines.push(`Reason: ${reasonOf(item)}`)
  return lines.join('\n')
}

export const taskList = (items: readonly Pick<HandoffItem, 'taskId' | 'title'>[]): string =>
  items.length ? `Tasks: ${items.map(each => `${each.taskId} "${each.title}"`).join(', ')}.` : 'No tasks have been delegated in this conversation.'

export type StatusReport = { text: string; isError?: true }

/** handoff_status 的返回文本：纯函数，`now` 由调用方给。给了 taskId 只说那一个；否则列出最近的 LIST_MAX 个。 */
export function renderStatus(items: readonly HandoffItem[], taskId: string | undefined, now: number): StatusReport {
  if (taskId) {
    const item = items.find(each => each.taskId === taskId)
    return item ? { text: describe(item, now) } : { text: `There is no task ${taskId}. ${taskList(items)}`, isError: true }
  }
  if (items.length === 0) return { text: taskList(items) }
  const shown = items.slice(-LIST_MAX)
  const hidden = items.length - shown.length
  return {
    text: [
      `Delegated tasks (${items.length}):`,
      shown.map(each => describe(each, now)).join('\n\n'),
      ...(hidden > 0 ? [`${hidden} older task(s) not shown; pass task_id to look one up.`] : []),
    ].join('\n\n'),
  }
}
