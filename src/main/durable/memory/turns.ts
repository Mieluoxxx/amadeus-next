import { AssistantEntry, UserEntry, type EntryRecord } from '@earendil-works/pi-durable'

// 汇报输入带这个围栏（pi-tool-constraints.md §3.3）：它不是主人的话，不能用来核对引用，也不进抽取窗口。
export const REPORT_PREFIX = '<amadeus_handoff_result'

type Block = { type?: string; text?: string; name?: string }

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

export type Turn =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; text: string; tools: string[]; stopReason: string }

/** 对话条目（升序）→ 用户 / 助手回合；汇报输入及其后到下一个主人输入之前的助手条目一并排除。 */
export function turnsOf(entries: readonly EntryRecord[]): Turn[] {
  const turns: Turn[] = []
  let inReport = false
  for (const entry of entries) {
    if (UserEntry.is(entry)) {
      const text = contentText(entry.model?.[0]?.content)
      inReport = text.startsWith(REPORT_PREFIX)
      if (!inReport) turns.push({ id: entry.id, role: 'user', text })
    } else if (AssistantEntry.is(entry) && !inReport) {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') continue
      const content = message.content as Block[]
      turns.push({
        id: entry.id,
        role: 'assistant',
        text: contentText(content.filter(block => block.type === 'text')),
        tools: content.filter(block => block.type === 'toolCall').map(block => String(block.name)),
        stopReason: message.stopReason,
      })
    }
  }
  return turns
}

/** 降序条目里最近一个用户输入是不是汇报；一个用户输入都没有时返回 undefined。 */
export function triggeredByReport(descending: readonly EntryRecord[]): boolean | undefined {
  for (const entry of descending) if (UserEntry.is(entry)) return contentText(entry.model?.[0]?.content).startsWith(REPORT_PREFIX)
  return undefined
}

/** 主人最近 n 条用户回合的原文（降序条目 → 新的在前），用来核对 source_quote（long-term-memory.md §3.3 第 5 步）。 */
export function recentUserTexts(descending: readonly EntryRecord[], n = 8): string[] {
  const texts: string[] = []
  for (const entry of descending) {
    if (!UserEntry.is(entry)) continue
    const text = contentText(entry.model?.[0]?.content)
    if (text.startsWith(REPORT_PREFIX)) continue
    texts.push(text)
    if (texts.length >= n) break
  }
  return texts
}

/** 最近一个用户回合：输入、其后的助手条目是否出错 / 调用过哪些工具。降序条目；找不到用户输入返回 undefined。 */
export function latestUserTurn(descending: readonly EntryRecord[]): { text: string; report: boolean; tools: string[]; answered: boolean; failed: boolean } | undefined {
  const after: EntryRecord[] = []
  for (const entry of descending) {
    if (UserEntry.is(entry)) {
      const text = contentText(entry.model?.[0]?.content)
      const assistants = turnsOf([...after].reverse()).filter((turn): turn is Extract<Turn, { role: 'assistant' }> => turn.role === 'assistant')
      const last = assistants.at(-1)
      return {
        text,
        report: text.startsWith(REPORT_PREFIX),
        tools: assistants.flatMap(turn => turn.tools),
        answered: last !== undefined,
        failed: last?.stopReason === 'error' || last?.stopReason === 'aborted',
      }
    }
    after.push(entry)
  }
  return undefined
}
