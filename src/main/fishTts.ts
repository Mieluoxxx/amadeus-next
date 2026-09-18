import WebSocket from 'ws'
import { decode, encode } from '@msgpack/msgpack'
import type { VoiceEvent, TurnKey } from '../shared/voice.ts'
import type { AlignmentChunk } from '../shared/presentation.ts'

type Config = { FISH_API_KEY?: unknown; FISH_API_MODEL?: unknown; FISH_VOICE_ID?: unknown }
export class FishTts {
  private socket: WebSocket | null = null
  private queue: string[] = []
  private ended = false
  private timeout: ReturnType<typeof setTimeout> | null = null
  private config: () => Config
  private emit: (event: VoiceEvent) => void
  private connect: (url: string, options: WebSocket.ClientOptions) => WebSocket

  constructor(config: () => Config, emit: (event: VoiceEvent) => void, connect = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options)) {
    this.config = config; this.emit = emit; this.connect = connect
  }
  get configured(): boolean { return !!String(this.config().FISH_API_KEY || '').trim() }

  start(key: TurnKey): void {
    key = { sessionId: key.sessionId, turnId: key.turnId, generation: key.generation }
    this.abort()
    if (!this.configured) return
    const config = this.config()
    const socket = this.connect('wss://api.fish.audio/v1/tts/live/with-timestamp', {
      headers: { Authorization: `Bearer ${String(config.FISH_API_KEY).trim()}`, model: String(config.FISH_API_MODEL || 's2-pro') },
      handshakeTimeout: 15000,
    })
    this.socket = socket
    const fail = (error: string) => {
      if (this.socket !== socket) return
      this.abort()
      this.emit({ ...key, type: 'error', error })
    }
    socket.once('open', () => {
      if (this.socket !== socket) { socket.close(); return }
      socket.send(encode({ event: 'start', request: {
        text: '', format: 'pcm', sample_rate: 24000, latency: 'balanced', chunk_length: 200, min_chunk_length: 50,
        ...(config.FISH_VOICE_ID ? { reference_id: String(config.FISH_VOICE_ID) } : {}),
      } }))
      for (const text of this.queue.splice(0)) socket.send(encode({ event: 'text', text }))
      if (this.ended) socket.send(encode({ event: 'stop' }))
    })
    socket.on('message', raw => {
      if (this.socket !== socket) return
      try {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
        const message = decode(bytes) as Record<string, any>
        if (message.event === 'audio') {
          if (!(message.audio instanceof Uint8Array)) throw new Error('Invalid Fish PCM payload')
          const alignment = Number.isInteger(message.chunk_seq) ? {
            chunk_seq: message.chunk_seq, content: message.content, alignment: message.alignment,
            chunk_audio_offset_sec: message.chunk_audio_offset_sec,
          } as AlignmentChunk : null
          this.emit({ ...key, type: 'audio', pcm: message.audio, alignment })
          if (this.ended) this.armTimeout(() => fail('Fish synthesis timed out'))
        } else if (message.event === 'finish') {
          if (message.reason === 'error') { fail(String(message.message || 'Fish synthesis failed')); return }
          this.abort()
          this.emit({ ...key, type: 'input-ended' })
        } else if (message.event === 'error') fail(String(message.message || 'Fish request failed'))
      } catch { fail('Invalid Fish streaming response') }
    })
    socket.on('error', () => fail('Fish connection failed'))
    socket.on('close', () => fail('Fish closed before completing synthesis'))
    this.armTimeout(() => fail('Fish connection or synthesis timed out'))
  }
  push(text: string): void {
    if (!text || !this.socket || this.ended) return
    // Long tool pauses are allowed before the input stream closes.
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(encode({ event: 'text', text }))
    else this.queue.push(text)
  }
  finish(): void {
    this.ended = true
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encode({ event: 'stop' }))
    const socket = this.socket
    if (socket) this.armTimeout(() => { socket.terminate() })
  }
  abort(): void {
    const socket = this.socket
    this.socket = null
    this.queue = []
    this.ended = false
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    if (socket?.readyState === WebSocket.CONNECTING) socket.terminate()
    else socket?.close()
  }
  private armTimeout(callback: () => void): void {
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = setTimeout(callback, 30000)
  }
}
