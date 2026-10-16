import type { Message } from '@earendil-works/pi-ai'
import { GenerationTask, hook, type ConversationId, type HookRegistration } from '@earendil-works/pi-durable'
import { legacyScript } from '../../shared/presentation.ts'
import { TagScrubber, toolTextIn } from './scrub.ts'

/** 纠正消息的开头；历史据此把它藏起来，不当作主人的发言。 */
export const TOOL_TEXT_NOTICE = '[System note: tool call written as text]'

const notice = (tag: string): string => `${TOOL_TEXT_NOTICE}
Your last reply wrote <${tag}> as text. Text tags never run anything, and that part was hidden from the user. If you meant to use a tool, call it now through tool calling. Do not repeat what you already said; after the call, add at most one short line.`

export const isToolTextNotice = (message: Message | undefined): boolean => {
  if (message?.role !== 'user') return false
  const content = message.content
  const text = typeof content === 'string' ? content : content[0]?.type === 'text' ? content[0].text : ''
  return text.startsWith(TOOL_TEXT_NOTICE)
}

const scrubbed = (text: string): string => { const scrubber = new TagScrubber(); return scrubber.push(text) + scrubber.push('', true) }

/**
 * 历史里写成文本的工具调用会原样回放给模型，变成自我示范：一次泄漏之后它会照着继续写（实际会话里 handoff、remember 先后都这样丢了）。
 * 导演配音之前的旧回答带 `<zh>/<jp>` 双语标签，同理会把模型带回旧格式，所以一并还原成纯中文。
 * 只改本次请求、不改存储；变换是确定的，缓存前缀不受影响。纠正后的那次重试保留上一条回答原文，否则模型看不到自己写了什么。
 */
function rewriteHistory(messages: readonly Message[], keep: Message | undefined): readonly Message[] | undefined {
  let changed = false
  const result = messages.map(message => {
    if (message.role !== 'assistant' || message === keep) return message
    let touched = false
    const content = message.content.flatMap((block): typeof message.content => {
      if (block.type !== 'text') return [block]
      const text = legacyScript(toolTextIn(block.text) ? scrubbed(block.text) : block.text)
      if (text === block.text) return [block]
      touched = true
      return text.trim() ? [{ ...block, text }] : []
    })
    if (!touched) return message
    changed = true
    return { ...message, content }
  })
  return changed ? result : undefined
}

/**
 * 模型把工具调用写成正文标签时，在同一个 run 里追加一条纠正、让它改用原生调用（只认原生调用，文本当作出错）。
 * 每个 run 只纠正一次：纠正后的那次请求最后一条 user 消息就是纠正本身，再写成文本就随它结束，避免来回打转。
 * HookApi 读不到对话上下文，所以用 beforeRequest 记下"这次请求是不是纠正后的重试"；进程重启丢了状态，最多多纠正一次。
 * 挂在 amadeus-role 上而不是单独的扩展：已有会话按名字选扩展，新扩展名进不了旧会话。
 */
export function toolTextHook(): HookRegistration {
  const retried = new Map<ConversationId, boolean>()
  return hook(GenerationTask, {
    beforeRequest: (request, api) => {
      const reversed = [...request.messages].reverse()
      const last = reversed.find(message => message.role === 'user')
      const notice = isToolTextNotice(last)
      if (notice) retried.set(api.conversationId, true)
      else retried.delete(api.conversationId)
      const messages = rewriteHistory(request.messages, notice ? reversed.find(message => message.role === 'assistant') : undefined)
      return messages ? { messages } : undefined
    },
    onYield: (answer, api) => {
      if (retried.get(api.conversationId)) return undefined
      const tag = toolTextIn(answer.content.map(block => block.type === 'text' ? block.text : '').join(''))
      return tag ? { continue: notice(tag) } : undefined
    },
  })
}
