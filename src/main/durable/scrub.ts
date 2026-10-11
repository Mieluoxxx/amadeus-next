const OPEN = '<amadeus_'
const CLOSE = '</amadeus_'
// 标签头超过这个长度还没遇到 '>'，说明不是正常标签，按文本放行比一直吞下去安全。
const TAG_LIMIT = 512

// 标签名的匹配本来就不分大小写，入口的前缀判断必须一致，否则 `<AMADEUS_memory>` 会整段漏进字幕。只折叠 ASCII，保证长度不变。
const head = (buffer: string): string => buffer.slice(0, CLOSE.length).replace(/[A-Z]/g, letter => letter.toLowerCase())

type Mode = 'text' | 'tag' | 'skip'

/**
 * 流式剔除 `<amadeus_*>…</amadeus_*>` 整块以及游离的标签（architecture §4.4、§6）。
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
        const prefix = head(buffer)
        if (prefix.startsWith(OPEN) || prefix.startsWith(CLOSE)) { this.mode = 'tag'; this.tag = ''; continue }
        if (!final && (OPEN.startsWith(prefix) || CLOSE.startsWith(prefix))) { this.held = buffer; break }
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
        const name = /^<\/?(amadeus_[a-z0-9_]*)/i.exec(tag)?.[1]
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
