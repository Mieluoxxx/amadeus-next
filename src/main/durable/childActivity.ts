import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentEvent, EntryRecord, UsageState } from '@earendil-works/pi-durable'

/**
 * 子代理对话的动作记录：工作面板的时间线与"最近几步"都读它。
 * 历史（entriesOf）与实时（watchEvents）走同一套翻译，id 稳定，界面按 id 合并即可对齐基线与增量。
 */
export type WorkAction =
  | { id: string; type: 'brief' | 'text' | 'progress'; text: string; at: number }
  | {
    id: string
    type: 'tool'
    tool: string
    /** 参数里最能说明这一步在做什么的那一项（路径、命令、查询词、网址）。 */
    label: string
    status: 'running' | 'ok' | 'error'
    at: number
    durationMs?: number
    output?: string
  }

const PROGRESS_TOOL = 'report_progress'
const LABEL_MAX = 160
const TEXT_MAX = 2000
const OUTPUT_MAX = 600
/** 内存里每个任务只留最近这么多条；完整历史由 task.trace 从库里读。 */
const LIVE_MAX = 200

const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

const LABEL_KEYS: Record<string, string> = {
  web_fetch: 'url',
  read_skill: 'skill',
  mcp_list_tools: 'server',
  read: 'path',
  list_dir: 'path',
  write: 'path',
  edit: 'path',
  bash: 'command',
}

export function labelOf(tool: string, args: unknown): string {
  const value = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  // MCP 调用一行里要同时看出是哪个 server 的哪个工具，参数放后面。
  if (tool === 'mcp_call' && typeof value.server === 'string' && typeof value.tool === 'string') {
    const rest = value.arguments && typeof value.arguments === 'object' && Object.keys(value.arguments).length ? ` ${JSON.stringify(value.arguments)}` : ''
    return clip(oneLine(`${value.server}.${value.tool}${rest}`), LABEL_MAX)
  }
  const key = LABEL_KEYS[tool]
  const picked = key ? value[key] : undefined
  if (typeof picked === 'string') return clip(oneLine(picked), LABEL_MAX)
  const compact = Object.keys(value).length ? JSON.stringify(value) : ''
  return clip(oneLine(compact), LABEL_MAX)
}

const textOf = (message: Message | undefined): string => {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

export const tokensOf = (usage: Readonly<UsageState> | undefined): number =>
  Object.values(usage?.models ?? {}).reduce((sum, each) => sum + (Number((each as { totalTokens?: unknown }).totalTokens) || 0), 0)

type Patch = Partial<Extract<WorkAction, { type: 'tool' }>> & { id: string }

export class ActivityLog {
  private readonly order: string[] = []
  private readonly byId = new Map<string, WorkAction>()
  private readonly dirty = new Set<string>()
  private readonly calls = new Set<string>()
  private readonly limit: number
  toolUses = 0
  tokens = 0

  constructor(limit = LIVE_MAX) { this.limit = limit }

  /** 有未推送的变化（动作或计数）。 */
  get pending(): boolean { return this.dirty.size > 0 || this.countsChanged }
  private countsChanged = false

  actions(): WorkAction[] { return this.order.map(id => this.byId.get(id)!) }

  /** 最近 n 个工具或进度动作，列表行展示用。 */
  recent(count: number): WorkAction[] {
    return this.actions().filter(action => action.type === 'tool' || action.type === 'progress').slice(-count)
  }

  /** 取出自上次以来变化过的动作（按出现顺序），并清空待推送标记。 */
  take(): WorkAction[] {
    const changed = this.order.filter(id => this.dirty.has(id)).map(id => this.byId.get(id)!)
    this.dirty.clear()
    this.countsChanged = false
    return changed
  }

  apply(events: readonly AgentEvent[]): void {
    for (const event of events) {
      if (event.type === 'snapshot') {
        for (const entry of event.entries) this.entry(entry)
        this.usage(event.usage)
      } else if (event.type === 'entry_appended' || event.type === 'message_end') this.entry(event.entry)
      else if (event.type === 'tool_execution_end') {
        if (event.entry) this.entry(event.entry)
        // 工具任务 faulted / orphaned 时没有结果条目；不标记的话这一步会一直显示在转。
        else this.patch({ id: `tool:${event.toolCallId}`, status: 'error' })
      } else if (event.type === 'usage_changed') this.usage(event.usage)
    }
  }

  usage(usage: Readonly<UsageState> | undefined): void {
    const tokens = tokensOf(usage)
    if (tokens === this.tokens) return
    this.tokens = tokens
    this.countsChanged = true
  }

  entry(entry: EntryRecord): void {
    const message = entry.model?.[0]
    if (!message) return
    if (entry.kind === 'pi.user' && message.role === 'user') {
      const text = textOf(message).trim()
      if (text) this.put({ id: `entry:${entry.id}`, type: 'brief', text: clip(text, TEXT_MAX), at: message.timestamp ?? 0 })
      return
    }
    if (entry.kind === 'pi.assistant' && message.role === 'assistant') return this.assistant(entry, message)
    if (message.role === 'toolResult') {
      if (message.toolName === PROGRESS_TOOL) return
      const output = clip(textOf(message).trim(), OUTPUT_MAX)
      this.patch({
        id: `tool:${message.toolCallId}`,
        status: message.isError ? 'error' : 'ok',
        ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
        ...(output ? { output } : {}),
      }, { tool: message.toolName, at: message.timestamp })
    }
  }

  private assistant(entry: EntryRecord, message: AssistantMessage): void {
    message.content.forEach((block, index) => {
      if (block.type === 'text') {
        const text = block.text.trim()
        if (text) this.put({ id: `entry:${entry.id}:${index}`, type: 'text', text: clip(text, TEXT_MAX), at: message.timestamp })
      } else if (block.type === 'toolCall') {
        if (block.name === PROGRESS_TOOL) {
          const note = String((block.arguments as Record<string, unknown>)?.note ?? '').trim()
          if (note) this.put({ id: `tool:${block.id}`, type: 'progress', text: note, at: message.timestamp })
          return
        }
        const known = this.byId.get(`tool:${block.id}`)
        if (!this.calls.has(block.id)) {
          this.calls.add(block.id)
          this.toolUses++
          this.countsChanged = true
        }
        this.put({
          id: `tool:${block.id}`,
          type: 'tool',
          tool: block.name,
          label: labelOf(block.name, block.arguments),
          // 结果可能先于调用到达（快照里两条都在），保留已有的结果。
          status: known?.type === 'tool' ? known.status : 'running',
          at: message.timestamp,
          ...(known?.type === 'tool' && known.durationMs !== undefined ? { durationMs: known.durationMs } : {}),
          ...(known?.type === 'tool' && known.output ? { output: known.output } : {}),
        })
      }
    })
  }

  private patch(patch: Patch, fallback?: { tool: string; at: number }): void {
    const known = this.byId.get(patch.id)
    if (known && known.type !== 'tool') return
    if (!known && !fallback) return
    const base: Extract<WorkAction, { type: 'tool' }> = known ?? { id: patch.id, type: 'tool', tool: fallback!.tool, label: '', status: 'running', at: fallback!.at }
    this.put({ ...base, ...patch, type: 'tool' })
  }

  private put(action: WorkAction): void {
    const known = this.byId.get(action.id)
    if (known && JSON.stringify(known) === JSON.stringify(action)) return
    if (!known) {
      this.order.push(action.id)
      if (this.order.length > this.limit) {
        const dropped = this.order.shift()!
        this.byId.delete(dropped)
        this.dirty.delete(dropped)
      }
    }
    this.byId.set(action.id, action)
    this.dirty.add(action.id)
  }
}
