import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { decode, encode } from '@msgpack/msgpack'
import type { VoiceEvent, TurnKey, FishDiagnostic } from '../shared/voice.ts'
import type { AlignmentChunk } from '../shared/presentation.ts'
import { fishFailure, fishHttpFailure, fishNetworkFailure, fishCloseFailure, fishServerDetail, type FishFailure } from './fishErrors.ts'

type Config = { FISH_API_KEY?: unknown; FISH_API_MODEL?: unknown; FISH_VOICE_ID?: unknown; network_proxy?: unknown }
export class FishTts {
  private socket: WebSocket | null = null
  private queue: string[] = []
  private ended = false
  private timeout: ReturnType<typeof setTimeout> | null = null
  private failure: ((failure: FishFailure) => void) | null = null
  private phase: FishDiagnostic['phase'] = 'handshake'
  private receivedAudio = false
  private config: () => Config
  private emit: (event: VoiceEvent) => void
  private connect: (url: string, options: WebSocket.ClientOptions) => WebSocket
  private proxy: { url: string; agent: HttpsProxyAgent<string> } | null = null

  constructor(config: () => Config, emit: (event: VoiceEvent) => void, connect = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options)) {
    this.config = config; this.emit = emit; this.connect = connect
  }
  get configured(): boolean { const key = this.config().FISH_API_KEY; return typeof key === 'string' && !!key.trim() }

  // 经由代理 Agent 建立 CONNECT 隧道，保证 WebSocket 正确走用户代理，并复用 Agent 避免闲置套接字泄漏。
  private proxyAgent(proxy: string): HttpsProxyAgent<string> | undefined {
    if (!proxy) return undefined
    if (this.proxy?.url !== proxy) {
      this.proxy?.agent.destroy()
      this.proxy = { url: proxy, agent: new HttpsProxyAgent(proxy) }
    }
    return this.proxy.agent
  }

  start(key: TurnKey): void {
    key = { sessionId: key.sessionId, turnId: key.turnId, generation: key.generation }
    this.abort()
    const config = { ...this.config() }
    const fail = (failure: FishFailure) => {
      if (this.failure !== fail) return
      this.abort()
      this.emit({ ...key, type: 'error', ...failure })
    }
    this.failure = fail
    if ([config.FISH_API_KEY, config.FISH_API_MODEL, config.FISH_VOICE_ID, config.network_proxy].some(value => value != null && typeof value !== 'string')) {
      fail(fishFailure('invalid_configuration', 'configuration')); return
    }
    const apiKey = String(config.FISH_API_KEY || '').trim()
    const model = String(config.FISH_API_MODEL || 's2.1-pro-free').trim()
    if (!apiKey) { fail(fishFailure('missing_key', 'configuration')); return }
    if (/[\r\n]/.test(apiKey) || /[\r\n]/.test(model)) { fail(fishFailure('invalid_header', 'configuration')); return }
    this.phase = 'handshake'
    let socket: WebSocket
    try {
      const agent = this.proxyAgent(String(config.network_proxy || '').trim())
      socket = this.connect('wss://api.fish.audio/v1/tts/live/with-timestamp', {
        headers: { Authorization: `Bearer ${apiKey}`, model }, handshakeTimeout: 15000, ...(agent ? { agent } : {}),
      })
    } catch (error) {
      const failure = fishNetworkFailure(error, 'handshake')
      fail(failure.diagnostic.code === 'network_unknown'
        ? fishFailure('connection_setup', 'configuration', { networkCode: failure.diagnostic.networkCode }) : failure)
      return
    }
    this.socket = socket
    socket.once('open', () => {
      if (this.failure !== fail) { socket.close(); return }
      this.phase = 'synthesis'
      if (!this.send({ event: 'start', request: {
        text: '', format: 'pcm', sample_rate: 24000, latency: 'balanced', chunk_length: 100, min_chunk_length: 100,
        ...(config.FISH_VOICE_ID ? { reference_id: String(config.FISH_VOICE_ID) } : {}),
      } })) return
      for (const text of this.queue.splice(0)) if (!this.send({ event: 'text', text })) return
      if (this.ended) this.sendStop()
    })
    socket.on('message', raw => {
      if (this.failure !== fail) return
      let value: unknown
      try {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
        value = decode(bytes)
      } catch { fail(fishFailure('decode_failed', this.phase)); return }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('event' in value) || typeof value.event !== 'string' || !value.event) {
        fail(fishFailure('invalid_event', this.phase)); return
      }
      const message = value as Record<string, unknown>
      if (message.event === 'audio') {
        if (!(message.audio instanceof Uint8Array)) { fail(fishFailure('invalid_audio', this.phase, { event: 'audio' })); return }
        this.receivedAudio ||= message.audio.length > 0
        const alignment = Number.isInteger(message.chunk_seq) ? {
          chunk_seq: message.chunk_seq, content: message.content, alignment: message.alignment,
          chunk_audio_offset_sec: message.chunk_audio_offset_sec,
        } as AlignmentChunk : null
        this.emit({ ...key, type: 'audio', pcm: message.audio, alignment })
        if (this.ended && this.failure === fail) this.armCompletionTimeout()
      } else if (message.event === 'error' || (message.event === 'finish' && message.reason === 'error')) {
        fail(fishFailure('service_error', this.phase, { event: message.event, detail: fishServerDetail(message.message, apiKey) }))
      } else if (message.event === 'finish') {
        if (message.reason !== 'stop') { fail(fishFailure('invalid_finish', this.phase, { event: 'finish' })); return }
        this.abort()
        this.emit({ ...key, type: 'input-ended' })
      }
      // 忽略未识别事件，保持与上游服务端协议演进的向前兼容。
    })
    socket.on('unexpected-response', (_request, response) => {
      // 错误日志中排空响应体与请求头，防止包含的认证凭据泄露。
      response.resume()
      fail(fishHttpFailure(response.statusCode, response.headers['retry-after']))
    })
    socket.on('error', error => {
      fail(fishNetworkFailure(error, this.phase))
    })
    socket.on('close', (code, reason) => fail(fishCloseFailure(code, this.phase, fishServerDetail(reason?.toString('utf8'), apiKey))))
  }
  push(text: string): void {
    if (!text || !this.socket || this.ended) return
    // 保持长连接开启以容忍模型推理或工具调用的间歇停顿。
    if (this.socket.readyState === WebSocket.OPEN) this.send({ event: 'text', text })
    else if (this.socket.readyState === WebSocket.CONNECTING) this.queue.push(text)
  }
  finish(): void {
    if (!this.socket || this.ended) return
    this.ended = true
    if (this.socket.readyState === WebSocket.OPEN) this.sendStop()
  }
  abort(): void {
    const socket = this.socket
    this.socket = null
    this.failure = null
    this.queue = []
    this.ended = false
    this.receivedAudio = false
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    if (socket?.readyState === WebSocket.CONNECTING) socket.terminate()
    else socket?.close()
  }
  private send(message: { event: 'start' | 'text' | 'stop'; [key: string]: unknown }): boolean {
    const socket = this.socket, fail = this.failure, phase = this.phase
    if (!socket || !fail) return false
    const reject = (error: unknown) => {
      const { networkCode } = fishNetworkFailure(error, phase).diagnostic
      fail(fishFailure('send_failed', phase, { event: message.event, ...(networkCode ? { networkCode } : {}) }))
    }
    try {
      socket.send(encode(message), error => { if (error) reject(error) })
      return this.socket === socket
    } catch (error) { reject(error); return false }
  }
  private sendStop(): void {
    this.phase = 'completion'
    if (this.send({ event: 'stop' })) this.armCompletionTimeout()
  }
  private armCompletionTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout)
    const fail = this.failure
    this.timeout = setTimeout(() => fail?.(fishFailure(this.receivedAudio ? 'completion_timeout' : 'first_audio_timeout', 'completion')), 30000)
  }
}
