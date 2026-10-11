import { watchEvents, type AgentEvent, type AgentEventStream, type ConversationId, type Harness, type MessageChange, type SubmissionId, type SubmissionRecord } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { TagScrubber } from './scrub.ts'

type Block = AssistantMessage['content'][number]
type Json = Record<string, unknown>
type Settled = Extract<SubmissionRecord, { status: 'done' | 'unanswered' }>

export type TurnKind = 'user' | 'report'
export type TurnOutcome = 'done' | 'aborted' | 'error'

type Turn = {
  requestId: string
  turnId: string
  kind: TurnKind
  /** 本回合清洗后的全文，turn.done 带给主进程做兜底。 */
  text: string
  submissionId?: SubmissionId
  entryId?: number
  record?: SubmissionRecord
  settled: boolean
}

export type SettledTurn = { requestId: string; turnId: string; kind: TurnKind; outcome: TurnOutcome }

export type BridgeOptions = {
  /** 事件名与载荷；会话 id 由调用方补。 */
  emit(name: string, payload: Json): void
  onSettled?(turn: SettledTurn): void
  /** 汇报输入变为 placed：此时才知道 entryId，用来补写 delivered（architecture §4.3 queued 特例）。 */
  onReportPlaced?(requestId: string, entry: number): void
  /** 任一 run 结束；`mapped` 为 false 表示找不到对应回合（恢复过程中的遗留 run），此时不会有 turn.* 事件，调用方改发 session.updated。 */
  onRunEnd?(mapped: boolean): void
  /** 根对话的某个任务 faulted / orphaned。任务自己不会再跑任何代码，需要它收尾的状态（委托条目）得由外部补做。 */
  onTaskFailed?(task: { taskId: number; kind: string; message: string }): void
  report?(error: unknown): void
}

const indexed = (blocks: readonly Block[]): Map<number, Block> => new Map(blocks.map((block, index) => [index, { ...block } as Block]))

export const kindOf = (requestId: string): TurnKind | undefined =>
  requestId.startsWith('turn:') ? 'user' : requestId.startsWith('report:') ? 'report' : undefined

const settledDetail = (record: Settled): string => {
  if (record.status !== 'unanswered') return ''
  const detail = record.detail
  const message = detail && typeof detail === 'object' && !Array.isArray(detail) && 'message' in detail ? String((detail as Json).message) : ''
  return message || record.reason
}

/**
 * 把根对话的 durable 事件流翻译成 turn.* 端口事件。
 *
 * 文本按"当前消息各 text 块全文减去已转发字符数"求差量：首段文本可能直接出现在 message_start 或 text_start 里，
 * 答案太短时甚至没有 text_delta（评估 §2.5），任何路径来的文本都不会漏，也不会重复。清洗器放在做差之后、发出之前。
 * 回合按 requestId 在提交前登记：极快的回答可能在 submit() 返回前就已落定，按提交 id 登记会错过它。
 */
export class EventBridge {
  private readonly options: BridgeOptions
  private readonly harness: Harness
  private readonly conversationId: ConversationId
  private readonly pending = new Map<string, Turn>()
  private readonly bySubmission = new Map<SubmissionId, Turn>()
  private current: Turn | undefined
  private blocks = new Map<number, Block>()
  private forwarded = new Map<number, number>()
  private stamp: number | undefined
  private scrubber = new TagScrubber()
  private buffer: { turn: Turn; text: string } | undefined
  private stream: AgentEventStream | undefined
  private stopped = false
  runActive = false

  private constructor(harness: Harness, conversationId: ConversationId, options: BridgeOptions) {
    this.harness = harness
    this.conversationId = conversationId
    this.options = options
  }

  /** 只在会话打开时附加一次；`hasRun` 表示库里有遗留的根对话 run（崩溃或强杀所致）。 */
  static async attach(harness: Harness, conversationId: ConversationId, options: BridgeOptions): Promise<{ bridge: EventBridge; hasRun: boolean }> {
    const bridge = new EventBridge(harness, conversationId, options)
    const stream = await bridge.connect()
    return { bridge, hasRun: stream.snapshot.run !== undefined }
  }

  private async connect(): Promise<AgentEventStream> {
    const stream = await watchEvents(this.harness, this.conversationId, BACKGROUND_CONTEXT)
    this.stream = stream
    stream.start(async events => this.batch(events))
    void stream.closed.then(end => {
      if (this.stopped || this.stream !== stream) return
      this.options.report?.(new Error(`event stream ended: ${end.reason}`))
      // 监听器整体包了 try/catch，正常不会走到 listener_error；万一发生，会话仍开着就重新附加，按快照做差补发。
      if (end.reason !== 'listener_error') return
      void this.connect().then(next => this.apply(next.snapshot)).catch(error => this.options.report?.(error))
    })
    return stream
  }

  /** 提交前登记：事件可能先于 submit() 的返回到达。 */
  expect(requestId: string, turnId: string): void {
    const kind = kindOf(requestId)
    if (!kind) throw new Error(`Unsupported request id: ${requestId}`)
    this.pending.set(requestId, { requestId, turnId, kind, text: '', settled: false })
  }

  forget(requestId: string): void {
    const turn = this.pending.get(requestId)
    this.pending.delete(requestId)
    if (!turn) return
    if (turn.submissionId !== undefined) this.bySubmission.delete(turn.submissionId)
    if (this.current === turn) this.current = undefined
    if (this.buffer?.turn === turn) this.buffer = undefined
  }

  /** 进行中回合的 turnId（含已提交未落定的），session.load 用来给历史里的当前回合带上 turnId。 */
  turnForEntry(entryId: number): string | undefined {
    for (const turn of this.pending.values()) if (turn.entryId === entryId) return turn.turnId
    return undefined
  }

  get unsettled(): number { return this.pending.size }

  /** 会话要关了：还没落定的回合不会再有事件，给主进程一个终止事件，不至于永远卡在 responding。 */
  abandon(code: string, error: string): void {
    this.flush()
    for (const turn of [...this.pending.values()]) {
      turn.settled = true
      this.options.emit('turn.error', { turnId: turn.turnId, kind: turn.kind, code, error })
    }
    this.pending.clear()
    this.bySubmission.clear()
    this.current = undefined
  }

  async stop(): Promise<void> {
    this.stopped = true
    const stream = this.stream
    this.stream = undefined
    await stream?.stop()
  }

  private target(): Turn | undefined {
    if (this.current) return this.current
    // run_start 排在同一批事件里 submission 之后，少数情况下文本先于它到达；只有一个未落定回合时可以安全归属。
    if (this.pending.size !== 1) return undefined
    return this.pending.values().next().value
  }

  private batch(events: readonly AgentEvent[]): void {
    try {
      // 同一批里 run_end 排在 submission 之前、run_start 排在其后，所以先扫一遍提交记录。
      for (const event of events) if (event.type === 'submission') this.track(event.record)
      for (const event of events) this.apply(event)
      this.settleTerminal()
      this.flush()
    } catch (error) { this.options.report?.(error) }
  }

  private track(record: SubmissionRecord): void {
    let turn = this.bySubmission.get(record.id)
    if (!turn && record.requestId !== undefined) {
      turn = this.pending.get(record.requestId)
      if (turn) { turn.submissionId = record.id; this.bySubmission.set(record.id, turn) }
    }
    if (!turn) return
    turn.record = record
    if (record.entry !== undefined && turn.entryId === undefined) {
      turn.entryId = record.entry
      if (turn.kind === 'report') this.hook(() => this.options.onReportPlaced?.(turn.requestId, record.entry!))
    }
  }

  private apply(event: AgentEvent): void {
    switch (event.type) {
      case 'snapshot': {
        // 积压超过 100 批时会收到整份快照；保留已转发的字符数，从快照里的半成品继续做差，不把 entries 当新增内容重放。
        const message = event.generation?.message
        if (message) this.resume(message)
        if (event.run === undefined) { this.current = undefined; this.runActive = false }
        else {
          this.runActive = true
          this.current ??= event.run.inputs.map(id => this.bySubmission.get(id)).find(Boolean)
        }
        break
      }
      case 'run_start':
        this.runActive = true
        this.current = event.inputs.map(id => this.bySubmission.get(id)).find(Boolean)
        break
      case 'run_end':
        this.flush()
        this.endRun(event.inputs)
        break
      case 'message_start':
        if (event.message.role !== 'assistant') break
        this.start(event.message)
        break
      case 'message_update':
        for (const change of event.changes) this.change(change)
        this.collect()
        break
      case 'message_end': {
        const message = event.entry.model?.[0]
        if (message?.role !== 'assistant') break
        this.blocks = indexed(message.content)
        this.collect()
        this.finish()
        break
      }
      case 'tool_execution_start':
        this.tool(event.toolName, false)
        break
      case 'tool_execution_end':
        this.tool(event.toolName, true)
        break
      case 'auto_retry_start':
        this.options.report?.(new Error(`generation retry ${event.attempt}: ${event.errorMessage}`))
        break
      case 'task_failed':
        this.options.report?.(new Error(`task ${event.taskId} (${event.kind}) failed: ${event.message}`))
        this.hook(() => this.options.onTaskFailed?.({ taskId: event.taskId, kind: event.kind, message: event.message }))
        break
    }
  }

  private start(message: AssistantMessage): void {
    this.stamp = message.timestamp
    this.scrubber = new TagScrubber()
    this.forwarded = new Map()
    this.blocks = indexed(message.content)
    this.collect()
  }

  private resume(message: AssistantMessage): void {
    // 同一条消息继续做差；换了一条就按新消息从头算。
    if (this.stamp !== message.timestamp) {
      this.stamp = message.timestamp
      this.scrubber = new TagScrubber()
      this.forwarded = new Map()
    }
    this.blocks = indexed(message.content)
    this.collect()
  }

  private finish(): void {
    this.push(this.target(), this.scrubber.push('', true))
    this.blocks = new Map()
    this.forwarded = new Map()
    this.scrubber = new TagScrubber()
    this.stamp = undefined
  }

  private change(change: MessageChange): void {
    if (change.type === 'message') {
      this.blocks = indexed(change.message.content)
      return
    }
    if (change.type === 'text_delta') {
      const block = this.blocks.get(change.contentIndex)
      if (block?.type === 'text') this.blocks.set(change.contentIndex, { ...block, text: block.text + change.delta })
    } else if (change.type === 'text_start' || change.type === 'thinking_start' || change.type === 'toolcall_start' || change.type === 'block') {
      this.blocks.set(change.contentIndex, { ...change.block } as Block)
    }
  }

  private collect(): void {
    const turn = this.target()
    for (const [index, block] of [...this.blocks.entries()].sort((left, right) => left[0] - right[0])) {
      // thinking_* 与 toolcall_* 绝不进字幕和 TTS。
      if (block.type !== 'text') continue
      const done = this.forwarded.get(index) ?? 0
      if (block.text.length <= done) continue
      this.forwarded.set(index, block.text.length)
      this.push(turn, this.scrubber.push(block.text.slice(done)))
    }
  }

  private push(turn: Turn | undefined, text: string): void {
    if (!turn || !text) return
    turn.text += text
    if (this.buffer && this.buffer.turn !== turn) this.flush()
    if (this.buffer) this.buffer.text += text
    else this.buffer = { turn, text }
  }

  /** 一批 durable 事件合成一条 turn.text；任何其它 turn.* 事件之前都先冲刷，保序。 */
  private flush(): void {
    const buffer = this.buffer
    this.buffer = undefined
    if (!buffer || !buffer.text) return
    this.options.emit('turn.text', { turnId: buffer.turn.turnId, kind: buffer.turn.kind, delta: buffer.text })
  }

  private tool(name: string, done: boolean): void {
    const turn = this.target()
    if (!turn) return
    this.flush()
    // 事件封包自己有 name（事件名），工具名只能换个字段。
    this.options.emit('turn.tool', { turnId: turn.turnId, kind: turn.kind, tool: name, done })
  }

  private endRun(inputs: readonly SubmissionId[]): void {
    const mapped = inputs.some(id => this.bySubmission.has(id))
    for (const id of inputs) {
      const turn = this.bySubmission.get(id)
      if (turn) this.settle(turn)
    }
    this.current = undefined
    this.runActive = false
    this.hook(() => this.options.onRunEnd?.(mapped))
  }

  /** 没有 run 的终止（排队中的输入被撤回）与 run_end 晚于提交记录到达的情形，都在批末按记录落定。 */
  private settleTerminal(): void {
    for (const turn of [...this.pending.values()]) this.settle(turn)
  }

  private settle(turn: Turn): void {
    const record = turn.record
    if (turn.settled || !record || (record.status !== 'done' && record.status !== 'unanswered')) return
    turn.settled = true
    this.flush()
    this.pending.delete(turn.requestId)
    this.bySubmission.delete(record.id)
    const base = { turnId: turn.turnId, kind: turn.kind }
    let outcome: TurnOutcome
    if (record.status === 'done') {
      outcome = 'done'
      this.options.emit('turn.done', { ...base, text: turn.text })
    } else if (record.reason === 'aborted') {
      outcome = 'aborted'
      this.options.emit('turn.aborted', base)
    } else {
      outcome = 'error'
      this.options.emit('turn.error', { ...base, code: record.reason, error: settledDetail(record) || 'Pi request failed' })
    }
    this.hook(() => this.options.onSettled?.({ requestId: turn.requestId, turnId: turn.turnId, kind: turn.kind, outcome }))
  }

  /** 回调抛错不能打断同一批里后面的事件。 */
  private hook(call: () => void): void {
    try { call() } catch (error) { this.options.report?.(error) }
  }
}
