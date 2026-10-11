import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { ApprovalsDoc, HandoffsDoc, OutboxDoc, isActive, type Approval, type HandoffStatus } from './docs.ts'
import { outboxIdOf, roundOf } from './rounds.ts'

export type Finish =
  | { status: 'cancelled' }
  | { status: 'done'; text: string; full?: string; flagged?: true }
  | { status: 'failed' | 'timeout'; reason: string; detail?: string; text: string; full?: string; flagged?: true }
  | { status: 'needs_input'; question: string; text: string; flagged?: true }

/** 委托模型回退时 handoff 在 failure 里留的备注（任务仍在进行）；任务失败时它要和失败原因并存。 */
export const MODEL_FALLBACK = 'model_fallback'

/** 子对话里仍为 pending 的确认作废；调用方保证此刻没有等待确认的工具任务在跑。 */
export async function expireApprovals(tx: Tx, child: ConversationId, by: NonNullable<Approval['by']>, now: number): Promise<number> {
  const approvals = await tx.doc(ApprovalsDoc, child)
  let expired = 0
  for (const approval of Object.values(approvals.items)) {
    if (approval.state !== 'pending') continue
    approval.state = 'expired'
    approval.by = by
    approval.decidedAt = now
    expired++
  }
  return expired
}

/**
 * 在调用方的 commit 里把一个任务置为终态：写 app.handoffs，除取消外追加 app.outbox.pending，并作废子对话的待确认项。
 * 只处理仍为 queued / running 的条目，所以 Reporter、清理器、abort 处理即使重复到达也不会写出第二份汇报。
 */
export async function finishHandoff(
  tx: Tx,
  rootId: ConversationId,
  taskId: string,
  finish: Finish,
  now: number,
  by: NonNullable<Approval['by']> = 'cancelled',
): Promise<HandoffStatus | 'skipped'> {
  const handoffs = await tx.doc(HandoffsDoc, rootId)
  const item = handoffs.items.find(each => each.taskId === taskId)
  if (!item || !isActive(item.status)) return 'skipped'
  // 取消的承诺是"之后不会再有这个任务的汇报"：请求取消之后才到的结果也不汇报。
  const final: Finish = item.cancelRequested ? { status: 'cancelled' } : finish
  item.status = final.status
  item.endedAt = now
  // 进度与问题只属于进行中的一轮。
  delete item.progress
  delete item.question
  if (final.status !== 'cancelled') {
    const flagged = final.flagged ? ({ flagged: true } as const) : {}
    item.result = { text: final.text, ...(final.status === 'needs_input' || final.full === undefined ? {} : { full: final.full }), ...flagged }
    if (final.status === 'needs_input') item.question = final.question
    else if (final.status !== 'done') {
      const note = item.failure?.reason === MODEL_FALLBACK ? item.failure.detail : undefined
      const detail = [note, final.detail].filter(Boolean).join('; ')
      item.failure = { reason: final.reason, ...(detail ? { detail } : {}) }
    }
    const round = roundOf(item)
    const id = outboxIdOf(taskId, round)
    const outbox = await tx.doc(OutboxDoc, rootId)
    if (!outbox.pending.some(each => each.id === id) && outbox.delivered[id] === undefined) {
      outbox.pending.push({ id, taskId, round, status: final.status, text: final.text, ...flagged, at: now })
    }
  }
  await expireApprovals(tx, item.child as ConversationId, by, now)
  return final.status
}
