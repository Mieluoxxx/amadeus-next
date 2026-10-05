import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { systemClock, type Clock } from './clock.ts'

type Json = Record<string, unknown>

export type SpeechBridgeOptions = {
  platform: NodeJS.Platform
  /** 已构建的 helper 路径；未构建时为空字符串。 */
  locateHelper(): string
  spawnHelper(file: string): ChildProcess
  pauseMs: number
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>
}

export function systemSpeechOptions(moduleDir: string): SpeechBridgeOptions {
  return {
    platform: process.platform,
    locateHelper: () => [
      process.env.AMADEUS_SPEECH_HELPER || '',
      path.join(moduleDir, '../bin/AmadeusSpeechRecognizer'),
      path.join(process.resourcesPath || '', 'AmadeusSpeechRecognizer'),
    ].find(candidate => candidate && existsSync(candidate)) || '',
    spawnHelper: file => spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'] }),
    pauseMs: Math.min(10000, Math.max(500, Number(process.env.AMADEUS_SPEECH_PAUSE_MS) || 1500)),
    clock: systemClock,
  }
}

export class SpeechBridge {
  private process: ChildProcess | null = null
  private buffer = ''
  private recognitionId = 0
  private listening = false
  private finishing = false
  private manualResult = false
  private transcript = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly emit: (method: string, params: Json) => void
  private readonly options: SpeechBridgeOptions

  constructor(emit: (method: string, params: Json) => void, options: SpeechBridgeOptions) {
    this.emit = emit
    this.options = options
  }

  start(locale: string): { ok: boolean; error?: string } {
    if (this.listening) return { ok: true }
    if (this.options.platform !== 'darwin') return { ok: false, error: 'Apple Speech is only available on macOS' }
    if (!this.process) {
      const helper = this.options.locateHelper()
      if (!helper) {
        const error = 'Apple Speech helper is not built; run npm run build on macOS'
        this.emit('asr.status', { status: 'error', error })
        return { ok: false, error }
      }
      const child = this.options.spawnHelper(helper)
      this.process = child
      child.stdout?.on('data', chunk => { if (this.process === child) this.read(chunk.toString('utf8')) })
      child.on('exit', () => {
        if (this.process !== child) return
        const unexpected = this.listening
        this.process = null
        this.buffer = ''
        this.clearRecognition()
        this.emit('asr.status', unexpected ? { status: 'error', error: 'Apple Speech helper exited before recognition completed' } : { status: 'idle' })
      })
      child.on('error', () => {
        if (this.process !== child) return
        this.process = null
        this.clearRecognition()
        this.emit('asr.status', { status: 'error', error: 'Apple Speech helper could not start' })
      })
    }
    this.listening = true
    this.write({ command: 'start', locale: locale || 'zh-CN', recognition_id: ++this.recognitionId })
    return { ok: true }
  }

  stop(): { ok: boolean } {
    this.clearRecognition()
    this.recognitionId++
    this.write({ command: 'stop' })
    return { ok: true }
  }

  finish(manual = false): { ok: boolean } {
    if (!this.listening) return { ok: true }
    this.manualResult ||= manual
    if (this.finishing) return { ok: true }
    this.finishing = true
    this.options.clock.clearTimeout(this.timer)
    this.timer = this.options.clock.setTimeout(() => {
      this.stop()
      this.emit('asr.status', { status: 'error', error: 'Apple Speech timed out waiting for the final transcript; please retry' })
    }, 5000)
    this.write({ command: 'finish' })
    return { ok: true }
  }

  dispose(): void {
    const previous = this.process
    this.process = null
    this.clearRecognition()
    this.buffer = ''
    this.recognitionId++
    previous?.kill()
  }

  private clearRecognition(): void {
    this.options.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.listening = false
    this.finishing = false
    this.manualResult = false
    this.transcript = ''
  }

  private write(value: Json): void {
    if (this.process?.stdin?.writable) this.process.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private read(value: string): void {
    this.buffer += value
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line) as Json
          if (message.recognition_id !== this.recognitionId) { newline = this.buffer.indexOf('\n'); continue }
          if (message.type === 'error' || (message.type === 'status' && message.status === 'idle')) this.clearRecognition()
          if (message.type === 'status' && message.status === 'listening' && this.listening && !this.finishing && !this.transcript) {
            this.options.clock.clearTimeout(this.timer)
            this.timer = this.options.clock.setTimeout(() => {
              this.stop()
              this.emit('asr.status', { status: 'error', error: 'No transcription received within 30 seconds; check the microphone input and Apple Speech availability' })
            }, 30000)
          }
          if (message.type === 'recognized' && this.listening) {
            const text = String(message.text || '').trim()
            if (message.is_final === true) {
              if (this.manualResult) message.source = 'manual'
              this.clearRecognition()
            } else if (!this.finishing && text && text !== this.transcript) {
              this.transcript = text
              this.options.clock.clearTimeout(this.timer)
              // 识别文本在停顿阈值内无增量时判定为断句边界，触发自动收尾。
              this.timer = this.options.clock.setTimeout(() => this.finish(), this.options.pauseMs)
            }
            if (text) this.emit('asr.recognized', message)
            else if (message.is_final === true) this.emit('asr.status', { status: 'idle', reason: 'no-speech' })
          } else if (message.type === 'status') this.emit('asr.status', message)
          else if (message.type === 'error') {
            const noSpeech = (message.domain === 'kAFAssistantErrorDomain' && message.code === 1110)
              || (message.domain === undefined && message.code === undefined && message.error === 'No speech detected')
            this.emit('asr.status', noSpeech ? { status: 'idle', reason: 'no-speech' } : { status: 'error', error: message.error })
          }
        } catch {
          // 忽略损坏的单行输出，防止个别异常格式数据中断整个识别事件流。
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }
}
