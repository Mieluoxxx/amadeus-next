import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { Conversation, Cursor, EntryRecord } from '@earendil-works/pi-durable'
import { legacyScript } from '../../shared/presentation.ts'
import { CARD_MAX_CHARS, roundOf, type DeliveredReport, type HandoffItem } from './handoff/index.ts'
import { isMemoryEntry, isMemoryMessage } from './memory/index.ts'
import { TagScrubber } from './scrub.ts'
import { isToolTextNotice } from './toolText.ts'

/**
 * 任务卡片。round 从 1 开始；progress 只在任务进行中出现；question 只在 needs_input 时出现（summary 此时也是这个问题）。
 * 同一个任务每一轮各有一张汇报卡片（taskId 相同、round 不同）：较早的几轮从各自的汇报文本还原，只有最新一轮反映条目现在的状态。
 */
export type CardData = {
  taskId: string
  title: string
  status: string
  summary: string
  round: number
  progress?: { text: string; at: number }
  question?: string
}

/** `session.load` 的 messages 元素（architecture §7.2）；card 的 `text` 是摘要，完整数据在 `card`。 */
export type HistoryMessage = {
  id: string
  role: 'user' | 'assistant' | 'card'
  text: string
  turnId?: string
  card?: CardData
}

const PAGE = 500
const REPORT_FENCE = '<amadeus_handoff_result'

/** 任务卡片的数据：`pending` 移除后仍从 app.handoffs 读，不依赖 outbox（architecture §4.3）。 */
export function cardOf(item: Pick<HandoffItem, 'taskId' | 'title' | 'status' | 'result' | 'failure' | 'round' | 'progress' | 'question'>): CardData {
  // 围栏正文的首行是 "Task: <标题>"，卡片已有标题，摘要里不再重复。
  // 汇报围栏里的正文会截断，卡片承诺给的是全文：被截断时 Reporter 另存了 full。
  const body = item.status === 'needs_input' && item.question
    ? item.question
    : (item.result?.full ?? item.result?.text ?? '').replace(/^Task:[^\n]*\n?/, '').trim() || item.failure?.reason || ''
  const chars = Array.from(body)
  const summary = chars.length > CARD_MAX_CHARS ? `${chars.slice(0, CARD_MAX_CHARS).join('')}…` : body
  return {
    taskId: item.taskId,
    title: item.title,
    status: item.status,
    summary,
    round: roundOf(item),
    ...(item.progress ? { progress: { text: item.progress.text, at: item.progress.at } } : {}),
    ...(item.question ? { question: item.question } : {}),
  }
}

/**
 * 较早一轮的卡片：条目里的 result 已被后面的轮次覆盖，原文只剩在当时投递的汇报条目里。
 * 汇报正文的形状固定（renderReport）：围栏行、一到两行系统注、`Task:` 行、正文、结束行。
 */
function cardOfReport(current: CardData, round: number, text: string): CardData {
  const status = /^<amadeus_handoff_result [^>]*status="([^"]*)"/.exec(text)?.[1] ?? 'done'
  const lines = text.split('\n').slice(1)
  if (lines.at(-1) === '</amadeus_handoff_result>') lines.pop()
  while (lines[0]?.startsWith('[System note')) lines.shift()
  if (lines[0]?.startsWith('Task:')) lines.shift()
  const body = lines.join('\n').trim()
  const question = status === 'needs_input' ? body.replace(/^Question:\s*/, '') : undefined
  return { taskId: current.taskId, title: current.title, status, summary: question ?? body, round, ...(question ? { question } : {}) }
}

const textOf = (message: Message | undefined): string => {
  if (!message || message.role === 'toolResult') return ''
  if (typeof message.content === 'string') return message.content
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

const assistantText = (message: AssistantMessage): string =>
  message.content.map(block => block.type === 'text' ? block.text : '').join('')

export async function* entriesOf(root: Conversation): AsyncGenerator<EntryRecord> {
  let cursor: Cursor | undefined
  do {
    // 不用 viewState()：它只含压缩头之后的活动上下文，历史会缺。
    const page = await root.entries({ order: 'ascending' }, PAGE, cursor, BACKGROUND_CONTEXT)
    yield* page.items
    cursor = page.next
  } while (cursor)
}

const reportEntries = (delivered: Readonly<Record<string, DeliveredReport>>): Map<number, DeliveredReport> => {
  const map = new Map<number, DeliveredReport>()
  for (const report of Object.values(delivered)) if (report.entryId !== null) map.set(report.entryId, report)
  return map
}

/** 主人的发言，按时间顺序（不含汇报输入、记忆条目和宿主补的纠正）。 */
export async function userTexts(root: Conversation, delivered: Readonly<Record<string, DeliveredReport>>): Promise<string[]> {
  const reports = reportEntries(delivered)
  const texts: string[] = []
  for await (const entry of entriesOf(root)) {
    if (entry.kind !== 'pi.user' || isMemoryEntry(entry) || reports.has(entry.id) || isToolTextNotice(entry.model?.[0])) continue
    const text = textOf(entry.model?.[0])
    if (!text.startsWith(REPORT_FENCE)) texts.push(text)
  }
  return texts
}

/** 主人发言的次数；记忆重新冻结和会话自动命名按它触发，durable 不记轮次。 */
export async function countUserTurns(root: Conversation, delivered: Readonly<Record<string, DeliveredReport>>): Promise<number> {
  return (await userTexts(root, delivered)).length
}

export type HistoryInput = {
  delivered: Readonly<Record<string, DeliveredReport>>
  card(taskId: string): CardData | undefined
  /** 进行中回合的输入条目对应的 turnId；历史条目不带 turnId。 */
  turnOf(entryId: number): string | undefined
}

/**
 * entries → 界面消息（architecture §4.4）：
 * - `pi.user` 是用户气泡，`entryId` 在 delivered 里的（或围栏文本尚未补记 entryId 的）是汇报卡片；
 * - `pi.assistant` 同一次输入之后的多条合并为一个气泡；导演配音之前的旧回答带双语标签，还原成其中的中文；
 * - `aborted` / `error` 的 assistant 条目、system / tool / compaction / 记忆条目一律不显示。
 */
export async function readHistory(root: Conversation, input: HistoryInput): Promise<HistoryMessage[]> {
  const reports = reportEntries(input.delivered)
  const messages: HistoryMessage[] = []
  let run: { first: number; scrubber: TagScrubber; raw: string; turnId: string | undefined } | undefined
  let turnId: string | undefined

  const close = () => {
    if (!run) return
    const text = legacyScript(run.raw + run.scrubber.push('', true)).trim()
    if (text) messages.push({ id: String(run.first), role: 'assistant', text, ...(run.turnId ? { turnId: run.turnId } : {}) })
    run = undefined
  }

  for await (const entry of entriesOf(root)) {
    if (isMemoryEntry(entry)) continue
    const message = entry.model?.[0]
    if (entry.kind === 'pi.user') {
      // 纠正消息之后的回答和之前的属于同一次输入，接着合并进同一个气泡。
      if (isMemoryMessage(message) || isToolTextNotice(message)) continue
      close()
      const text = textOf(message)
      const delivered = reports.get(entry.id)
      if (delivered || text.startsWith(REPORT_FENCE)) {
        const taskId = delivered?.taskId ?? /task_id="([^"]*)"/.exec(text)?.[1] ?? ''
        const latest = input.card(taskId)
        // v1 的记录没有 round，按第 1 轮；条目已进入更晚的一轮时，这条汇报对应的是较早的一轮。
        const round = delivered ? delivered.round ?? 1 : latest?.round
        const card = latest && round !== undefined && round < latest.round ? cardOfReport(latest, round, text) : latest
        if (card) messages.push({ id: String(entry.id), role: 'card', text: card.summary || card.title, card })
        turnId = input.turnOf(entry.id)
        continue
      }
      turnId = input.turnOf(entry.id)
      messages.push({ id: String(entry.id), role: 'user', text, ...(turnId ? { turnId } : {}) })
    } else if (entry.kind === 'pi.assistant' && message?.role === 'assistant') {
      if (message.stopReason === 'aborted' || message.stopReason === 'error') continue
      run ??= { first: entry.id, scrubber: new TagScrubber(), raw: '', turnId }
      // 和实时链路一样先经清洗器：写成文本的工具调用、复述的内部围栏都不该在重新加载后冒出来。
      run.raw += run.scrubber.push(assistantText(message))
    }
  }
  close()
  return messages
}
