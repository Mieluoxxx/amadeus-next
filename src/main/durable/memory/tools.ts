import { StringEnum, Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import { ToolResultEntry, type EntryRecord } from '@earendil-works/pi-durable'
import type { MemoryStore } from './store.ts'
import { recentUserTexts, triggeredByReport } from './turns.ts'
import { BODY_MAX, MEMORY_TYPES, type ErrorCode } from './types.ts'

// description / 返回文本是模型可见文案，逐字以 pi-tool-constraints.md §2.4 为准；改动须两处同改。
export const REMEMBER_DESCRIPTION = [
  'Write something the user has explicitly asked you to remember into long-term memory. Call it only when the user clearly says "remember this", "don\'t forget", "from now on ...", or explicitly corrects a habit of yours. Do not remember something just because it came up, and never record your own guesses.',
  'Reply to the user in a sentence first, then call this tool; do not repeat the content afterwards.',
  'type: profile (name, job, routine, city), preference, relationship (how you address each other, agreements, running jokes), feedback (lasting requests about how you speak), ongoing (something in progress that will last a while).',
  'body: third person, one to three sentences, self-contained (no "he" or "that thing"), at most 120 characters. Keep time words exactly as the user said them; do not convert them into dates yourself (the system records the date).',
  "source_quote: the user's own words, copied verbatim, not paraphrased. It is checked against what the user recently said, and a quote that cannot be found is rejected.",
  'If a memory about the same thing already exists it is updated, not duplicated. If the result lists a similar existing memory and the user is correcting it, call forget to remove the old one. A failure comes back with a reason; tell the user plainly.',
].join('\n')

export const FORGET_DESCRIPTION = [
  'Make something in long-term memory be forgotten. Call it only when the user clearly says "forget this", "stop remembering that" or "delete it".',
  'Reply to the user in a sentence first, then call this tool.',
  "query: what the user wants forgotten, in the user's own sense; do not widen it.",
  "If candidates come back, do not pick one yourself: ask the user which one, then call again with that candidate's id.",
  'Only "Forgot" means it is done; if nothing was found, say so plainly.',
].join('\n')

const reply = (text: string, details: { action: string; id?: string; ids?: string[] }, isError = false): ToolExecutionResult => ({
  content: [{ type: 'text', text }],
  details,
  ...(isError ? { isError: true } : {}),
})

const UNAVAILABLE_WRITE = 'Memory is temporarily unavailable; nothing was written. Try again later.'
const UNAVAILABLE_DELETE = 'Memory is temporarily unavailable; nothing was deleted.'
const REPORT_TURN_WRITE = 'Long-term memory can only be changed while replying to something the user just said. This turn was started by a task report, so nothing was written.'
const REPORT_TURN_DELETE = 'Long-term memory can only be changed while replying to something the user just said. This turn was started by a task report, so nothing was deleted.'
const FORGET_RATE_LIMIT = 'Too many memories were forgotten in the last minute (at most 3 per minute). Nothing was deleted. Tell the user, and try again later if they still want it.'
const FORGET_UNCONFIRMED = 'That id was not among the candidates returned by the last forget call, and the query does not match that memory. Nothing was deleted. Call forget with the query alone to get candidates, ask the user which one, then call again with its id.'

function rememberError(code: ErrorCode, length?: number): string {
  switch (code) {
    case 'disabled':
      return 'Long-term memory is turned off; nothing was written.'
    case 'empty':
      return "body and source_quote must not be empty: put the memory in body and copy the user's own words into source_quote."
    case 'too_long':
      return `The body has ${length ?? BODY_MAX + 1} characters; the limit is ${BODY_MAX}. Shorten it, keep it self-contained and in the third person, and call again.`
    case 'sensitive':
      return 'The content looks like it contains an ID number, password or key, so it was not written to long-term memory.'
    case 'injection':
      return 'The content looks like an instruction or markup rather than a fact about the user, so it was not written.'
    case 'quote_not_found':
      return "The quote was not found in what the user recently said. Nothing was saved. Call again with the user's exact words."
    case 'quote_too_short':
      return "The quote is too short to verify. Copy a longer stretch of the user's own words (at least 4 Chinese, Japanese or Korean characters, or 3 words). Nothing was saved."
    case 'quote_unrelated':
      return "The body says more than the quote supports. Copy the user's words that support the whole body into source_quote, or rewrite the body closer to those words. Nothing was saved."
    case 'limit':
      return 'Memory is full or writes are too frequent. Nothing was saved. Ask the user to tidy up memory in settings.'
    case 'invalid':
      return 'type must be one of profile, preference, relationship, feedback or ongoing, and body must be a string. Nothing was saved.'
    default:
      return UNAVAILABLE_WRITE
  }
}

const SCAN_PAGE = 30
const SCAN_PAGES = 5

/**
 * 本回合的触发输入 = 对话里最近的一个 `pi.user` 条目：run 的输入先于它的任何助手 / 工具结果条目落盘，
 * 此后只有主人插话会再产生 `pi.user`，那时最近的就是主人的话，放行也对。
 * 汇报输入（`<amadeus_handoff_result` 围栏）是子代理带回的网页 / 文件内容，不是主人说的，该回合禁止改记忆。
 * 工具在 commit 里只读 `scanEntries`，不写表（long-term-memory.md §3.3 第 5 步、V1）。
 * 最近的用户条目可能被长串工具调用挤出第一页，所以翻页找；翻完仍找不到按"不是主人说的"处理（宁可拒绝）。
 * `withCandidates`：forget 带 id 时还要读回此前 forget 返回的候选 id；候选在上一个用户回合里，所以找到用户输入后还要继续翻，直到找到或翻完。
 */
async function readTurn(api: ToolExecutionApi, context: Context, withCandidates = false): Promise<{ fromUser: boolean; userTurns: string[]; candidates: ReadonlySet<string> }> {
  return api.commit(async tx => {
    const items: EntryRecord[] = []
    let candidates: ReadonlySet<string> | undefined
    let cursor: Awaited<ReturnType<typeof tx.scanEntries>>['next']
    for (let page = 0; page < SCAN_PAGES; page++) {
      const result = await tx.scanEntries({ conversationId: api.conversationId, order: 'descending' }, SCAN_PAGE, cursor)
      items.push(...result.items)
      cursor = result.next
      if (withCandidates) candidates ??= lastCandidates(result.items)
      if (cursor === undefined) break
      if (triggeredByReport(items) !== undefined && (!withCandidates || candidates !== undefined)) break
    }
    return { fromUser: triggeredByReport(items) === false, userTurns: recentUserTexts(items, 8), candidates: candidates ?? new Set() }
  }, context)
}

/**
 * 降序条目里最近一次返回过候选的 forget 结果所带的 id（details 由 forget 自己写，模型改不了）。
 * 取"最近一次返回过候选的"而不是"最近一次 forget"：主人一次确认删两条时，第一条删完后第二条仍在同一份名单里。
 */
function lastCandidates(descending: readonly EntryRecord[]): ReadonlySet<string> | undefined {
  for (const entry of descending) {
    if (!ToolResultEntry.is(entry)) continue
    const message = entry.model?.[0] as { toolName?: string; details?: { action?: string; ids?: unknown } } | undefined
    if (message?.toolName !== 'forget' || message.details?.action !== 'candidates' || !Array.isArray(message.details.ids)) continue
    return new Set(message.details.ids.filter((id): id is string => typeof id === 'string'))
  }
  return undefined
}

export function createMemoryTools(store: MemoryStore) {
  const remember = defineTool({
    name: 'remember',
    description: REMEMBER_DESCRIPTION,
    parameters: Type.Object({
      type: StringEnum([...MEMORY_TYPES], { description: 'Memory type' }),
      body: Type.String({ description: 'One to three self-contained sentences in the third person, at most 120 characters' }),
      source_quote: Type.String({ description: "The user's own words, copied verbatim" }),
    }),
    // 幂等：id 由正文哈希决定，重放时命中已存在的文件，返回"已存在"。
    replay: 'safe',
    execute: async (args, api, context) => {
      try {
        const turn = await readTurn(api, context)
        if (!turn.fromUser) return reply(REPORT_TURN_WRITE, { action: 'report_turn' }, true)
        const outcome = await store.remember(args, turn.userTurns)
        if (!outcome.ok) return reply(rememberError(outcome.code, outcome.length), { action: outcome.code }, true)
        const { entry, similar } = outcome
        switch (outcome.action) {
          case 'exists':
            return reply(`This memory already exists (id ${entry.id}); nothing to write.`, { action: 'exists', id: entry.id })
          case 'updated':
            return reply(`Updated the existing memory (id ${entry.id}): ${entry.body}`, { action: 'updated', id: entry.id })
          default: {
            const hint =
              similar.length > 0
                ? `. Similar existing memory: ${similar.map(item => `[${item.id}] ${item.body}`).join('; ')}. If the user is correcting it, call forget to remove the old one.`
                : ''
            return reply(`Remembered (id ${entry.id}): ${entry.body}${hint}`, { action: 'remembered', id: entry.id })
          }
        }
      } catch (error) {
        if (context.abortSignal?.aborted) throw error
        console.error('[amadeus-next] remember failed:', error)
        return reply(UNAVAILABLE_WRITE, { action: 'io' }, true)
      }
    },
  })

  const forget = defineTool({
    name: 'forget',
    description: FORGET_DESCRIPTION,
    parameters: Type.Object({
      query: Type.String({ description: 'What the user wants forgotten, in their own words' }),
      id: Type.Optional(Type.String({ description: 'Candidate id returned by an earlier call; use it only after the user has confirmed which one' })),
    }),
    // 删除不存在的条目视为成功，重放安全。
    replay: 'safe',
    execute: async (args, api, context) => {
      try {
        const turn = await readTurn(api, context, typeof args.id === 'string' && args.id.trim() !== '')
        if (!turn.fromUser) return reply(REPORT_TURN_DELETE, { action: 'report_turn' }, true)
        const outcome = await store.forget(args, turn.candidates)
        if (!outcome.ok) {
          if (outcome.code === 'disabled') return reply('Long-term memory is turned off; nothing was deleted.', { action: 'disabled' }, true)
          if (outcome.code === 'empty') return reply('query must not be empty: say what the user wants forgotten.', { action: 'empty' }, true)
          if (outcome.code === 'limit') return reply(FORGET_RATE_LIMIT, { action: 'limit' }, true)
          if (outcome.code === 'unconfirmed') return reply(FORGET_UNCONFIRMED, { action: 'unconfirmed' }, true)
          return reply(UNAVAILABLE_DELETE, { action: 'io' }, true)
        }
        const { result } = outcome
        switch (result.kind) {
          case 'forgot':
            return reply(`Forgot (id ${result.id}): ${result.body}`, { action: 'forgot', id: result.id })
          case 'gone':
            return reply('That memory is already gone.', { action: 'gone' })
          case 'none':
            return reply('No related memory was found.', { action: 'none' })
          case 'candidates':
            return reply(
              `Several similar memories were found. Ask the user which one, then call again with its id: ${result.items.map((item, index) => `${index + 1}. [${item.id}] ${item.body}`).join('; ')}`,
              { action: 'candidates', ids: result.items.map(item => item.id) },
            )
        }
      } catch (error) {
        if (context.abortSignal?.aborted) throw error
        console.error('[amadeus-next] forget failed:', error)
        return reply(UNAVAILABLE_DELETE, { action: 'io' }, true)
      }
    },
  })

  return [remember, forget] as const
}
