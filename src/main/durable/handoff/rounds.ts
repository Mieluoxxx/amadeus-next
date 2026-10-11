import type { HandoffItem } from './docs.ts'

// 一个任务可以有多轮（handoff_send 续接已结束的任务，pi-tool-constraints §3.7）。
// 第 1 轮的 requestId 与汇报 id 保持 v1 的写法，既有会话里已提交 / 已登记的东西才能照常去重。

export const roundOf = (item: Pick<HandoffItem, 'round'>): number => item.round ?? 1

/** 每轮各有一份汇报：第 1 轮是 taskId，之后是 `${taskId}.${round}`。 */
export const outboxIdOf = (taskId: string, round: number): string => (round <= 1 ? taskId : `${taskId}.${round}`)

/** 向子对话提交本轮开头那条输入（第 1 轮是 brief，之后是 handoff_send 的消息）的 requestId。 */
export const requestIdOf = (taskId: string, round: number): string => (round <= 1 ? `handoff:${taskId}` : `handoff:${taskId}:${round}`)

/** steer 消息的 requestId，键是它在 item.messages 里的下标：只追加，下标稳定。 */
export const noteRequestIdOf = (taskId: string, index: number): string => `handoff:${taskId}:n${index}`

// 子代理的 instructions 说"只管完成 brief 里的任务"，后续输入要标明来源，它才知道这是同一件事的延续。
export const followUpContent = (message: string): string => `Follow-up from the delegating assistant:\n${message}`
export const steerContent = (message: string): string => `Update from the delegating assistant while you work:\n${message}`

// 协议记号，大小写敏感；全角冒号是中文输入法的常见写法。
const QUESTION = /^\s*QUESTION[:：]/

/** 子代理最后一条回复以 `QUESTION:` 开头就是在向主人提问（§3.7）。空问题不算：当作普通回答。 */
export function questionIn(text: string): string | undefined {
  const match = QUESTION.exec(text)
  if (!match) return undefined
  return text.slice(match[0].length).trim() || undefined
}
