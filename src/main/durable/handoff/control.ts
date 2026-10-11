import type { Context } from '@earendil-works/chord'
import type { Conversation, ConversationId, Harness, Tx, WatchHandle } from '@earendil-works/pi-durable'
import { ApprovalsDoc, HandoffsDoc, OutboxDoc, isActive, type Approval, type ApprovalDetail, type Approvals, type HandoffItem, type HandoffStatus } from './docs.ts'
import { outboxIdOf, roundOf } from './rounds.ts'
import { expireApprovals } from './settle.ts'

// 本文件是主进程命令（task.cancel / task.approve / session.load 等）的 worker 侧入口，错误一律用 Error('not_found') 表达，
// 由调用方映射成应答码（architecture §7.2）。

export type CancelOutcome =
  | { type: 'requested' | 'cancelling' | 'ended' | 'cancelled' }
  | { type: 'missing'; active: string[] }

/**
 * 只置标记、不等子对话停下：Reporter 监视这个标记并中止子对话（pi-tool-constraints §3.1）。
 * handoff_cancel 工具与 task.cancel 命令共用，两条路径的语义因此不会漂移。
 */
export async function requestCancel(tx: Tx, rootId: ConversationId, taskId: string, now = Date.now()): Promise<CancelOutcome> {
  const handoffs = await tx.doc(HandoffsDoc, rootId)
  const item = handoffs.items.find(each => each.taskId === taskId)
  if (!item) return { type: 'missing', active: handoffs.items.filter(each => isActive(each.status)).map(each => `${each.taskId} "${each.title}"`) }
  if (item.status === 'needs_input') {
    // 子代理已经停下、没有 Reporter 可以收尾，直接置 cancelled。还没投递的"需要回答"汇报一并撤回：取消的承诺是之后不会再有这个任务的汇报。
    item.status = 'cancelled'
    item.endedAt = now
    delete item.question
    const outbox = await tx.doc(OutboxDoc, rootId)
    const index = outbox.pending.findIndex(each => each.id === outboxIdOf(taskId, roundOf(item)) && each.status === 'needs_input')
    if (index >= 0) outbox.pending.splice(index, 1)
    return { type: 'cancelled' }
  }
  if (!isActive(item.status)) return { type: 'ended' }
  if (item.cancelRequested) return { type: 'cancelling' }
  item.cancelRequested = true
  return { type: 'requested' }
}

export async function cancelHandoff(harness: Harness, root: Pick<Conversation, 'id'>, taskId: string, context: Context): Promise<{ status: 'cancelling' | 'terminal' }> {
  const outcome = await harness.commit(tx => requestCancel(tx, root.id, taskId), context)
  if (outcome.type === 'missing') throw new Error('not_found')
  return { status: outcome.type === 'ended' || outcome.type === 'cancelled' ? 'terminal' : 'cancelling' }
}

/**
 * 界面上的点击。写入前核对该项存在、仍是 pending 且未过期；重复点击、过期点击都按 not_found 应答。
 * 必须带 taskId：单凭 approvalId 找不到子对话（pi-tool-constraints §4.3）。
 */
export async function approveHandoff(harness: Harness, root: Pick<Conversation, 'id'>, taskId: string, approvalId: string, allow: boolean, context: Context): Promise<void> {
  const decided = await harness.commit(async tx => {
    const handoffs = await tx.doc(HandoffsDoc, root.id)
    const item = handoffs.items.find(each => each.taskId === taskId)
    if (!item) return false
    const approval = (await tx.doc(ApprovalsDoc, item.child as ConversationId)).items[approvalId]
    // 过期时间到了但进程内计时器还没来得及写 expired：同样不接受，免得批准一个主人已经看不到倒计时的请求。
    if (!approval || approval.state !== 'pending' || approval.expiresAt <= Date.now()) return false
    approval.state = allow ? 'allow' : 'deny'
    approval.by = 'user'
    approval.decidedAt = Date.now()
    return true
  }, context)
  if (!decided) throw new Error('not_found')
}

/** 事件 task.graph 与 session.load 的 tasks 里每个任务的形状；progress、question 只在有值时出现。 */
export type TaskSummary = {
  taskId: string
  kind: string
  title: string
  status: string
  round: number
  progress?: { text: string; at: number }
  question?: string
}

export function summaryOf(item: Pick<HandoffItem, 'taskId' | 'kind' | 'title' | 'status' | 'round' | 'progress' | 'question'>): TaskSummary {
  return {
    taskId: item.taskId,
    kind: item.kind,
    title: item.title,
    status: item.status,
    round: roundOf(item),
    ...(item.progress ? { progress: { text: item.progress.text, at: item.progress.at } } : {}),
    ...(item.question ? { question: item.question } : {}),
  }
}

export async function listHandoffs(harness: Harness, rootId: ConversationId, context: Context): Promise<TaskSummary[]> {
  const handoffs = await harness.snapshot(HandoffsDoc, rootId, context)
  return (handoffs?.items ?? []).map(summaryOf)
}

/**
 * 打开会话时、resume() 之前：未终态委托的子对话里所有 pending 作废（by: restart）。
 * 此刻没有任何工具任务在运行，所以不会误伤正在等待的确认；被打断的工具随后返回 interrupted，子代理自行决定是否重新请求。
 */
export async function expireApprovalsOnOpen(harness: Harness, root: Pick<Conversation, 'id'>, context: Context): Promise<void> {
  const now = Date.now()
  await harness.commit(async tx => {
    const handoffs = await tx.doc(HandoffsDoc, root.id)
    const children = handoffs.items.filter(item => isActive(item.status)).map(item => item.child as ConversationId)
    for (const child of children) await expireApprovals(tx, child, 'restart', now)
  }, context)
}

export type ApprovalRequested = { taskId: string; approvalId: string; summary: string; detail: ApprovalDetail; expiresAt: number }
export type ApprovalResolved = { taskId: string; approvalId: string; state: string }

type Watched = {
  taskId: string
  watch: WatchHandle<Readonly<Approvals> | null>
  /** approvalId → 已通知过的状态；只有见过 pending 的项才会发 resolved。 */
  known: Map<string, Approval['state']>
}

const isTerminal = (status: HandoffStatus): boolean => !isActive(status)

// 逐字段挑：文档里可能留有旧版本写入的其它字段（bytes、edits 等），不原样透给界面。
function detailOf(approval: Approval): ApprovalDetail {
  const detail: ApprovalDetail = { tool: approval.tool }
  for (const key of ['command', 'cwd', 'path', 'preview'] as const) {
    const value = approval.detail?.[key]
    if (typeof value === 'string') detail[key] = value
  }
  return detail
}

/**
 * 事件桥用：为每个未终态委托的子对话监视 app.approvals，新增 pending 发 request，离开 pending 发 resolved。
 * 会话打开时对 queued / running 的条目挂上，运行中出现的新条目也挂上，条目终态后卸载（pi-tool-constraints §4.3）。
 * 返回的函数卸载全部监视，可重复调用。
 *
 * 回调抛错会让 durable 以 listener_error 终止该监视，所以这里一律吞掉：界面通知失败不该让确认通道失明。
 */
export async function watchApprovals(
  harness: Harness,
  root: Pick<Conversation, 'id'>,
  context: Context,
  on: { request(approval: ApprovalRequested): void; resolved(approval: ApprovalResolved): void },
): Promise<() => Promise<void>> {
  const children = new Map<number, Watched>()
  let stopped = false
  const safely = (notify: () => void) => {
    try {
      notify()
    } catch {
      // 见函数注释。
    }
  }

  // 同步完成比较与登记（中间没有 await），所以监视回调与 flush 交错也不会重复通知。
  const apply = (entry: Watched, approvals: Readonly<Approvals> | null | undefined) => {
    for (const [approvalId, approval] of Object.entries(approvals?.items ?? {})) {
      const seen = entry.known.get(approvalId)
      if (approval.state === 'pending') {
        if (seen !== undefined) continue
        entry.known.set(approvalId, 'pending')
        safely(() => on.request({ taskId: entry.taskId, approvalId, summary: approval.summary, detail: detailOf(approval), expiresAt: approval.expiresAt }))
      } else if (seen === 'pending') {
        entry.known.set(approvalId, approval.state)
        safely(() => on.resolved({ taskId: entry.taskId, approvalId, state: approval.state }))
      }
    }
  }

  async function attach(taskId: string, child: number): Promise<void> {
    const watch = await harness.watchDoc(ApprovalsDoc, child as ConversationId, context)
    if (!watch) return
    if (stopped) {
      await watch.stop()
      return
    }
    const entry: Watched = { taskId, watch, known: new Map() }
    children.set(child, entry)
    // 打开监视之前已经出现的 pending 也要通知；watchDoc 的 value 只给获取时的现值，不回放历史变化。
    apply(entry, watch.value)
    watch.start(async value => apply(entry, value))
  }

  async function detach(child: number, entry: Watched): Promise<void> {
    children.delete(child)
    // 终态提交与 pending 作废在同一个 commit 里，但监视的最后一帧可能还没送到：卸载前读一次提交后的现值补发 resolved。
    apply(entry, await harness.snapshot(ApprovalsDoc, child as ConversationId, context))
    await entry.watch.stop()
  }

  async function reconcile(items: readonly { taskId: string; child: number; status: HandoffStatus }[]): Promise<void> {
    for (const item of items) {
      const entry = children.get(item.child)
      if (!isTerminal(item.status)) {
        if (!entry) await attach(item.taskId, item.child)
      } else if (entry) await detach(item.child, entry)
    }
  }

  const handoffs = await harness.watchDoc(HandoffsDoc, root.id, context)
  if (!handoffs) return async () => {}
  await reconcile(handoffs.value?.items ?? [])
  handoffs.start(async value => reconcile(value?.items ?? []))

  return async () => {
    stopped = true
    await handoffs.stop()
    const open = [...children.values()]
    children.clear()
    await Promise.all(open.map(entry => entry.watch.stop()))
  }
}
