import type { Emotion } from '../../shared/character.ts'
import type { DirectedLine, DirectionRequest } from '../../shared/direction.ts'

/** 配好的一句；`jp` 缺失表示导演没配出来，由调用方降级。 */
export type Spoken = { zh: string; jp?: string; emotion?: Emotion; voice?: string }
type Line = Spoken & { id: number }
type Batch = { lines: Line[]; done: boolean }

// 两批同时在跑就够了：一批在播，一批在配；再多只是更早地花钱，开口不会更快。
const MAX_IN_FLIGHT = 2
const BATCH_LINES = 3
const BATCH_CHARS = 60
const MAX_BATCH_LINES = 6
const CONTEXT_LINES = 4

export type DirectorOptions = {
  direct(request: DirectionRequest): Promise<DirectedLine[]>
  /** 按台词顺序放行，已经配好的批次也要等前面的批次。 */
  release(lines: Spoken[]): void
  /** 主模型写完、所有台词都已放行。 */
  drained(): void
  heard?: string
  report?(error: unknown): void
}

/**
 * 一个回合的配音调度。没有请求在跑时来一句送一句，第一句因此最快开口；
 * 有请求在跑时攒成一批，主模型写得比配音快，批次自然变大，请求数跟着变少。
 */
export class VoiceDirector {
  private readonly options: DirectorOptions
  private readonly lines: Line[] = []
  private queue: Line[] = []
  private batches: Batch[] = []
  private inFlight = 0
  private nextId = 1
  private paused = false
  private ended = false
  private stopped = false
  private settled = false
  private reported = false

  constructor(options: DirectorOptions) { this.options = options }

  push(zh: string): void {
    if (this.stopped || this.ended) return
    const line: Line = { id: this.nextId++, zh }
    this.lines.push(line)
    this.queue.push(line)
    this.paused = false
    this.pump()
  }

  /** 主模型停下来了（调工具），手头的不再等凑批。 */
  pause(): void {
    this.paused = true
    this.pump()
  }

  finish(): void {
    this.ended = true
    this.pump()
    this.settle()
  }

  abort(): void {
    this.stopped = true
    this.queue = []
    this.batches = []
  }

  private ready(): boolean {
    if (!this.queue.length || this.inFlight >= MAX_IN_FLIGHT) return false
    if (this.inFlight === 0 || this.paused || this.ended) return true
    return this.queue.length >= BATCH_LINES || this.queue.reduce((sum, line) => sum + line.zh.length, 0) >= BATCH_CHARS
  }

  private pump(): void {
    while (!this.stopped && this.ready()) this.dispatch(this.queue.splice(0, MAX_BATCH_LINES))
  }

  private dispatch(lines: Line[]): void {
    const batch: Batch = { lines, done: false }
    this.batches.push(batch)
    this.inFlight++
    const first = lines[0].id
    const context = this.lines.filter(line => line.id < first).slice(-CONTEXT_LINES).map(line => ({ zh: line.zh, ...(line.jp ? { jp: line.jp } : {}) }))
    const request: DirectionRequest = { lines: lines.map(({ id, zh }) => ({ id, zh })), context, ...(this.options.heard ? { heard: this.options.heard } : {}) }
    let pending: Promise<DirectedLine[]>
    try { pending = this.options.direct(request) } catch (error) { pending = Promise.reject(error) }
    pending.then(result => {
      for (const directed of result) {
        const line = lines.find(each => each.id === directed.id)
        if (!line) continue
        line.jp = directed.jp
        if (directed.emotion) line.emotion = directed.emotion
        if (directed.voice) line.voice = directed.voice
      }
    }, error => {
      // 一个回合只报一次：导演挂了时每批都会失败，刷屏没有意义。
      if (!this.reported) { this.reported = true; this.options.report?.(error) }
    }).then(() => {
      if (this.stopped) return
      batch.done = true
      this.inFlight--
      this.release()
      this.pump()
      this.settle()
    })
  }

  private release(): void {
    while (this.batches[0]?.done) {
      const batch = this.batches.shift()!
      this.options.release(batch.lines.map(({ id: _id, ...spoken }) => spoken))
    }
  }

  private settle(): void {
    if (this.settled || this.stopped || !this.ended || this.queue.length || this.inFlight || this.batches.length) return
    this.settled = true
    this.options.drained()
  }
}
