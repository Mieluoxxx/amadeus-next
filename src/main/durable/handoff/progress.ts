import { Type } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable'
import { HandoffsDoc, isActive } from './docs.ts'
import { neutralizeTags, stripControl } from './fence.ts'

export const PROGRESS_NOTE_MAX_CHARS = 200

export const REPORT_PROGRESS_DESCRIPTION = [
  'Leave a short note about what you are doing right now, for example "Reading the second source". It is shown on the task card and to the assistant that delegated the task; it is not your final reply and does not end your work.',
  `Write one line of at most ${PROGRESS_NOTE_MAX_CHARS} characters. Call it when you move on to a new step, no more often than every 15 seconds or so.`,
].join('\n')

const reply = (text: string, isError = false): ToolExecutionResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) })

/**
 * 子代理的进度备注：写进本任务条目的 progress（按 api.conversationId 找到条目），最新一条覆盖旧的。
 * 它是子代理自己写的外来文本，会经 handoff_status 进入主对话的上下文，所以和其它子代理产出一样先折成一行并中和伪造的标签。
 * 对界面的推送由宿主节流（sessionHost 的 task.graph），这里每次调用都写，handoff_status 因此总能读到最新的一条。
 */
export const reportProgress = defineTool({
  name: 'report_progress',
  description: REPORT_PROGRESS_DESCRIPTION,
  parameters: Type.Object({ note: Type.String({ description: `One-line progress note, at most ${PROGRESS_NOTE_MAX_CHARS} characters` }) }),
  replay: 'safe',
  execute: async (args, api, context) => {
    const note = neutralizeTags(stripControl(args.note).replace(/\s+/g, ' ').trim())
    const length = Array.from(note).length
    if (length < 1) return reply('The note must not be empty.', true)
    if (length > PROGRESS_NOTE_MAX_CHARS) return reply(`The note has ${length} characters; the limit is ${PROGRESS_NOTE_MAX_CHARS}. Shorten it and call again.`, true)
    try {
      await api.commit(async tx => {
        const handoffs = await tx.doc(HandoffsDoc, ROOT_CONVERSATION_ID)
        const item = handoffs.items.find(each => each.child === api.conversationId)
        // 任务已结束（或不是委托的子对话）时不写；内容没变也不写，免得白白唤醒所有监视。
        if (!item || !isActive(item.status) || item.progress?.text === note) return
        item.progress = { text: note, at: Date.now() }
      }, context)
    } catch (error) {
      // 取消与中止原样抛出；进度只是附带信息，存储失败不该让子代理分心。
      if (context.abortSignal?.aborted) throw error
    }
    return reply('Noted.')
  },
})
