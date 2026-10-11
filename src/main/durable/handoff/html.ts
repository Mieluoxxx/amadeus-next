// 网页是外来输入，而 worker 是单线程、所有会话共用：这里的每一步都必须是线性的。
// 惰性正则（`[\s\S]*?`、`[^>]*`）在"起点很多、终点缺失"的页面上每个起点都扫到末尾，280KB 的 `<title ` 重复串就是几秒；
// 同步正则又无法被 abortSignal 打断。所以改成按位置前进的扫描：每个字符至多被检查常数次，找不到的收尾标记只找一次。

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? match
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })

// 整个元素连内容一起丢掉的标签；title 的文字另外取出，不留在正文里。
const SKIPPED = new Set(['script', 'style', 'noscript', 'svg', 'head', 'title'])
const BLOCKS = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const LT = 60
const GT = 62
const SLASH = 47
const BANG = 33
const QUESTION = 63

const isLetter = (code: number): boolean => (code | 32) >= 97 && (code | 32) <= 122
const isNameChar = (code: number): boolean => isLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58
// 标签名之后必须是空白、`/`、`>` 或到头：`<titled>` 不是 `<title>`。
const endsName = (code: number): boolean => Number.isNaN(code) || code === GT || code === SLASH || code === 32 || (code >= 9 && code <= 13)

/** `from` 之后第一个 `</name`（不分大小写）收尾标签的 [起点, `>` 之后]；没有则 undefined。每次探测都向前推进，所以是线性的。 */
function findClosing(html: string, name: string, from: number): { start: number; end: number } | undefined {
  let at = from
  for (;;) {
    const start = html.indexOf('</', at)
    if (start < 0) return undefined
    at = start + 2
    if (html.slice(at, at + name.length).toLowerCase() !== name || !endsName(html.charCodeAt(at + name.length))) continue
    const end = html.indexOf('>', at + name.length)
    return end < 0 ? undefined : { start, end: end + 1 }
  }
}

/** 第一个 `<title>…</title>` 的内部文字。没有收尾（或没有 `>`）就是后面都没有，直接放弃，不逐个起点重试。 */
function titleOf(html: string): string | undefined {
  let at = 0
  for (;;) {
    const open = html.indexOf('<', at)
    if (open < 0) return undefined
    at = open + 1
    if ((html.charCodeAt(at) | 32) !== 116 || html.slice(at, at + 5).toLowerCase() !== 'title' || !endsName(html.charCodeAt(at + 5))) continue
    const gt = html.indexOf('>', at + 5)
    if (gt < 0) return undefined
    const closing = findClosing(html, 'title', gt + 1)
    return closing ? html.slice(gt + 1, closing.start) : undefined
  }
}

export function htmlToText(html: string): string {
  const title = titleOf(html)
  const out: string[] = []
  // 已经确认"后面再没有收尾标签"的元素名：之后再遇到同名的开始标签，当普通标签处理，不再往后找。
  const unclosed = new Set<string>()
  let at = 0
  while (at < html.length) {
    const open = html.indexOf('<', at)
    if (open < 0) {
      out.push(html.slice(at))
      break
    }
    if (open > at) out.push(html.slice(at, open))
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      // 没有收尾的注释到文档末尾为止，和浏览器一致。
      if (end < 0) break
      out.push(' ')
      at = end + 3
      continue
    }
    const next = open + 1
    const closing = html.charCodeAt(next) === SLASH
    const nameStart = closing ? next + 1 : next
    const lead = html.charCodeAt(nameStart)
    // `a < b` 里的 `<` 是文字；`<!doctype>` 与 `<?xml?>` 当作标签丢掉。
    if (!isLetter(lead) && !(!closing && (lead === BANG || lead === QUESTION))) {
      out.push('<')
      at = next
      continue
    }
    let nameEnd = nameStart
    while (isNameChar(html.charCodeAt(nameEnd))) nameEnd++
    const name = html.slice(nameStart, nameEnd).toLowerCase()
    const close = html.indexOf('>', nameEnd)
    // 没有 `>` 的标签同样吞掉余下全部：后面不可能再有任何标签。
    if (close < 0) break
    at = close + 1
    if (!closing && SKIPPED.has(name) && !unclosed.has(name)) {
      const end = findClosing(html, name, at)
      if (end) {
        out.push(' ')
        at = end.end
        continue
      }
      unclosed.add(name)
    }
    out.push(BLOCKS.has(name) ? '\n' : ' ')
  }
  const lines = decodeEntities(out.join('')).split('\n').map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return title ? `Title: ${decodeEntities(title).replace(/\s+/g, ' ').trim()}\n${content}` : content
}
