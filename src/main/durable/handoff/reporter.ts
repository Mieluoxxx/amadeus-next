import { mkdir } from 'node:fs/promises'
import type { Context } from '@earendil-works/chord'
import {
  ROOT_CONVERSATION_ID,
  UsageDoc,
  defineTask,
  type ConversationId,
  type EntryRecord,
  type SettledSubmissionRecord,
  type Submission,
  type TaskId,
  type TaskRuntime,
} from '@earendil-works/pi-durable'
import { ApprovalsDoc, HandoffsDoc, isActive, type Approval, type HandoffItem, type HandoffKind } from './docs.ts'
import { cleanQuestion, fenceResult, reasonText, type FailureReason } from './fence.ts'
import type { HandoffLimits } from './limits.ts'
import { followUpContent, noteRequestIdOf, questionIn, requestIdOf, roundOf, steerContent } from './rounds.ts'
import { finishHandoff, type Finish } from './settle.ts'

export const ANCHOR_TASK_NAME = 'amadeus.handoff-anchor'
export const REPORTER_TASK_NAME = 'amadeus.handoff-reporter'

export type AnchorInput = { taskId: string }

/**
 * 子对话的归属者，只存在于所有权链上：createConversation 要求显式归属，而归属后台任务的子对话，
 * 其运行既不挡主对话的空闲等待，也不被普通的 chat.abort 波及。终态后仍留在链上，abort({ background: true }) 照样穿过它。
 */
export const AnchorTask = defineTask<AnchorInput, { phase: 'hold' }, null, object>({
  name: ANCHOR_TASK_NAME,
  version: 1,
  initial: () => ({ phase: 'hold' }),
  phases: {
    hold: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context)
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
  },
})

export type ReporterInput = {
  taskId: string
  childId: number
  kind: HandoffKind
  /** ≤ 1500 字，留在任务输入里，deliver 阶段重启后仍可重新取得。第 2 轮起是 handoff_send 的消息。 */
  brief: string
  cwd: string
  /** 这个 Reporter 负责的轮次；v1 的任务没有这个字段，按第 1 轮处理。 */
  round?: number
}

type Outcome =
  | { type: 'done'; answer: number }
  | { type: 'needs_input'; answer: number; question: string }
  | { type: 'cancelled' }
  | { type: 'failed' | 'timeout'; reason: FailureReason; detail?: string; limitMs?: number }

type ReporterState =
  | { phase: 'wait-slot' }
  // tokenBase、deniedBase：本轮开始时子对话已累计的用量与被拒次数。续接的任务不能带着上一轮的账开跑；v1 的检查点没有它们，按 0。
  | { phase: 'deliver'; activeMs: number; wallMs: number; tokenBase?: number; deniedBase?: number }
  | { phase: 'report'; outcome: Outcome }

type Runtime = TaskRuntime<ReporterInput, ReporterState, null, object>

const COMPLETED = { status: 'terminal', outcome: { status: 'completed', result: null } } as const

type Wake = { next(ms: number): Promise<void>; stop(): void }

/** 文档变化或超时都 resolve：变化唤醒取消检查，超时是节拍。 */
async function wakeOnHandoffs(runtime: Runtime, context: Context): Promise<Wake> {
  const watch = await runtime.watchDoc(HandoffsDoc, ROOT_CONVERSATION_ID, context)
  let changed = false
  let notify: (() => void) | undefined
  watch?.start(async () => {
    changed = true
    notify?.()
  })
  return {
    next: ms =>
      new Promise<void>(resolve => {
        if (changed) {
          changed = false
          resolve()
          return
        }
        // 节拍的定时器不该拖住进程退出。
        const timer = setTimeout(() => done(), ms)
        timer.unref()
        const wakeUp = () => {
          changed = false
          done()
        }
        const done = () => {
          clearTimeout(timer)
          // 只撤销自己登记的唤醒：赛跑落败遗留的旧 next 晚到的定时器不能抹掉新的。
          if (notify === wakeUp) notify = undefined
          resolve()
        }
        notify = wakeUp
      }),
    stop: () => void watch?.stop(),
  }
}

async function findItem(runtime: Runtime, taskId: string, context: Context): Promise<HandoffItem | undefined> {
  const handoffs = await runtime.snapshot(HandoffsDoc, ROOT_CONVERSATION_ID, context)
  return handoffs?.items.find(item => item.taskId === taskId) as HandoffItem | undefined
}

const alive = (record: { state: { status: string } } | undefined): boolean => record !== undefined && record.state.status !== 'terminal'

/** Reporter 当前所处的阶段（检查点里的 phase）；已终止或不存在时为 undefined。 */
export function reporterPhase(record: { state: { status: string; checkpoint?: unknown } } | undefined): ReporterState['phase'] | undefined {
  if (!record || record.state.status === 'terminal') return undefined
  return (record.state.checkpoint as Partial<ReporterState> | undefined)?.phase
}

/**
 * 能否抢到名额。已占名额 = running 且 Reporter 仍存活的条目（只信文档会因 Reporter faulted 泄漏名额）；
 * FIFO：自己必须是仍有人处理的 queued 里最早的。
 */
export async function slotFree(
  items: readonly Pick<HandoffItem, 'taskId' | 'status' | 'reporter' | 'cancelRequested'>[],
  me: string,
  concurrency: number,
  reporterAlive: (reporter: number) => Promise<boolean>,
): Promise<boolean> {
  let running = 0
  for (const item of items) if (item.status === 'running' && (await reporterAlive(item.reporter))) running++
  if (running >= concurrency) return false
  for (const item of items) {
    if (item.taskId === me) return true
    // 已请求取消的 queued 条目马上会转入 report，不占队首。
    if (item.status === 'queued' && !item.cancelRequested && (await reporterAlive(item.reporter))) return false
  }
  return false
}

function textOf(entry: EntryRecord | undefined): string {
  const message = entry?.model?.find(each => each.role === 'assistant')
  if (message?.role !== 'assistant') return ''
  return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n').trim()
}

const lastAssistantText = (entries: readonly EntryRecord[]): string => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const text = textOf(entries[index])
    if (text) return text
  }
  return ''
}

async function tokensUsed(runtime: Runtime, childId: ConversationId, context: Context): Promise<number> {
  const usage = await runtime.snapshot(UsageDoc, childId, context)
  return Object.values(usage?.models ?? {}).reduce((sum, bucket) => sum + (typeof bucket.totalTokens === 'number' ? bucket.totalTokens : 0), 0)
}

async function approvalsOf(runtime: Runtime, childId: ConversationId, context: Context) {
  const approvals = await runtime.snapshot(ApprovalsDoc, childId, context)
  return Object.values(approvals?.items ?? {})
}

// 重启作废（restart）与任务收尾（cancelled）不是主人的决定：只算主人点的拒绝和等到超时的确认。
const declinedCount = (approvals: readonly Pick<Approval, 'state' | 'by'>[]): number =>
  approvals.filter(approval => (approval.state === 'deny' || approval.state === 'expired') && approval.by !== 'restart' && approval.by !== 'cancelled').length

const FAILED_BY_REASON: Record<string, FailureReason> = { model_error: 'model_error', no_model: 'no_model', faulted: 'faulted', aborted: 'aborted' }

async function outcomeOf(runtime: Runtime, childId: ConversationId, record: SettledSubmissionRecord, context: Context): Promise<Outcome> {
  if (record.type === 'input' && record.status === 'done') {
    const view = await runtime.context(childId, context)
    const text = textOf(view.entries.find(entry => entry.id === record.answer))
    if (!text) return { type: 'failed', reason: 'empty_answer' }
    const question = questionIn(text)
    return question ? { type: 'needs_input', answer: record.answer, question } : { type: 'done', answer: record.answer }
  }
  // reset / stale 等没有专门文案的原因按内部出错处理，原始原因留给任务卡片。
  if (record.status !== 'unanswered') return { type: 'failed', reason: 'faulted' }
  const detail = record.detail === undefined ? record.reason : `${record.reason}: ${JSON.stringify(record.detail)}`
  return { type: 'failed', reason: FAILED_BY_REASON[record.reason] ?? 'faulted', detail }
}

const toReport = (runtime: Runtime, context: Context, outcome: Outcome) =>
  runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'report', outcome } }), context)

/**
 * 本轮的 steer 消息都已提交给子对话时才进入 report，返回 true；否则什么都不改，返回 false。
 * handoff_send 在条目仍是 running 时只登记消息、由本 Reporter 投递（见 deliver），所以子代理刚答完、消息还没送出的那一刻
 * 不会丢：这里的判断与 handoff_send 的登记在同一条提交线上，要么消息先登记（这里看到未送出，回去投递），
 * 要么条目先结束（handoff_send 看到已结束，改开新一轮）。
 */
async function reportIfNothingPending(runtime: Runtime, context: Context, input: ReporterInput, outcome: Outcome): Promise<boolean> {
  const round = input.round ?? 1
  let pending = false
  await runtime.commit(async tx => {
    const handoffs = await tx.doc(HandoffsDoc, ROOT_CONVERSATION_ID)
    const messages = handoffs.items.find(each => each.taskId === input.taskId)?.messages ?? []
    pending = false
    for (const [index, message] of messages.entries()) {
      if (message.mode !== 'steer' || message.round !== round || message.text === undefined) continue
      if (!(await tx.submissionByRequest(input.childId as ConversationId, noteRequestIdOf(input.taskId, index)))) {
        pending = true
        break
      }
    }
    return pending ? undefined : { status: 'running', checkpoint: { phase: 'report', outcome } }
  }, context)
  return !pending
}

/**
 * 委托的投递与汇报：wait-slot 排队、deliver 向子对话提交 brief 并监视、report 一个 commit 内写终态与 outbox。
 * 并发、超时、用量都由这里实现（durable 没有内置），数值来自 limits。
 */
export function createReporterTask(limits: HandoffLimits) {
  async function verdict(
    runtime: Runtime,
    input: ReporterInput,
    time: { activeMs: number; wallMs: number; tokenBase?: number; deniedBase?: number },
    context: Context,
  ): Promise<Outcome | undefined> {
    const item = await findItem(runtime, input.taskId, context)
    if (!item || item.cancelRequested) return { type: 'cancelled' }
    if (time.activeMs >= limits.activeTimeoutMs) {
      return { type: 'timeout', reason: 'timeout', limitMs: limits.activeTimeoutMs, detail: `active ${time.activeMs}ms >= ${limits.activeTimeoutMs}ms` }
    }
    if (time.wallMs >= limits.wallTimeoutMs) {
      return { type: 'timeout', reason: 'timeout', limitMs: limits.wallTimeoutMs, detail: `wall ${time.wallMs}ms >= ${limits.wallTimeoutMs}ms` }
    }
    const childId = input.childId as ConversationId
    if ((await tokensUsed(runtime, childId, context)) - (time.tokenBase ?? 0) > limits.tokenLimit) return { type: 'failed', reason: 'token_limit' }
    if (declinedCount(await approvalsOf(runtime, childId, context)) - (time.deniedBase ?? 0) >= limits.denyLimit) return { type: 'failed', reason: 'denied' }
    return undefined
  }

  return defineTask<ReporterInput, ReporterState, null, object>({
    name: REPORTER_TASK_NAME,
    version: 1,
    initial: () => ({ phase: 'wait-slot' }),
    phases: {
      'wait-slot': async (task, runtime, context) => {
        const { taskId } = task.input
        const round = task.input.round ?? 1
        const wake = await wakeOnHandoffs(runtime, context)
        try {
          for (;;) {
            const handoffs = await runtime.snapshot(HandoffsDoc, ROOT_CONVERSATION_ID, context)
            const item = handoffs?.items.find(each => each.taskId === taskId)
            // 条目已被清理器收尾，或已经进入更晚的一轮：没有什么可汇报的了。
            if (!handoffs || !item || !isActive(item.status) || roundOf(item) !== round) return await runtime.commit(() => COMPLETED, context)
            if (item.cancelRequested) return await toReport(runtime, context, { type: 'cancelled' })
            const reporterAlive = async (reporter: number) => alive(await runtime.getTask(reporter as TaskId, context))
            if (await slotFree(handoffs.items, taskId, limits.concurrency, reporterAlive)) {
              const childId = task.input.childId as ConversationId
              const base = round > 1
                ? { tokenBase: await tokensUsed(runtime, childId, context), deniedBase: declinedCount(await approvalsOf(runtime, childId, context)) }
                : {}
              // 快照只是预判；commit 在 Session 线上串行，里面再判一次并置位才不会超卖。
              await runtime.commit(async tx => {
                const draft = await tx.doc(HandoffsDoc, ROOT_CONVERSATION_ID)
                if (!(await slotFree(draft.items, taskId, limits.concurrency, async reporter => alive(await tx.task(reporter as TaskId))))) return undefined
                const mine = draft.items.find(each => each.taskId === taskId)!
                mine.status = 'running'
                mine.startedAt = runtime.now()
                return { status: 'running', checkpoint: { phase: 'deliver', activeMs: 0, wallMs: 0, ...base } }
              }, context)
              if ((await findItem(runtime, taskId, context))?.status === 'running') return
            }
            await wake.next(limits.tickMs)
          }
        } finally {
          // 同一次 invocation 会连续跑后面的阶段，不停掉的话监视会一直挂到任务结束。
          wake.stop()
        }
      },

      deliver: async (task, runtime, context) => {
        const { taskId, brief, cwd } = task.input
        const round = task.input.round ?? 1
        const childId = task.input.childId as ConversationId
        if (cwd) await mkdir(cwd, { recursive: true })
        const child = await runtime.conversation(childId, context)
        if (!child) return toReport(runtime, context, { type: 'failed', reason: 'faulted', detail: 'child conversation is missing' })
        // 本轮向子对话提交过的输入（开头那条加 handoff_send 的 steer），按 requestId 去重：重启后重放拿到同一个提交，每条只会进子对话一次。
        const sent = new Map<string, Promise<SettledSubmissionRecord>>()
        const settledRecords = new Map<string, SettledSubmissionRecord>()
        const send = async (content: string, requestId: string, whenBusy?: 'steer' | 'followUp') => {
          const submission: Submission = await child.submit({ type: 'input', content, requestId, ...(whenBusy ? { whenBusy } : {}) }, context)
          const waited = submission.wait(context).then(record => (settledRecords.set(requestId, record), record))
          waited.catch(() => {})
          sent.set(requestId, waited)
        }
        // 第 1 轮是 brief；之后是续接消息，此时子对话是空闲的，输入立即放进去并开始新的运行。
        await send(round > 1 ? followUpContent(brief) : brief, requestIdOf(taskId, round), round > 1 ? 'followUp' : undefined)
        // handoff_send 对运行中的任务只登记消息，由这里投递：子代理还没收到 brief、或刚答完的那一刻，直接 steer 都会错位。
        const deliverNotes = async () => {
          const messages = (await findItem(runtime, taskId, context))?.messages ?? []
          for (const [index, message] of messages.entries()) {
            const requestId = noteRequestIdOf(taskId, index)
            if (message.mode !== 'steer' || message.round !== round || message.text === undefined || sent.has(requestId)) continue
            await send(steerContent(message.text), requestId, 'steer')
          }
        }
        const wake = await wakeOnHandoffs(runtime, context)
        try {
          let { activeMs, wallMs } = task.state.checkpoint
          const { tokenBase, deniedBase } = task.state.checkpoint
          let last = runtime.now()
          let committedAt = last
          for (;;) {
            await deliverNotes()
            if (settledRecords.size === sent.size) {
              // 全部落定：以最后提交的那条为准（steer 放进同一次运行时与开头那条共用答案；子代理已空闲时送出的 steer 另起一次运行，答案在它那里）。
              const finalRecord = [...settledRecords.values()].reduce((a, b) => (b.id > a.id ? b : a))
              const outcome = await outcomeOf(runtime, childId, finalRecord, context)
              if (await reportIfNothingPending(runtime, context, task.input, outcome)) return
              continue
            }
            const woke = await Promise.race([
              ...[...sent].filter(([id]) => !settledRecords.has(id)).map(([, waited]) => waited.then(() => 'settled' as const)),
              wake.next(limits.tickMs).then(() => 'tick' as const),
            ])
            // 有输入落定：回到开头重新判断（可能全部落定了），不必先过一遍用量与超时检查。
            if (woke === 'settled') continue
            const now = runtime.now()
            wallMs += now - last
            // 有未决确认时不累加活跃时间：等主人点按钮不该算子代理的超时。
            if (!(await approvalsOf(runtime, childId, context)).some(approval => approval.state === 'pending')) activeMs += now - last
            last = now
            const stop = await verdict(runtime, task.input, { activeMs, wallMs, tokenBase, deniedBase }, context)
            if (stop) {
              // 先中止子对话再进 report：report 取"部分进展"时子对话必须已经落定。
              await child.abort(context)
              return await toReport(runtime, context, stop)
            }
            // 文档变化也会唤醒循环；检查点只按节拍写，免得别的任务的状态变化放大成写入。
            if (now - committedAt < limits.tickMs) continue
            committedAt = now
            await runtime.commit(
              () => ({ status: 'running', checkpoint: { phase: 'deliver', activeMs, wallMs, ...(tokenBase === undefined ? {} : { tokenBase }), ...(deniedBase === undefined ? {} : { deniedBase }) } }),
              context,
            )
          }
        } finally {
          wake.stop()
        }
      },

      report: async (task, runtime, context) => {
        const { taskId } = task.input
        const { outcome } = task.state.checkpoint
        const item = await findItem(runtime, taskId, context)
        const title = item?.title ?? ''
        let finish: Finish
        if (outcome.type === 'cancelled') finish = { status: 'cancelled' }
        else {
          const entries = (await runtime.context(task.input.childId as ConversationId, context)).entries
          if (outcome.type === 'done') {
            finish = { status: 'done', ...fenceResult({ status: 'done', title, text: textOf(entries.find(entry => entry.id === outcome.answer)) }) }
          } else if (outcome.type === 'needs_input') {
            finish = { status: 'needs_input', question: cleanQuestion(outcome.question), ...fenceResult({ status: 'needs_input', title, text: outcome.question }) }
          } else {
            const reason = reasonText(outcome.reason, outcome.limitMs)
            const fenced = fenceResult({ status: outcome.type, title, text: lastAssistantText(entries), reason })
            finish = { status: outcome.type, reason: outcome.reason, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }), ...fenced }
          }
        }
        await runtime.commit(async tx => {
          await finishHandoff(tx, ROOT_CONVERSATION_ID, taskId, finish, runtime.now())
          return COMPLETED
        }, context)
      },
    },

    // 会话删除走 abort({ background: true })：条目置 cancelled 且不写 outbox，目录马上就没了。
    abort: async (task, runtime, context) => {
      try {
        await (await runtime.conversation(task.input.childId as ConversationId, context))?.abort(context)
      } catch {
        // 子对话已被一并中止或 Harness 正在关闭；条目收尾不依赖它。
      }
      await runtime.commit(async tx => {
        await finishHandoff(tx, ROOT_CONVERSATION_ID, task.input.taskId, { status: 'cancelled' }, runtime.now())
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context)
    },
  })
}
