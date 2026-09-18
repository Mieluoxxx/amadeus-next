import { normalizeEmotion, type Emotion } from './character.ts'

export type PresentationCue = { offset: number; emotion: Emotion }
export type PresentedText = { text: string; cues: PresentationCue[] }

/** Incremental control-tag lexer. Backtick/tilde code delimiters survive chunk boundaries. */
export class PresentationText {
  private pending = ''
  private code = ''
  private length = 0

  push(delta: string, final = false): PresentedText {
    this.pending += delta
    let text = ''
    const cues: PresentationCue[] = []
    while (this.pending) {
      const first = this.pending[0]
      if (!this.code && first === '\\') {
        if (this.pending.length === 1 && !final) break
        text += this.pending.slice(0, 2)
        this.pending = this.pending.slice(2)
        continue
      }
      if (first === '`' || first === '~') {
        const run = this.pending.match(/^(`+|~+)/)![0]
        if (run.length === this.pending.length && !final) break
        if (!this.code && (first === '`' || run.length >= 3)) this.code = run
        else if (this.code === run) this.code = ''
        text += run
        this.pending = this.pending.slice(run.length)
        continue
      }
      if (!this.code && first === '[') {
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
      text += first
      this.pending = this.pending.slice(1)
    }
    this.length += text.length
    return { text, cues }
  }

  finish(): PresentedText { return this.push('', true) }
}

export type AlignmentChunk = {
  chunk_seq: number
  content: string
  chunk_audio_offset_sec: number
  alignment: { segments: { text: string; start: number; end: number }[] } | null
}

/** Fish snapshots describe text, not ownership of the accompanying PCM bytes. */
export class AlignmentTimeline {
  private text = ''
  private cues: PresentationCue[] = []
  private chunks = new Map<number, AlignmentChunk>()
  private consumedOffset = -1
  private position = 0

  append(text: string, cues: PresentationCue[]): void { this.text += text; this.cues.push(...cues) }

  update(chunk: AlignmentChunk): void {
    if (!Number.isInteger(chunk.chunk_seq) || chunk.chunk_seq < 0 || !Number.isFinite(chunk.chunk_audio_offset_sec) || chunk.chunk_audio_offset_sec < 0 || typeof chunk.content !== 'string') return
    if (chunk.alignment && Array.isArray(chunk.alignment.segments)) this.chunks.set(chunk.chunk_seq, chunk)
  }

  take(seconds: number): Emotion | null {
    // ponytail: scans one reply's alignment; index cue times if long narrations become a measured hotspot.
    this.position = Math.max(this.position, seconds)
    let cursor = 0
    let latest: PresentationCue | undefined
    for (const chunk of [...this.chunks.values()].sort((a, b) => a.chunk_seq - b.chunk_seq)) {
      const start = this.text.indexOf(chunk.content, cursor)
      if (start < 0) continue // Do not guess offsets when the service normalizes text differently.
      cursor = start + chunk.content.length
      let segmentCursor = 0
      for (const segment of chunk.alignment?.segments || []) {
        if (typeof segment.text !== 'string' || !segment.text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start) continue
        const segmentAt = chunk.content.indexOf(segment.text, segmentCursor)
        if (segmentAt < 0) continue
        segmentCursor = segmentAt + segment.text.length
        const time = chunk.chunk_audio_offset_sec + segment.start
        if (time > this.position) continue
        for (const cue of this.cues) {
          if (cue.offset > this.consumedOffset && cue.offset <= start + segmentAt && (!latest || cue.offset >= latest.offset)) latest = cue
        }
      }
    }
    if (!latest) return null
    this.consumedOffset = latest.offset
    return latest.emotion
  }
}
