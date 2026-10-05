import { normalizeEmotion, type Emotion } from './character.ts'

type PresentationCue = { offset: number; emotion: Emotion }
/** 字幕在口播文本中的字符偏移，用于音频时间戳同步对齐。 */
type PresentationSubtitle = { offset: number; text: string }
/** 拆分口播文本（TTS 朗读）、界面显示文本与逐句对齐字幕，支持双语显示。 */
export type PresentedText = { text: string; cues: PresentationCue[]; subtitles: PresentationSubtitle[]; display: string }

const BLOCK_TAGS = ['<zh>', '</zh>', '<jp>', '</jp>']

/** 流式双语分词器：隔离中文字幕与日文口播内容，并维持跨分片代码块状态。 */
export class PresentationText {
  private pending = ''
  private code = ''
  private length = 0
  private mode: 'plain' | 'zh' | 'jp' = 'plain'
  private zh = ''
  private zhSeen = false
  private jp = ''
  private jpStart = 0

  push(delta: string, final = false): PresentedText {
    this.pending += delta
    let text = ''
    let display = ''
    const cues: PresentationCue[] = []
    const subtitles: PresentationSubtitle[] = []
    const emit = (value: string) => {
      if (this.mode === 'zh') { this.zh += value; return }
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
              this.pending = this.pending.slice(end + 1)
              continue
            }
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
    return { text, cues, subtitles, display }
  }

  finish(): PresentedText { return this.push('', true) }
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
      const start = this.text.indexOf(chunk.content, cursor)
      if (start < 0) continue // 服务端文本规整化差异导致无法匹配时跳过，避免推导错误偏移。
      cursor = start + chunk.content.length
      let segmentCursor = 0
      for (const segment of chunk.alignment?.segments || []) {
        if (typeof segment.text !== 'string' || !segment.text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) continue
        const segmentAt = chunk.content.indexOf(segment.text, segmentCursor)
        if (segmentAt < 0) continue
        segmentCursor = segmentAt + segment.text.length
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
