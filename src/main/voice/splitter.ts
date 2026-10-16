/** 切出来的一段：`speak` 的交给导演配音；代码块、表格这类只该看的不配音。 */
export type Segment = { text: string; speak: boolean }

const ENDS = '。！？!?…；;'
// 句末标点后面紧跟的引号、括号属于这一句，不能甩给下一句的字幕开头。
const CLOSERS = '」』”’"\'）)】》'
const SOFT = '，、,：:'
// 第一句在开口的关键路径上：攒够这么多字遇到逗号就先送，不等句号。
const FIRST_MIN = 8
// 没有句号的长句在逗号处切，再长就硬切，免得一整段等到最后才配音。
const SOFT_MAX = 60
const HARD_MAX = 160
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const FENCE_PREFIX = /^ {0,3}[`~]{0,2}$/
const TABLE = /^ {0,3}\|/

/** 字幕不显示 Markdown 记号；配音导演拿原文，它需要知道哪里是行内代码。 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])(?:\s+|$)/, '')
    .replace(/\*\*|__|~~|`/g, '')
    .trim()
}

/**
 * 把主模型流式写出的中文切成可以逐句配音的段。
 * 围栏和表格要看行首才能认出来，所以行首的几个字符不够判断时先扣住，等下一个分片或 final。
 */
export class ScriptSplitter {
  private pending = ''
  private line = ''
  private lineStart = true
  private ending = false
  private fence = ''
  private block = ''
  private spoken = 0

  push(delta: string, final = false): Segment[] {
    this.pending += delta
    const out: Segment[] = []
    while (this.pending) {
      if (this.lineStart) {
        const newline = this.pending.indexOf('\n')
        const whole = newline >= 0 || final
        const line = newline >= 0 ? this.pending.slice(0, newline + 1) : this.pending
        if (this.fence) {
          if (!whole) break
          this.pending = this.pending.slice(line.length)
          this.block += line
          const trimmed = line.trim()
          if (trimmed.length >= this.fence.length && trimmed === trimmed[0].repeat(trimmed.length) && trimmed.startsWith(this.fence)) {
            out.push({ text: this.block, speak: false })
            this.fence = ''
            this.block = ''
          }
          continue
        }
        const fence = FENCE.exec(this.pending)
        if (fence || TABLE.test(this.pending)) {
          if (!whole) break
          this.pending = this.pending.slice(line.length)
          if (fence) { this.fence = fence[1]; this.block = line } else out.push({ text: line, speak: false })
          continue
        }
        if (!whole && FENCE_PREFIX.test(this.pending)) break
        this.lineStart = false
      }
      const char = this.pending[0]
      this.pending = this.pending.slice(1)
      if (char === '\n') {
        this.cut(out)
        this.lineStart = true
        continue
      }
      if (this.ending) {
        if (ENDS.includes(char) || CLOSERS.includes(char)) { this.line += char; continue }
        this.cut(out)
      }
      this.line += char
      if (ENDS.includes(char)) { this.ending = true; continue }
      const length = this.line.length
      if ((SOFT.includes(char) && (length >= SOFT_MAX || (this.spoken === 0 && length >= FIRST_MIN))) || length >= HARD_MAX) this.cut(out)
    }
    if (final) {
      // 没闭合的围栏也只是给人看的。
      if (this.fence) out.push({ text: this.block, speak: false })
      this.fence = ''
      this.block = ''
      this.cut(out)
      this.lineStart = true
    }
    return out
  }

  /** 主模型停下来调工具时，手头的半句先送去配音，"我去查一下"要在工具跑之前说出来。 */
  flush(): Segment[] {
    const out: Segment[] = []
    if (!this.fence) this.cut(out)
    return out
  }

  private cut(out: Segment[]): void {
    const text = this.line.trim()
    this.line = ''
    this.ending = false
    if (!plainText(text)) return
    out.push({ text, speak: true })
    this.spoken++
  }
}
