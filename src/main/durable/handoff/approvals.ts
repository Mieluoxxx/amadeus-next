import { awaitWithContext } from '@earendil-works/chord/context'
import type { Context, JsonValue } from '@earendil-works/chord'
import type { ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable'
import { ApprovalsDoc, type Approval } from './docs.ts'

export type ApprovalRequest = Pick<Approval, 'tool' | 'summary' | 'detail'>
export type Decision = 'allow' | 'deny' | 'expired'

const isDecided = (state: Approval['state'] | undefined): state is Decision => state !== undefined && state !== 'pending'

/**
 * 在本子对话的 app.approvals 写一条 pending，等主人在界面上点击（task.approve 写回 state）。
 * 放在工具的 execute 里而不是 beforeTool hook：hook 不能提交事务，在 hook 里等待既不持久也会阻塞（pi-tool-constraints §4.3）。
 * approvalId = 工具任务的 TaskId：callId 只在单条 assistant 消息内唯一，不能当会话内的键。
 *
 * 取消或中止时 awaitWithContext 抛出，工具任务以 aborted 收尾；遗留的 pending 由 Reporter 的 finishHandoff 置 expired（cancelled）。
 */
export async function requestApproval(api: ToolExecutionApi, context: Context, request: ApprovalRequest, ttlMs: number): Promise<Decision> {
  const approvalId = String(api.taskId)
  const requestedAt = Date.now()
  const expiresAt = requestedAt + ttlMs
  await api.commit(async tx => {
    const approvals = await tx.doc(ApprovalsDoc, api.conversationId)
    approvals.items[approvalId] = { ...request, state: 'pending', requestedAt, expiresAt }
  }, context)

  // 先取监视再看 value：acquisition 之后的变化都会排队到 start 之后投递，不会落在两者之间。
  const watch = await api.watchDoc(ApprovalsDoc, api.conversationId, context)
  // 文档在上面的 commit 里已经建好；真的取不到只能当作无人批准。
  if (!watch) return 'expired'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const decided = new Promise<Decision>((resolve, reject) => {
      const initial = watch.value?.items[approvalId]?.state
      if (isDecided(initial)) return resolve(initial)
      watch.start(async value => {
        const state = value?.items[approvalId]?.state
        if (isDecided(state)) resolve(state)
      })
      // 过期只在进程内计时：崩溃后这个工具本来就是 interrupted，不需要持久。
      timer = setTimeout(() => {
        api
          .commit(async tx => {
            const item = (await tx.doc(ApprovalsDoc, api.conversationId)).items[approvalId]
            // 与主人的点击赛跑：已经有结论就以它为准，不覆盖。
            if (item.state === 'pending') {
              item.state = 'expired'
              item.by = 'timeout'
              item.decidedAt = Date.now()
            }
            return item.state as Decision
          }, context)
          .then(resolve, reject)
      }, Math.max(0, expiresAt - Date.now()))
    })
    const ended = watch.closed.then(end =>
      // 取消由 awaitWithContext 抛出（保证工具任务以 aborted 收尾）；其它终止原因不会再有通知，不能干等。
      end.reason === 'cancelled' || end.reason === 'stopped'
        ? new Promise<never>(() => {})
        : Promise.reject(new Error(`approval watch ended: ${end.reason}`)),
    )
    return await awaitWithContext(Promise.race([decided, ended]), context)
  } finally {
    clearTimeout(timer)
    await watch.stop()
  }
}

/** 模型可见的拒绝文案（pi-tool-constraints §4.3）；{target} 是命令首行（调用方已截断）或文件路径（不截断，截了就不是同一个路径）。 */
export function declinedResult<D extends JsonValue = JsonValue>(decision: Exclude<Decision, 'allow'>, tool: Approval['tool'], target: string): ToolExecutionResult<D> {
  const text =
    decision === 'expired'
      ? 'The user did not confirm in time, so this action was cancelled.'
      : `The user declined this action (${tool}: ${target.split('\n', 1)[0].trim()}). Do not retry the same thing in a different form; if you cannot continue without it, say so in your final report.`
  return { content: [{ type: 'text', text }], isError: true }
}
