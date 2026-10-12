import { defineDoc, type ConversationId, type Tx } from '@earendil-works/pi-durable'

export type HandoffKind = 'research' | 'files' | 'task' | 'remote'
export type HandoffStatus = 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'cancelled' | 'needs_input'

/** handoff_send 的幂等记录；steer 的正文留在这里，由 Reporter 投递给子对话（pi-tool-constraints §3.7）。 */
export type HandoffMessage = {
  /** `${工具任务 id}:${provider 的 callId}`，与 HandoffItem.callId 同一套键。 */
  callId: string
  round: number
  mode: 'steer' | 'followUp'
  at: number
  /** 只有 steer 带正文；followUp 的正文在新一轮 Reporter 的输入里。 */
  text?: string
}

export type HandoffItem = {
  /** 't_01'，会话内单调递增，模型与界面共用。 */
  taskId: string
  /** `${工具任务 id}:${provider 的 callId}`：provider 的 callId 只在单条 assistant 消息内唯一，单独当键会把不同回合的调用误判成重放。 */
  callId: string
  kind: HandoffKind
  title: string
  /** kind + 规整后的 brief，查重用。 */
  briefHash: string
  child: number
  anchor: number
  reporter: number
  /** 任务私有目录；会话没有登记 taskRoot 时为空串。remote 是远程机器上的工作目录（受理时取过 realpath）。 */
  cwd: string
  paths: string[]
  /**
   * remote 的目标名，受理时钉死：执行环境按它选，崩溃恢复、续接都回到同一台机器；之后改设置里的远程机器也不会让任务换机器。
   * 本机任务没有这个字段。
   */
  target?: string
  status: HandoffStatus
  /** 从 1 开始；每次 handoff_send 续接已结束的任务加一。v1 的条目没有这个字段，initHandoffDocs 打开时补 1。 */
  round: number
  cancelRequested?: true
  createdAt: number
  /** 本轮开始、结束的时间；新一轮开始时清空。 */
  startedAt?: number
  endedAt?: number
  /** handoff_send 的幂等记录，按调用顺序追加。 */
  messages?: HandoffMessage[]
  /** 子代理 report_progress 写入的最近一条；任务结束或开始新一轮时清除。 */
  progress?: { text: string; at: number }
  /** status 为 needs_input 时子代理的问题。 */
  question?: string
  /**
   * text 是围栏前的正文（与汇报同一份，给模型的截断版）；full 在被截断时是完整正文（≤ CARD_MAX_CHARS），任务卡片读它。
   * 汇报（outbox）里不带 full。
   */
  result?: { text: string; full?: string; flagged?: true }
  /** detail 只给卡片展开，不进围栏。委托模型回退时（reason 为 model_fallback）任务仍在进行，这里只是一条备注。 */
  failure?: { reason: string; detail?: string }
}

export type Handoffs = {
  seq: number
  /** 数组顺序即排队顺序。 */
  items: HandoffItem[]
  /** 任务私有目录的父目录（`<会话目录>/handoff`）；durable 看不到会话目录，只能由宿主在 root 初始化时登记。 */
  taskRoot?: string
}

export type OutboxItem = {
  /** 第 1 轮与 taskId 同值，之后是 `${taskId}.${round}`（每轮各有一份汇报）；requestId 一律是 `report:${id}`。 */
  id: string
  taskId: string
  /** v1 的待投递汇报没有这个字段，initHandoffDocs 打开时补 1。 */
  round: number
  status: 'done' | 'failed' | 'timeout' | 'needs_input'
  text: string
  flagged?: true
  at: number
}

export type DeliveredReport = {
  submissionId: number
  /** submit 返回时记录仍为 queued 则为 null，等 placed 后补齐。 */
  entryId: number | null
  taskId: string
  /** v1 记录没有这个字段，按第 1 轮处理。 */
  round?: number
  at: number
}

export type Outbox = {
  pending: OutboxItem[]
  delivered: Record<string, DeliveredReport>
}

/**
 * 确认卡片给主人看的原文，worker 事件与本文档同形；本地化由渲染进程负责，所以这里不放任何界面文案。
 * command / preview 是批准所依据的完整内容（限长在写入前由工具包装拒绝，不截断），界面不得截断。
 */
export type ApprovalDetail = {
  tool: 'bash' | 'write' | 'edit' | 'mcp'
  command?: string
  cwd?: string
  path?: string
  preview?: string
  /** 仅 mcp：server 名与它的工具名；preview 是完整的 JSON 参数。 */
  server?: string
  mcpTool?: string
}

export type Approval = {
  tool: ApprovalDetail['tool']
  /** 一行短摘要，不是批准的依据：多行命令、写入内容、差异都只在 detail 里。 */
  summary: string
  detail: ApprovalDetail
  state: 'pending' | 'allow' | 'deny' | 'expired'
  by?: 'user' | 'timeout' | 'cancelled' | 'restart'
  requestedAt: number
  expiresAt: number
  decidedAt?: number
}

/** 键是 approvalId = String(工具任务的 TaskId)。 */
export type Approvals = { items: Record<string, Approval> }

const base = { version: 1, scope: 'conversation', history: 'latest', fork: 'initial' } as const

export const HandoffsDoc = defineDoc<Handoffs>({ ...base, kind: 'app.handoffs', initial: () => ({ seq: 0, items: [] }) })
export const OutboxDoc = defineDoc<Outbox>({ ...base, kind: 'app.outbox', initial: () => ({ pending: [], delivered: {} }) })
export const ApprovalsDoc = defineDoc<Approvals>({ ...base, kind: 'app.approvals', initial: () => ({ items: {} }) })

/** queued + running：占活动任务名额，Reporter 在运行。needs_input 不算：子代理已停下，等主人回答。 */
export const isActive = (status: HandoffStatus): boolean => status === 'queued' || status === 'running'

/** 已结束但还能用 handoff_send 续接的状态；cancelled 不能。 */
export const canContinue = (status: HandoffStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'timeout' || status === 'needs_input'

/**
 * 供 `root({ init })` 与"既有会话补建"共用：tx.doc 对已存在的文档是读取，所以可以重复调用。
 * watchDoc 不会创建文档，必须先建好，事件桥与 Reporter 才能监视。
 */
export async function initHandoffDocs(tx: Tx, rootId: ConversationId, options: { taskRoot?: string } = {}): Promise<void> {
  const handoffs = await tx.doc(HandoffsDoc, rootId)
  if (options.taskRoot !== undefined && handoffs.taskRoot !== options.taskRoot) handoffs.taskRoot = options.taskRoot
  // v1 写下的条目没有 round：补成 1，之后读取的地方不必各自兜底。
  for (const item of handoffs.items) if (item.round === undefined) item.round = 1
  const outbox = await tx.doc(OutboxDoc, rootId)
  for (const item of outbox.pending) if (item.round === undefined) item.round = 1
}
