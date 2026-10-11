import type { Context } from '@earendil-works/chord'
import { ConversationBusy, type Conversation, type ConversationId, type Harness, type SubmissionRecord, type TaskId, type Tx } from '@earendil-works/pi-durable'
import { HandoffsDoc, OutboxDoc, isActive, type OutboxItem } from './docs.ts'
import { fenceResult, reasonText, renderReport } from './fence.ts'
import { expireApprovals, finishHandoff } from './settle.ts'

export type DeliverResult = {
  /** started：本次新提交；already：此前已提交（已记 delivered，或崩在两次提交之间被补记）；busy：什么都没写入；missing：pending 与 delivered 都没有。 */
  status: 'started' | 'busy' | 'already' | 'missing'
  submissionId?: number
  /** 提交记录仍为 queued 时为 null，等事件桥看到 placed 后补写。 */
  entryId?: number | null
}

/** outbox.pending 的当前内容，按完成时间。 */
export async function pendingReports(harness: Harness, rootId: ConversationId, context: Context): Promise<OutboxItem[]> {
  const outbox = await harness.snapshot(OutboxDoc, rootId, context)
  return outbox ? structuredClone(outbox.pending) : []
}

// 第 1 轮的记录保持 v1 的形状（没有 round），读取时按第 1 轮处理。
const roundField = (round: number | undefined): { round?: number } => (round !== undefined && round > 1 ? { round } : {})

async function recordDelivered(root: Conversation, item: Pick<OutboxItem, 'id' | 'taskId' | 'round'>, record: SubmissionRecord, context: Context): Promise<void> {
  await root.commit(async tx => {
    const outbox = await tx.doc(OutboxDoc, root.id)
    // 并发的两次投递（主进程重试）里后到的这次什么都不改。
    if (outbox.delivered[item.id] !== undefined) return
    const index = outbox.pending.findIndex(each => each.id === item.id)
    if (index >= 0) outbox.pending.splice(index, 1)
    outbox.delivered[item.id] = { submissionId: record.id, entryId: record.entry ?? null, taskId: item.taskId, ...roundField(item.round), at: Date.now() }
  }, context)
}

/**
 * 话筒空闲后把一份汇报作为用户输入提交给主对话（pi-tool-constraints §3.5）。
 *
 * 两次提交：submit 写入输入并启动回合，随后一个 commit 把 pending 移到 delivered。两步之间崩溃，重启后
 * reconcileHandoffs 或再次调用本函数都靠 requestId 找到已有提交，只补第二次，汇报不会重投。
 * whenBusy: 'reject' 在拒绝时不写入任何东西，同一个 requestId 可原样重试。
 */
export async function deliverReport(harness: Harness, root: Conversation, outboxId: string, context: Context): Promise<DeliverResult> {
  const outbox = await harness.snapshot(OutboxDoc, root.id, context)
  const delivered = outbox?.delivered[outboxId]
  if (delivered) return { status: 'already', submissionId: delivered.submissionId, entryId: delivered.entryId }
  const item = outbox?.pending.find(each => each.id === outboxId)
  if (!item) return { status: 'missing' }

  const requestId = `report:${outboxId}`
  const existing = await harness.commit(tx => tx.submissionByRequest(root.id, requestId), context)
  let record: SubmissionRecord
  if (existing) record = existing
  else {
    const handoffs = await harness.snapshot(HandoffsDoc, root.id, context)
    const kind = handoffs?.items.find(each => each.taskId === item.taskId)?.kind ?? 'unknown'
    try {
      const submission = await root.submit({ type: 'input', content: renderReport(item, kind), requestId, whenBusy: 'reject' }, context)
      record = await submission.status(context)
    } catch (error) {
      if (error instanceof ConversationBusy) return { status: 'busy' }
      throw error
    }
  }
  await recordDelivered(root, item, record, context)
  return { status: existing ? 'already' : 'started', submissionId: record.id, entryId: record.entry ?? null }
}

const reporterGone = (record: Awaited<ReturnType<Tx['task']>>): boolean => record === undefined || record.state.status === 'terminal'

/** 条目还是 queued / running，Reporter 却已终止或不存在：置 failed（lost）并补写 outbox。 */
async function sweepLost(tx: Tx, rootId: ConversationId, now: number): Promise<number> {
  const handoffs = await tx.doc(HandoffsDoc, rootId)
  const active = handoffs.items.filter(item => isActive(item.status)).map(item => ({ taskId: item.taskId, title: item.title, reporter: item.reporter }))
  let lost = 0
  for (const item of active) {
    if (!reporterGone(await tx.task(item.reporter as TaskId))) continue
    const fenced = fenceResult({ status: 'failed', title: item.title, text: '', reason: reasonText('lost') })
    const status = await finishHandoff(tx, rootId, item.taskId, { status: 'failed', reason: 'lost', ...fenced }, now)
    if (status === 'failed') lost++
  }
  return lost
}

/**
 * 清理器。Reporter faulted 时调度器只写任务终态、不会运行我们的代码，条目会卡在 running 并占住名额。
 * 随时可调：打开会话时（reconcileHandoffs 已包含）、事件桥看到 task_failed 时。
 */
export async function cleanLostHandoffs(harness: Harness, root: Conversation, context: Context): Promise<number> {
  return harness.commit(tx => sweepLost(tx, root.id, Date.now()), context)
}

export type ReconcileReport = { backfilled: number; entryFilled: number; approvalsExpired: number; lost: number }

/**
 * 打开会话时的对账（architecture §2.2 打开时序第 6 步）加清理器（第 7 步）。
 * **必须在 `harness.resume()` 之前调用**，此时没有任何任务在跑：
 * - 第三项把未终态委托的子对话里所有 pending 确认置 expired（by: restart），若有工具任务正在等待确认就会误伤；
 * - 清理器只看 Reporter 的持久状态（终止 / 不存在），不依赖任务已被调度，所以放在这里同样成立。
 * `resume()` 由调用方负责。
 */
export async function reconcileHandoffs(harness: Harness, root: Conversation, context: Context): Promise<ReconcileReport> {
  const now = Date.now()
  const report = await harness.commit(async tx => {
    // ① pending 里已有 report:<id> 提交的：崩在两次提交之间，补做第二次。
    const outbox = await tx.doc(OutboxDoc, root.id)
    const queued = outbox.pending.map(item => ({ id: item.id, taskId: item.taskId, round: item.round ?? 1 }))
    let backfilled = 0
    for (const item of queued) {
      const record = await tx.submissionByRequest(root.id, `report:${item.id}`)
      if (!record) continue
      const index = outbox.pending.findIndex(each => each.id === item.id)
      if (index >= 0) outbox.pending.splice(index, 1)
      outbox.delivered[item.id] = { submissionId: record.id, entryId: record.entry ?? null, taskId: item.taskId, ...roundField(item.round), at: now }
      backfilled++
    }
    // ③ 被打断的工具随后返回 interrupted，子代理自行决定是否重新请求确认。
    const handoffs = await tx.doc(HandoffsDoc, root.id)
    const children = handoffs.items.filter(item => isActive(item.status)).map(item => item.child as ConversationId)
    let approvalsExpired = 0
    for (const child of children) approvalsExpired += await expireApprovals(tx, child, 'restart', now)
    return { backfilled, approvalsExpired, lost: await sweepLost(tx, root.id, now) }
  }, context)

  // ② delivered 里 entryId 为空的：提交当时还是 queued，现在可能已 placed。
  const outbox = await harness.snapshot(OutboxDoc, root.id, context)
  const filled = new Map<string, number>()
  for (const [id, entry] of Object.entries(outbox?.delivered ?? {})) {
    if (entry.entryId !== null) continue
    const record = await (await harness.submission(entry.submissionId as never, context))?.status(context)
    if (record?.entry !== undefined) filled.set(id, record.entry)
  }
  if (filled.size > 0) {
    await root.commit(async tx => {
      const draft = await tx.doc(OutboxDoc, root.id)
      for (const [id, entryId] of filled) if (draft.delivered[id]?.entryId === null) draft.delivered[id].entryId = entryId
    }, context)
  }
  return { ...report, entryFilled: filled.size }
}
