declare const sampleRate: number
declare const currentTime: number
declare class AudioWorkletProcessor { port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

/**
 * Playback is held until this much audio is queued, and held again after starving.
 * Fish delivers one chunk at a time, so playing whatever has arrived turns every
 * gap between chunks into audible silence.
 */
// ponytail: fixed 400ms lead; raise it if stutter persists, accepting a later start.
const LEAD_FRAMES = Math.round(sampleRate * 0.4)

/** One queue and one consumption clock, including silence caused by starvation. */
class AmadeusPcmProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = []
  private head = 0
  private offset = 0
  private consumed = 0
  private buffered = 0
  private primed = false
  private generation = -1
  private inputEnded = false
  private state = 'idle'
  private meterFrames = 0
  private energy = 0

  constructor() {
    super()
    this.port.onmessage = event => {
      const message = event.data
      if (message.type === 'reset') {
        this.generation = message.generation
        this.queue = []; this.head = 0; this.offset = 0; this.consumed = 0; this.buffered = 0
        this.inputEnded = false; this.state = 'idle'; this.meterFrames = 0; this.energy = 0
        this.primed = false
      } else if (message.generation === this.generation) {
        if (message.type === 'pcm' && message.buffer instanceof ArrayBuffer && !this.inputEnded && this.state !== 'ended' && this.state !== 'error') {
          const samples = new Float32Array(message.buffer)
          // ponytail: bounded in-memory PCM queue; flow control if >120s look-ahead is ever needed.
          if (this.buffered + samples.length > sampleRate * 120) {
            this.queue = []; this.head = 0; this.buffered = 0; this.state = 'error'
            this.port.postMessage({ type: 'error', generation: this.generation, error: 'Audio queue exceeded two minutes' })
            return
          }
          if (samples.length) { this.queue.push(samples); this.buffered += samples.length }
        } else if (message.type === 'end') this.inputEnded = true
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0]
    if (!output) return true
    output.fill(0)
    let written = 0
    // The lead is filled once, then playback drains continuously; a starved queue drops it again.
    if (this.primed || this.inputEnded || this.buffered >= LEAD_FRAMES) {
      while (written < output.length && this.head < this.queue.length) {
        const current = this.queue[this.head]
        const count = Math.min(output.length - written, current.length - this.offset)
        output.set(current.subarray(this.offset, this.offset + count), written)
        written += count; this.offset += count
        if (this.offset === current.length) { this.head++; this.offset = 0 }
      }
    }
    this.primed = written > 0
    if (this.head > 32) { this.queue.splice(0, this.head); this.head = 0 }
    this.consumed += written
    this.buffered -= written
    for (let i = 0; i < output.length; i++) this.energy += output[i] * output[i]
    this.meterFrames += output.length
    const state = this.inputEnded && !this.buffered ? 'ended' : written ? 'playing' : this.consumed ? 'buffering' : 'idle'
    if (this.state !== 'error' && (state !== this.state || this.meterFrames >= sampleRate / 30)) {
      this.state = state
      this.port.postMessage({ type: state, generation: this.generation, seconds: this.consumed / sampleRate, rms: written ? Math.sqrt(this.energy / this.meterFrames) : 0, contextTime: currentTime + output.length / sampleRate })
      this.energy = 0; this.meterFrames = 0
    }
    return true
  }
}

registerProcessor('amadeus-pcm', AmadeusPcmProcessor)
export {}
