const PREFIX = 'amadeus_'
// 标签头超过这个长度还没遇到 '>'，说明不是正常标签，按文本放行比一直吞下去安全。
const TAG_LIMIT = 512

/**
 * 模型偶尔不走原生 tool call，而把调用写成正文里的标签（`<handoff><brief>…</brief></handoff>`）。
 * 这种文本什么也不会执行，念出来还会把委托说明整段读给主人，所以和 `<amadeus_*>` 围栏一样整块剔除；
 * 补救由 toolText 的 onYield 钩子让模型改用原生调用。这里列主对话的工具名和常见的伪调用格式，新增主对话工具要同步。
 */
export const TOOL_TEXT_TAGS: readonly string[] = [
  'handoff', 'handoff_send', 'handoff_status', 'handoff_cancel', 'remember', 'forget',
  'function_calls', 'tool_call', 'tool_use',
]
const LONGEST = Math.max(PREFIX.length, ...TOOL_TEXT_TAGS.map(name => name.length + 1)) + 2
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TOOL_TEXT = new RegExp(`<\\/?(${TOOL_TEXT_TAGS.map(escape).join('|')})(?=[\\s/>])`, 'i')

/** 正文里写成文本的工具调用，返回标签名；没有就是 undefined。 */
export const toolTextIn = (text: string): string | undefined => TOOL_TEXT.exec(text)?.[1]?.toLowerCase()

// 标签名的匹配本来就不分大小写，入口的前缀判断必须一致，否则 `<AMADEUS_memory>` 会整段漏进字幕。只折叠 ASCII，保证长度不变。
const head = (buffer: string): string => buffer.slice(0, LONGEST).replace(/[A-Z]/g, letter => letter.toLowerCase())

/** `<` 开头的缓冲是要剔除的标签头、还要等下一个分片才能判断，还是普通文本。 */
function classify(buffer: string, final: boolean): 'tag' | 'hold' | 'text' {
  const lower = head(buffer)
  const name = lower.slice(lower.startsWith('</') ? 2 : 1)
  if (name.startsWith(PREFIX)) return 'tag'
  // 工具名要求后面是空白、'/' 或 '>'：`<handoff_send>` 不能被当成 `<handoff` 的开头。
  if (TOOL_TEXT_TAGS.some(tag => name.startsWith(tag) && /[\s/>]/.test(name.charAt(tag.length)))) return 'tag'
  if (final) return 'text'
  if (lower === '<' || lower === '</' || PREFIX.startsWith(name) || TOOL_TEXT_TAGS.some(tag => tag.startsWith(name))) return 'hold'
  return 'text'
}

type Mode = 'text' | 'tag' | 'skip'

/**
 * 流式剔除 `<amadeus_*>…</amadeus_*>` 与写成文本的工具调用整块，以及游离的标签（architecture §4.4、§6）。
 * 这些标签是记忆和子代理结果的围栏，模型复述它们会让字幕和语音念出内部协议；围栏内的正文一并丢弃。
 * 标签可能被切在两个分片之间，所以文本末尾疑似标签前缀的部分先扣住，下一个分片或 final 时再决定。
 */
export class TagScrubber {
  private mode: Mode = 'text'
  private held = ''
  private tag = ''
  private close: RegExp | undefined
  private closeLength = 0
  private tail = ''

  push(delta: string, final = false): string {
    let buffer = this.held + delta
    this.held = ''
    let out = ''
    while (buffer) {
      if (this.mode === 'text') {
        const at = buffer.indexOf('<')
        if (at < 0) { out += buffer; break }
        out += buffer.slice(0, at)
        buffer = buffer.slice(at)
        const kind = classify(buffer, final)
        if (kind === 'tag') { this.mode = 'tag'; this.tag = ''; continue }
        if (kind === 'hold') { this.held = buffer; break }
        out += '<'
        buffer = buffer.slice(1)
      } else if (this.mode === 'tag') {
        const end = buffer.indexOf('>')
        if (end < 0) {
          this.tag += buffer
          buffer = ''
          if (this.tag.length > TAG_LIMIT) { out += this.tag; this.tag = ''; this.mode = 'text' }
          break
        }
        const tag = this.tag + buffer.slice(0, end + 1)
        buffer = buffer.slice(end + 1)
        this.tag = ''
        const name = /^<\/?([a-z][a-z0-9_]*)/i.exec(tag)?.[1]
        if (tag.startsWith('</') || tag.endsWith('/>') || !name) this.mode = 'text'
        else {
          const closing = `</${name}>`
          this.mode = 'skip'
          this.close = new RegExp(closing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          this.closeLength = closing.length
          this.tail = ''
        }
      } else {
        const haystack = this.tail + buffer
        const found = this.close?.exec(haystack)
        if (!found) {
          this.tail = haystack.slice(-(this.closeLength - 1))
          buffer = ''
          break
        }
        // tail 是上一个分片留下的尾巴，换算回 buffer 的偏移要减掉它。
        buffer = buffer.slice(found.index + this.closeLength - this.tail.length)
        this.mode = 'text'
        this.tail = ''
      }
    }
    if (final) {
      // 未闭合的围栏宁可丢弃到消息结尾，也不把内部内容泄漏出去。
      if (this.held) { out += this.held; this.held = '' }
      this.mode = 'text'
      this.tag = ''
      this.tail = ''
    }
    return out
  }
}
