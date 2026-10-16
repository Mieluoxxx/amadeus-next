import { normalizeEmotion, type Emotion } from './character.ts'

type PresentationCue = { offset: number; emotion: Emotion }
/** 字幕在口播文本中的字符偏移，用于音频时间戳同步对齐。 */
type PresentationSubtitle = { offset: number; text: string }
/**
 * 拆分口播文本、界面显示文本与逐句对齐字幕，支持双语显示。
 * `speech` 是实际发给 TTS 的文本，带 Fish 语音标签；`text` 不含标签，cue 与字幕偏移都以它为准，
 * 这样无论服务端回传的对齐内容是否保留标签，时间轴都能对上。
 */
export type PresentedText = { text: string; speech: string; cues: PresentationCue[]; subtitles: PresentationSubtitle[]; display: string }

const BLOCK_TAGS = ['<zh>', '</zh>', '<jp>', '</jp>']
// Fish S2 把中括号当作自然语言描述而非固定枚举；限定为短英文短语，避免吞掉日文或 Markdown 链接里的方括号。
const VOICE_TAG = /^\[[a-z][a-z' -]{0,39}\]/i
const VOICE_TAG_PREFIX = /^\[[a-z' -]{0,40}$/i
const VOICE_TAGS = /\[[a-z][a-z' -]{0,39}\](?!\()/gi
// 模型只标了表情时按表情补一个语气；neutral 不补，否则长回复每句都会被压成同一种平淡语调。
export const VOICE_FOR_EMOTION: Partial<Record<Emotion, string>> = {
  smile: '[happy]', thinking: '[hesitant]', serious: '[serious]', sad: '[sad]',
  shy: '[embarrassed]', surprise: '[surprised]', angry: '[angry]',
}

/**
 * 旧格式的解码器：导演配音之前，模型自己写 `<zh>…</zh><jp>…</jp>` 和 `[EMO …]`。
 * 现在只用来把旧会话的回答还原成纯中文——界面历史要显示它，发给模型的历史也要换掉，否则模型会照着旧格式继续写。
 */
export class PresentationText {
  private pending = ''
  private code = ''
  private length = 0
  private mode: 'plain' | 'zh' | 'jp' = 'plain'
  private zh = ''
  private zhSeen = false
  private jp = ''
  private jpStart = 0
  private voiceDue = ''
  private voiced = false

  push(delta: string, final = false): PresentedText {
    this.pending += delta
    let text = ''
    let speech = ''
    let display = ''
    const cues: PresentationCue[] = []
    const subtitles: PresentationSubtitle[] = []
    const emit = (value: string) => {
      if (this.mode === 'zh') { this.zh += value; return }
      if (/\S/.test(value)) { speech += this.voiceDue; this.voiceDue = ''; this.voiced = false }
      speech += value
      text += value
      if (this.mode === 'jp') this.jp += value
      else display += value
    }
    const closeZh = () => {
      const line = this.zh.trim()
      this.zh = ''
      this.mode = 'plain'
      if (!line) return
      this.zhSeen = true
      display += line
      subtitles.push({ offset: this.length + text.length, text: line })
    }
    const closeJp = () => {
      const line = this.jp.trim()
      const subtitled = this.zhSeen
      this.mode = 'plain'
      this.zhSeen = false
      // 单语回复未提供独立中文字幕时，直接以口播文本充当显示字幕。
      if (line && !subtitled) { display += line; subtitles.push({ offset: this.jpStart, text: line }) }
    }
    while (this.pending) {
      const first = this.pending[0]
      if (!this.code && first === '\\') {
        if (this.pending.length === 1 && !final) break
        emit(this.pending.slice(0, 2))
        this.pending = this.pending.slice(2)
        continue
      }
      if (first === '`' || first === '~') {
        const run = this.pending.match(/^(`+|~+)/)![0]
        if (run.length === this.pending.length && !final) break
        if (!this.code && (first === '`' || run.length >= 3)) this.code = run
        else if (this.code === run) this.code = ''
        emit(run)
        this.pending = this.pending.slice(run.length)
        continue
      }
      if (!this.code && first === '<') {
        const tag = this.pending.match(/^<(\/?)(zh|jp)>/i)
        if (tag) {
          const close = tag[1] === '/'
          const name = tag[2].toLowerCase()
          if (name === 'zh') {
            if (this.mode === 'jp') closeJp()
            if (close) { if (this.mode === 'zh') closeZh() } else { this.mode = 'zh'; this.zh = '' }
          } else if (close) {
            if (this.mode === 'jp') closeJp()
          } else {
            if (this.mode === 'zh') closeZh()
            else if (this.mode === 'jp') closeJp()
            this.mode = 'jp'; this.jp = ''; this.jpStart = this.length + text.length
          }
          this.pending = this.pending.slice(tag[0].length)
          continue
        }
        if (!final && BLOCK_TAGS.some(known => known.startsWith(this.pending.toLowerCase()))) break
      }
      if (!this.code && this.mode !== 'zh' && first === '[') {
        if (!final && '[EMO'.startsWith(this.pending.toUpperCase())) break
        if (/^\[EMO\b/i.test(this.pending)) {
          const end = this.pending.indexOf(']')
          if (end < 0 && !final && this.pending.length < 256) break
          if (end >= 0 && end < 256) {
            const tag = this.pending.slice(0, end + 1)
            const match = tag.match(/^\[EMO\s+preset=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s\]]+))(?:\s+dur=\d+(?:\.\d+)?s)?\s*\]$/i)
            const emotion = match && normalizeEmotion(match[1] || match[2] || match[3])
            if (emotion) {
              cues.push({ offset: this.length + text.length, emotion })
              // 模型已为这句写了语音标签时不再叠加兜底语气，标签与表情谁先写都一样。
              this.voiceDue = this.voiced ? '' : VOICE_FOR_EMOTION[emotion] ?? ''
              this.pending = this.pending.slice(end + 1)
              continue
            }
          }
        }
        if (!final && VOICE_TAG_PREFIX.test(this.pending)) break
        const voice = this.pending.match(VOICE_TAG)
        if (voice) {
          // 需要看到下一个字符才能排除 `[text](url)` 形式的链接。
          if (voice[0].length === this.pending.length && !final) break
          if (this.pending[voice[0].length] !== '(') {
            speech += voice[0]
            this.voiceDue = ''
            this.voiced = true
            this.pending = this.pending.slice(voice[0].length)
            continue
          }
        }
      }
      emit(first)
      this.pending = this.pending.slice(1)
    }
    if (final) {
      if (this.mode === 'zh') closeZh()
      else if (this.mode === 'jp') closeJp()
    }
    this.length += text.length
    return { text, speech, cues, subtitles, display }
  }

  finish(): PresentedText { return this.push('', true) }
}

const LEGACY = /<\/?(?:zh|jp)>|\[EMO\b/i

/** 只有确实带旧标签的文本才过解码器：新回答是普通 Markdown，解码器会误吞 `[x]` 之类的方括号。 */
export function legacyScript(text: string): string {
  if (!LEGACY.test(text)) return text
  const parser = new PresentationText()
  return parser.push(text).display + parser.finish().display
}

export type AlignmentChunk = {
  chunk_seq: number
  content: string
  chunk_audio_offset_sec: number
  alignment: { segments: { text: string; start: number; end: number }[] } | null
}

/** 基于 TTS 服务端的时间戳快照，建立音频播放时间与字幕/表情指令的时间轴映射。 */
export class AlignmentTimeline {
  private text = ''
  private cues: PresentationCue[] = []
  private subtitles: PresentationSubtitle[] = []
  private chunks = new Map<number, AlignmentChunk>()
  private consumedOffset = -1
  private position = 0

  append(text: string, cues: PresentationCue[], subtitles: PresentationSubtitle[] = []): void {
    this.text += text; this.cues.push(...cues); this.subtitles.push(...subtitles)
  }

  update(chunk: AlignmentChunk): void {
    if (!Number.isInteger(chunk.chunk_seq) || chunk.chunk_seq < 0 || !Number.isFinite(chunk.chunk_audio_offset_sec) || chunk.chunk_audio_offset_sec < 0 || typeof chunk.content !== 'string') return
    if (chunk.alignment && Array.isArray(chunk.alignment.segments)) this.chunks.set(chunk.chunk_seq, chunk)
  }

  /** 获取给定音频播放时间点所到达的口播文本最大字符偏移。 */
  private reached(seconds: number): number {
    this.position = Math.max(this.position, seconds)
    let cursor = 0
    let reached = -1
    for (const chunk of [...this.chunks.values()].sort((a, b) => a.chunk_seq - b.chunk_seq)) {
      // 本地文本不含语音标签；回传内容可能原样带着它们，原文匹配不上时再去掉标签重试。
      let content = chunk.content
      let start = this.text.indexOf(content, cursor)
      if (start < 0) { content = content.replace(VOICE_TAGS, ''); start = content ? this.text.indexOf(content, cursor) : -1 }
      if (start < 0) continue // 服务端文本规整化差异导致无法匹配时跳过，避免推导错误偏移。
      cursor = start + content.length
      let segmentCursor = 0
      for (const segment of chunk.alignment?.segments || []) {
        if (typeof segment.text !== 'string' || !segment.text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) continue
        let segmentText = segment.text
        let segmentAt = content.indexOf(segmentText, segmentCursor)
        if (segmentAt < 0) { segmentText = segmentText.replace(VOICE_TAGS, ''); segmentAt = segmentText ? content.indexOf(segmentText, segmentCursor) : -1 }
        if (segmentAt < 0) continue
        segmentCursor = segmentAt + segmentText.length
        if (chunk.chunk_audio_offset_sec + segment.start <= this.position) reached = Math.max(reached, start + segmentAt)
      }
    }
    return reached
  }

  take(seconds: number): Emotion | null {
    const reached = this.reached(seconds)
    let latest: PresentationCue | undefined
    for (const cue of this.cues) {
      if (cue.offset > this.consumedOffset && cue.offset <= reached && (!latest || cue.offset >= latest.offset)) latest = cue
    }
    if (!latest) return null
    this.consumedOffset = latest.offset
    return latest.emotion
  }

  /** 获取给定播放时间点所对应的当前字幕，未开始前返回 null。 */
  subtitleAt(seconds: number): string | null {
    const reached = this.reached(seconds)
    let latest: PresentationSubtitle | undefined
    for (const subtitle of this.subtitles) if (subtitle.offset <= reached && (!latest || subtitle.offset >= latest.offset)) latest = subtitle
    return latest ? latest.text : null
  }
}
