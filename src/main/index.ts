import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { SceneHost } from './sceneHost.ts'
import { FishTts } from './fishTts.ts'
import { PiHost } from './piHost.ts'
import { PresentationText } from '../shared/presentation.ts'
import { sameTurn, isTurnKey, type TurnKey, type VoiceEvent, type PlaybackEvent, type Calibration } from '../shared/voice.ts'

type Json = Record<string, unknown>
type StoredMessage = { role: 'user' | 'assistant'; text: string; turn_id?: string }
type StoredSession = { id: string; title: string; messages: StoredMessage[] }

const DEV_SERVER_URL = process.env.AMADEUS_NEXT_DEV_URL || 'http://127.0.0.1:5199'
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

function projectRoot(): string {
  if (process.env.AMADEUS_NEXT_PROJECT_ROOT) return process.env.AMADEUS_NEXT_PROJECT_ROOT
  const bundledAssets = path.join(process.resourcesPath || '', 'amadeus-assets')
  if (existsSync(path.join(bundledAssets, 'render/web/wallpaper_engine.html'))) return bundledAssets
  return path.resolve(MODULE_DIR, '../../resources')
}

function jsonFile(file: string, fallback: Json): Json {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch {
    return fallback
  }
}

// 与 Electron userData 分开：设置文件放在用户可见、可手改的 XDG 位置；API key 仍走 safeStorage 加密。
function settingsPath(): string {
  return path.join(process.env.AMADEUS_CONFIG_DIR || path.join(os.homedir(), '.config', 'amadeus'), 'settings.yaml')
}

function readYaml(file: string): Json {
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : {}
  } catch {
    return {}
  }
}

function writeYaml(file: string, data: Json): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, stringifyYaml(data), { encoding: 'utf8', mode: 0o600 })
}

class SessionStore {
  private readonly file: string
  sessions: StoredSession[] = []
  currentId = ''

  constructor(file: string) {
    this.file = file
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(value)) this.sessions = value as StoredSession[]
      else if (Array.isArray(value?.sessions)) {
        this.sessions = value.sessions
        this.currentId = typeof value.currentId === 'string' ? value.currentId : ''
      }
    } catch {
      this.sessions = []
    }
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ currentId: this.currentId, sessions: this.sessions }, null, 2), 'utf8')
  }
}

class SpeechBridge {
  private process: ChildProcess | null = null
  private buffer = ''
  private recognitionId = 0
  private listening = false
  private readonly emit: (method: string, params: Json) => void

  constructor(emit: (method: string, params: Json) => void) {
    this.emit = emit
  }

  start(locale: string): { ok: boolean; error?: string } {
    if (this.listening) return { ok: true }
    if (process.platform !== 'darwin') return { ok: false, error: 'Apple Speech is only available on macOS' }
    if (!this.process) {
      const helper = [
        process.env.AMADEUS_SPEECH_HELPER || '',
        path.join(MODULE_DIR, '../bin/AmadeusSpeechRecognizer'),
        path.join(process.resourcesPath || '', 'AmadeusSpeechRecognizer'),
      ].find(candidate => candidate && existsSync(candidate)) || ''
      if (!existsSync(helper)) {
        const error = 'Apple Speech helper is not built; run npm run build on macOS'
        this.emit('asr.status', { status: 'error', error })
        return { ok: false, error }
      }
      const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] })
      this.process = child
      child.stdout?.on('data', chunk => { if (this.process === child) this.read(chunk.toString('utf8')) })
      child.on('exit', () => {
        if (this.process !== child) return
        this.process = null
        this.listening = false
        this.emit('asr.status', { status: 'idle' })
      })
      child.on('error', () => {
        if (this.process !== child) return
        this.process = null
        this.listening = false
        this.emit('asr.status', { status: 'error', error: 'Apple Speech helper could not start' })
      })
    }
    this.listening = true
    this.write({ command: 'start', locale: locale || 'zh-CN', recognition_id: ++this.recognitionId })
    return { ok: true }
  }

  stop(): { ok: boolean } {
    this.listening = false
    this.recognitionId++
    this.write({ command: 'stop' })
    return { ok: true }
  }

  dispose(): void {
    const previous = this.process
    this.process = null
    this.listening = false
    this.buffer = ''
    this.recognitionId++
    previous?.kill()
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
          if (message.type === 'error' || (message.type === 'status' && message.status === 'idle')) this.listening = false
          if (message.type === 'recognized') this.emit('asr.recognized', message)
          else if (message.type === 'status') this.emit('asr.status', message)
          else if (message.type === 'error') this.emit('asr.status', { status: 'error', error: message.error })
        } catch {
          // A malformed helper line is ignored; the next valid event remains usable.
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }
}


class AppRuntime {
  private readonly root: string
  private readonly scene: SceneHost
  private readonly store: SessionStore
  private readonly settingsFile: string

  /** Adopt the pre-rename `salieri-next-*` file when the renamed one is absent (never overwrites). */
  private adoptLegacyFile(file: string): string {
    const legacy = path.join(path.dirname(file), path.basename(file).replace(/^amadeus-next-/, 'salieri-next-'))
    try {
      if (!existsSync(file) && existsSync(legacy)) renameSync(legacy, file)
    } catch {
      // 迁移失败时退回全新存储，不阻断启动
    }
    return file
  }
  private readonly pi = new PiHost(() => utilityProcess.fork(path.join(MODULE_DIR, 'pi-worker.js'), [], {
    cwd: process.cwd(),
    env: { ...process.env, ...this.piEnv(), AMADEUS_NEXT_PI_CWD: process.cwd(), AMADEUS_NEXT_PI_SESSIONS: path.join(app.getPath('userData'), 'pi-sessions') },
    serviceName: 'Amadeus Pi Runtime',
    stdio: 'ignore',
  }))
  private readonly windows = new Set<BrowserWindow>()
  private readonly config: Json = {
    llm_provider: 'pi',
    presentation_locale: 'zh-CN',
    chat_translation_subtitles_enabled: false,
    asr_backend: 'apple_speech',
    asr_language: 'zh-CN',
    tts_backend: 'fish_stream',
    tts_mode: 'stream',
    FISH_API_KEY: process.env.FISH_API_KEY || '',
    FISH_API_MODEL: process.env.FISH_API_MODEL || 's2-pro',
    FISH_VOICE_ID: process.env.FISH_VOICE_ID || '',
    mouth_gain: 8,
    mouth_silence_threshold: 0.08,
    voice_sync_offset_ms: 0,
    network_proxy: '',
  }
  private readonly speech: SpeechBridge
  private readonly tts: FishTts
  private currentSessionId = ''
  private generation = 0
  private activeTurn: (TurnKey & { piDone: boolean; drained: boolean; speech: boolean; text: string }) | null = null
  private listeningEnabled = false
  private sceneReady = false
  private sceneToken = ''
  private readonly reloadTargets = new Set<string>()
  private reloading = false
  private disposed = false
  private reloadState: Json = { status: 'ready', targets: [] }
  private sceneReload: { resolve: () => void; reject: (error: Error) => void } | null = null
  private lastActivityAt = Date.now()
  private idleActive = false

  constructor() {
    this.root = projectRoot()
    this.scene = new SceneHost(this.root, path.join(MODULE_DIR, '../scene'))
    this.store = new SessionStore(this.adoptLegacyFile(path.join(app.getPath('userData'), 'amadeus-next-sessions.json')))
    this.settingsFile = settingsPath()
    this.loadPersistedSettings()
    this.speech = new SpeechBridge((method, params) => this.onSpeech(method, params))
    this.tts = new FishTts(() => this.config, event => {
      if (!sameTurn(this.activeTurn, event)) return
      this.voice(event)
      if (event.type === 'error' && this.activeTurn) {
        this.activeTurn.drained = true
        this.activeTurn.speech = false
        this.emit('tts.error', { error: event.error, diagnostic: event.diagnostic, turn_id: event.turnId })
        this.resumeListening()
      }
    })
  }

  async init(): Promise<void> {
    await this.scene.start()
    this.watchConversationIdle()
    await this.pi.init()
    if (!this.store.sessions.length) {
      this.store.sessions.push({ id: randomUUID(), title: '新对话', messages: [] })
      this.store.save()
    }
    this.currentSessionId = this.store.sessions.some(session => session.id === this.store.currentId) ? this.store.currentId : this.store.sessions[0].id
  }

  attach(window: BrowserWindow): void {
    this.windows.add(window)
    window.on('closed', () => { this.windows.delete(window); this.sceneReady = false; this.listeningEnabled = false; this.cancelTurn(); this.speech.stop() })
    window.webContents.on('render-process-gone', () => { void this.request('scene.lost') })
  }

  async request(method: string, params: Json = {}): Promise<Json> {
    switch (method) {
      case 'window.focus':
        for (const window of this.windows) { window.show(); window.focus() }
        return { ok: true }
      case 'wallpaper.start':
        return { ok: true, status: 'ready', url: this.scene.url }
      case 'wallpaper.stop':
        return { ok: true }
      case 'system.get_config':
        return { values: this.configSnapshot() }
      case 'system.set_config':
        return this.setConfig(params.values && typeof params.values === 'object' ? params.values as Json : {})
      case 'desktop.settings.get':
        return this.desktopSettings()
      case 'desktop.settings.update':
        return this.updateDesktopSettings(params)
      case 'runtime.status':
        return this.reloadState
      case 'runtime.reload':
        return this.queueReload(params, false)
      case 'dev.reload':
        return process.env.AMADEUS_NEXT_DEV === '1' ? this.queueReload(params, true) : { ok: false, error: 'Development reload is disabled' }
      case 'pi.models':
      case 'pi.model.set':
        if (this.reloading || this.reloadTargets.size || (this.activeTurn && !this.activeTurn.piDone)) return { ok: false, error: 'Wait for the current reply or reload to finish' }
        if (method === 'pi.model.set' && typeof params.model !== 'string') return { ok: false, error: 'Invalid model' }
        try {
          return { ok: true, ...await this.pi.request(method === 'pi.models' ? 'models' : 'set-model', { sessionId: this.currentSessionId, model: params.model, thinkingLevel: params.thinkingLevel }) }
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      case 'provider.list':
        return { provider_availability: [{ provider_id: 'pi', configured: !this.pi.error, ready: !this.pi.error, registered: true, reason: this.pi.error || 'ready' }], provider_manifests: [{ provider_id: 'pi', display_name: 'Pi', runtime_kind: 'embedded' }] }
      case 'session.list':
        return this.sessionPayload()
      case 'session.create':
        return this.createSession(params)
      case 'session.load':
        return this.loadSession(String(params.session_id || ''))
      case 'session.open_context':
      case 'project.create':
        return { ok: false, error: 'Projects are not part of the native Pi first release' }
      case 'provider.activity.list':
      case 'work.list':
        return method === 'work.list' ? { ok: true, work: { surface: 'wallpaper.slice', revision: '0', items: [] } } : { runs: [] }
      case 'work.get':
        return { ok: true, item: null }
      case 'chat.translate':
        return { translation: '' }
      case 'chat.send':
        return this.sendChat(params)
      case 'chat.abort':
        return this.abortChat(params)
      case 'scene.ready':
        if (this.sceneReload && (!params.token || params.token === this.sceneToken)) return { ok: false, error: 'Stale scene handshake' }
        this.sceneToken = String(params.token || '')
        this.sceneReady = true
        // 新场景从零开始，不会再有状态翻转；当前的 idle 演出必须重发一次。
        this.emit('voice.event', { type: 'conversation-idle', active: this.idleActive })
        if (this.sceneReload) this.sceneReload.resolve()
        this.resumeListening()
        return { ok: true, key: this.activeTurn || this.idleKey(), text: this.activeTurn?.text || '', calibration: this.calibration() }
      case 'scene.lost':
        if (params.token && params.token !== this.sceneToken) return { ok: true }
        this.sceneReady = false
        if (!this.sceneReload) {
          this.listeningEnabled = false
          // Rendering can recover independently. Never replay or cancel model/tool work for a lost display.
          this.tts.abort()
          if (this.activeTurn) { this.activeTurn.speech = false; this.activeTurn.drained = true }
        }
        this.speech.stop()
        this.resumeListening()
        return { ok: true }
      case 'voice.playback':
        if (isTurnKey(params) && sameTurn(this.activeTurn, params)) this.onPlayback(params as PlaybackEvent)
        return { ok: true }
      case 'asr.start': {
        this.listeningEnabled = true
        if (this.reloading || this.reloadTargets.size) return { ok: true }
        if (this.activeTurn && (!this.activeTurn.piDone || !this.activeTurn.drained)) return { ok: true }
        const result = this.speech.start(String(this.config.asr_language || 'zh-CN'))
        if (!result.ok) this.listeningEnabled = false
        return result
      }
      case 'asr.stop':
        this.listeningEnabled = false
        this.voice({ ...(this.activeTurn || this.idleKey()), type: 'activity', activity: 'idle' })
        return this.speech.stop()
      case 'work.permission.resolve':
        return { ok: false, error: 'Native Pi permissions are handled by Pi' }
      default:
        return { ok: false, error: `unsupported_method:${method}` }
    }
  }

  dispose(): void {
    this.disposed = true
    this.reloadTargets.clear()
    this.sceneReload?.reject(new Error('Application closed'))
    this.speech.dispose()
    this.tts.abort()
    this.scene.close()
    this.pi.dispose()
  }

  private queueReload(params: Json, development: boolean): Json {
    const targets = params.targets ?? ['pi', 'scene']
    const allowed = ['pi', 'scene', 'speech', 'pi-worker', ...(development ? ['preload', 'main'] : [])]
    if (!Array.isArray(targets) || !targets.length || targets.some(target => typeof target !== 'string' || !allowed.includes(target))) {
      return { ok: false, error: 'Invalid reload target' }
    }
    for (const target of targets) this.reloadTargets.add(target)
    this.reportReload(this.reloading ? 'applying' : 'queued', [...this.reloadTargets])
    this.resumeListening()
    return { ok: true, ...this.reloadState }
  }

  private reportReload(status: string, targets: string[], error?: string): void {
    this.reloadState = { status, targets, ...(error ? { error } : {}) }
    this.emit('runtime.reload', this.reloadState)
  }

  private flushReload(): void {
    if (this.disposed || this.reloading || !this.reloadTargets.size || (this.activeTurn && (!this.activeTurn.piDone || !this.activeTurn.drained))) return
    const targets = [...this.reloadTargets]
    this.reloadTargets.clear()
    this.reloading = true
    this.speech.stop()
    this.reportReload('applying', targets)
    void (async () => {
      // Also wait for an explicitly cancelled Pi turn to finish its tool cleanup.
      if (!this.pi.error) await this.pi.request('checkpoint')
      if (targets.includes('main')) {
        this.dispose()
        app.exit(75) // The development launcher starts the freshly built main process.
        return
      }
      if (targets.includes('pi-worker') || (targets.includes('pi') && this.pi.error)) await this.pi.restart()
      else if (targets.includes('pi')) await this.pi.request('reload')
      if (targets.includes('speech')) this.speech.dispose()
      if (targets.includes('scene') || targets.includes('preload')) {
        this.scene.reload()
        if (this.windows.size) await this.reloadScene(targets.includes('preload'))
      }
      this.reportReload('ready', targets)
    })().catch(error => {
      this.reloadTargets.clear()
      this.reportReload('error', targets, error instanceof Error ? error.message : String(error))
    }).finally(() => {
      this.reloading = false
      this.resumeListening()
    })
  }

  private async reloadScene(preload: boolean): Promise<void> {
    this.sceneReady = false
    this.cancelTurn()
    let timer: ReturnType<typeof setTimeout>
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Scene reload timed out')), 20000)
        this.sceneReload = { resolve, reject }
        if (preload) {
          for (const window of this.windows) if (!window.isDestroyed()) window.webContents.reload()
        } else this.emit('scene.reload', {})
      })
    } finally {
      clearTimeout(timer!)
      this.sceneReload = null
    }
  }

  /** 回合结束（无语音的回合到 piDone 即结束，有语音的回合等播放排空）也算活动。 */
  private markActivity(): void {
    this.lastActivityAt = Date.now()
    this.publishIdle(false)
  }

  /** 空闲演出的单一状态源：只在翻转时广播。 */
  private publishIdle(idle: boolean): void {
    if (idle === this.idleActive) return
    this.idleActive = idle
    this.emit('voice.event', { type: 'conversation-idle', active: idle })
  }

  /** 距上次活动超过 30 秒且回合已结束时轮播 idle 静帧；回复进行中无论多久都不轮播，回合刚结束也要重新计时。 */
  private watchConversationIdle(): void {
    // 测试 VM 无 timers，直接跳过
    if (typeof setInterval !== 'function') return
    const idleAfterMs = 30_000
    setInterval(() => {
      const turn = this.activeTurn
      const running = !!turn && (!turn.piDone || !turn.drained)
      this.publishIdle(!running && Date.now() - this.lastActivityAt >= idleAfterMs)
    }, 1000)
  }

  private emit(method: string, params: Json): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) window.webContents.send('next.event', { method, params })
    }
  }

  private sessionPayload(session = this.currentSession()): Json {
    return {
      sessions: this.store.sessions.map(item => ({ id: item.id, title: item.title })),
      current_session_id: session?.id || '',
      session: session ? { id: session.id, title: session.title } : null,
      messages: session?.messages || [],
    }
  }

  private currentSession(): StoredSession | null {
    return this.store.sessions.find(item => item.id === this.currentSessionId) || null
  }

  private createSession(params: Json): Json {
    this.listeningEnabled = false
    this.speech.stop()
    const id = randomUUID()
    const title = String(params.title || '新对话')
    const session = { id, title, messages: [] }
    this.store.sessions.unshift(session)
    this.currentSessionId = id
    this.store.currentId = id
    this.cancelTurn()
    this.store.save()
    const payload = { ...this.sessionPayload(session), ok: true, client_request_id: String(params.client_request_id || ''), source: 'next' }
    this.emit('session.changed', payload)
    this.resumeListening()
    return payload
  }

  private loadSession(id: string): Json {
    const session = this.store.sessions.find(item => item.id === id)
    if (!session) return { ok: false, error: 'session not found' }
    this.currentSessionId = id
    this.store.currentId = id
    this.store.save()
    this.listeningEnabled = false
    this.speech.stop()
    this.cancelTurn()
    this.resumeListening()
    return { ...this.sessionPayload(session), ok: true, source: 'next' }
  }

  // Pi reads its proxy settings from the environment while its worker process
  // starts, which is also why the worker is replaced when the address changes
  // (see setConfig). `NODE_USE_ENV_PROXY` is what makes Node's fetch use the
  // variables at all; an empty address keeps the worker on direct connections.
  private piEnv(): Record<string, string> {
    const proxy = String(this.config.network_proxy || '').trim()
    return proxy ? { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}
  }

  private setConfig(values: Json): Json {
    for (const [key, min, max] of [['mouth_gain', 0, 32], ['mouth_silence_threshold', 0, 1], ['voice_sync_offset_ms', -1000, 1000]] as const) {
      if (!(key in values)) continue
      const value = values[key]
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) {
        return { ok: false, error: `Invalid ${key}: expected ${min} to ${max}` }
      }
      values[key] = Number(value)
    }
    if ('network_proxy' in values) {
      const proxy = String(values.network_proxy ?? '').trim()
      let parsed: URL | null = null
      try { parsed = new URL(proxy) } catch { parsed = null }
      // Only HTTP CONNECT proxies are usable: Pi's transport rejects SOCKS and
      // PAC URLs, and an empty value means "connect directly".
      if (proxy && (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname)) {
        return { ok: false, error: 'Invalid network_proxy: expected an http:// or https:// proxy URL' }
      }
      values.network_proxy = proxy
    }
    const previousLanguage = this.config.asr_language
    const previousProxy = this.config.network_proxy
    Object.assign(this.config, values)
    this.persistSettings()
    // The worker keeps the address it started with, so a changed address
    // replaces that one component at the next safe boundary. Speech, the scene
    // and the active reply are untouched.
    if (this.config.network_proxy !== previousProxy) this.queueReload({ targets: ['pi-worker'] }, false)
    if (this.listeningEnabled && this.config.asr_language !== previousLanguage) {
      this.speech.stop()
      this.resumeListening()
    }
    this.emit('system.config', { values: this.configSnapshot() })
    if (['mouth_gain', 'mouth_silence_threshold', 'voice_sync_offset_ms'].some(key => key in values)) {
      this.voice({ ...(this.activeTurn || this.idleKey()), type: 'calibration', calibration: this.calibration() })
    }
    return { ok: true, values: this.configSnapshot() }
  }

  private desktopSettings(): Json {
    const snapshot = this.configSnapshot()
    const values = Object.fromEntries(Object.entries(snapshot).flatMap(([key, value]) => {
      if (['FISH_API_KEY', 'FISH_VOICE_ID', 'voice_configuration', 'general_configuration', 'work_provider_configuration', 'asr_backends'].includes(key)) return []
      return [[key, String(value ?? '')]]
    }))
    const secrets = Object.fromEntries(['FISH_API_KEY', 'FISH_VOICE_ID'].map(key => [key, { configured: Boolean(this.config[key]), source: 'user', locked: false }]))
    return { values, sources: {}, locked: {}, secrets, encryptionAvailable: safeStorage.isEncryptionAvailable() }
  }

  private configSnapshot(): Json {
    const { FISH_API_KEY: _fishApiKey, ...publicConfig } = this.config
    return {
      ...publicConfig,
      work_provider_configuration: [],
      asr_backends: [{ id: 'apple_speech', label: 'Apple Speech', deployment: 'native' }],
      voice_configuration: [
        {
          id: 'asr_local',
          label: 'Apple Speech',
          active: true,
          configured: true,
          status: 'ready',
          status_ok: true,
          fields: [
            { key: 'asr_language', label: 'Recognition language', type: 'select', value: String(this.config.asr_language || 'zh-CN'), options: ['zh-CN', 'en-US'], editable: true, restart_required: false },
          ],
        },
        {
          id: 'speech_synthesis',
          label: 'Fish Audio realtime',
          active: true,
          configured: this.tts.configured,
          status: this.tts.configured ? 'ready' : 'needs_setup',
          status_ok: this.tts.configured,
          fields: [
            { key: 'FISH_API_KEY', label: 'Fish Audio API key', type: 'secret', editable: true, restart_required: false },
            { key: 'FISH_VOICE_ID', label: 'Fish voice ID', type: 'text', value: String(this.config.FISH_VOICE_ID || ''), editable: true, restart_required: false },
            { key: 'FISH_API_MODEL', label: 'Fish model', type: 'select', value: String(this.config.FISH_API_MODEL || 's2-pro'), options: ['s2.1-pro-free', 's2-pro', 's1'], editable: true, restart_required: false },
          ],
          advanced_fields: [
            { key: 'mouth_gain', label: 'Mouth gain', type: 'number', value: this.config.mouth_gain, min: 0, max: 32, step: 0.5, editable: true },
            { key: 'mouth_silence_threshold', label: 'Silence threshold', type: 'number', value: this.config.mouth_silence_threshold, min: 0, max: 1, step: 0.01, editable: true },
            { key: 'voice_sync_offset_ms', label: 'Voice sync offset (ms)', type: 'number', value: this.config.voice_sync_offset_ms, min: -1000, max: 1000, step: 10, editable: true },
          ],
        },
      ],
      general_configuration: [
        {
          id: 'network', label: 'Network', configured: true,
          fields: [
            { key: 'network_proxy', label: 'Network proxy', type: 'text', value: String(this.config.network_proxy || ''), editable: true },
          ],
        },
      ],
    }
  }

  private updateDesktopSettings(params: Json): Json {
    const values = params.values && typeof params.values === 'object' ? params.values as Json : {}
    const secrets = params.secrets && typeof params.secrets === 'object' ? params.secrets as Json : {}
    const result = this.setConfig({ ...values, ...secrets })
    if (!result.ok) return result
    return { ok: true, settings: this.desktopSettings() }
  }

  private loadPersistedSettings(): void {
    const stored = readYaml(this.settingsFile)
    for (const [key, value] of Object.entries(stored)) {
      if (key in this.config && key !== 'FISH_API_KEY') this.config[key] = value
    }
    if (safeStorage.isEncryptionAvailable() && typeof stored.FISH_API_KEY_ENCRYPTED === 'string') {
      try { this.config.FISH_API_KEY = safeStorage.decryptString(Buffer.from(stored.FISH_API_KEY_ENCRYPTED, 'base64')) } catch { /* keep environment value */ }
    }
  }

  private persistSettings(): void {
    const data: Json = Object.fromEntries(Object.entries(this.config).filter(([key]) => key !== 'FISH_API_KEY'))
    if (safeStorage.isEncryptionAvailable() && String(this.config.FISH_API_KEY || '')) {
      try { data.FISH_API_KEY_ENCRYPTED = safeStorage.encryptString(String(this.config.FISH_API_KEY)).toString('base64') } catch { /* keep the in-memory value */ }
    }
    writeYaml(this.settingsFile, data)
  }

  private sendChat(params: Json): Json {
    this.markActivity()
    if (this.reloading || this.reloadTargets.size) return { ok: false, error: 'Runtime reload pending; please retry after it completes' }
    const sessionId = String(params.session_id || this.currentSessionId)
    const session = this.store.sessions.find(item => item.id === sessionId)
    const text = String(params.text || '').trim()
    const turnId = String(params.turn_id || randomUUID())
    if (!session) return { ok: false, error: 'session not found' }
    if (!text) return { ok: false, error: 'message is empty' }
    this.cancelTurn()
    this.speech.stop()
    this.currentSessionId = sessionId
    this.store.currentId = sessionId
    session.messages.push({ role: 'user', text, turn_id: turnId })
    this.store.save()
    void this.runChat(session, text, turnId)
    return { ok: true, session_id: sessionId, turn_id: turnId }
  }

  private async runChat(session: StoredSession, text: string, turnId: string): Promise<void> {
    const turn = { sessionId: session.id, turnId, generation: ++this.generation, piDone: false, drained: false, speech: this.tts.configured && this.sceneReady, text: '' }
    turn.drained = !turn.speech
    this.activeTurn = turn
    const parser = new PresentationText()
    let receivedText = false
    let synthesisStarted = false
    this.voice({ ...turn, type: 'begin', speech: turn.speech, calibration: this.calibration() })
    this.voice({ ...turn, type: 'activity', activity: 'thinking' })
    const present = (value: ReturnType<PresentationText['push']>) => {
      if (!sameTurn(this.activeTurn, turn)) return
      turn.text += value.display
      this.emit('chat.token', { session_id: session.id, turn_id: turnId, token: turn.text })
      this.voice({ ...turn, type: 'text', value })
      if (turn.speech && value.text) {
        if (!synthesisStarted) { this.tts.start(turn); synthesisStarted = true }
        this.tts.push(value.text)
      }
    }
    try {
      const result = await this.pi.prompt(session.id, text, {
        onText: delta => {
          if (!sameTurn(this.activeTurn, turn)) return
          receivedText = true
          present(parser.push(delta))
        },
        onTool: (name, done) => {
          if (!sameTurn(this.activeTurn, turn)) return
          this.emit('chat.tool', { session_id: session.id, turn_id: turnId, name, done })
          this.voice({ ...turn, type: 'activity', activity: done ? 'thinking' : 'tool' })
        },
      })
      if (!sameTurn(this.activeTurn, turn)) return
      if (!receivedText && result) present(parser.push(result))
      present(parser.finish())
      turn.piDone = true
      this.markActivity()
      if (turn.text) session.messages.push({ role: 'assistant', text: turn.text, turn_id: turnId })
      this.store.save()
      this.emit('chat.complete', { session_id: session.id, turn_id: turnId, full_text: turn.text })
      this.voice({ ...turn, type: 'activity', activity: 'idle' })
      if (turn.speech && synthesisStarted) this.tts.finish()
      else if (turn.speech) this.voice({ ...turn, type: 'input-ended' })
      this.resumeListening()
    } catch (error) {
      if (!sameTurn(this.activeTurn, turn)) return
      this.tts.abort()
      turn.piDone = true
      turn.drained = true
      this.markActivity()
      this.voice({ ...turn, type: 'reset' })
      this.emit('chat.error', { session_id: session.id, turn_id: turnId, error: error instanceof Error ? error.message : String(error) })
      this.resumeListening()
    }
  }

  private async abortChat(params: Json): Promise<Json> {
    if (params.session_id && params.session_id !== this.activeTurn?.sessionId) return { ok: true }
    if (params.turn_id && params.turn_id !== this.activeTurn?.turnId) return { ok: true }
    this.cancelTurn()
    this.resumeListening()
    return { ok: true }
  }

  private idleKey(): TurnKey { return { sessionId: this.currentSessionId, turnId: '', generation: this.generation } }
  private voice(event: VoiceEvent): void { this.emit('voice.event', event as unknown as Json) }
  private calibration(): Calibration {
    const number = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback
    return { mouthGain: number(this.config.mouth_gain, 8, 0, 32), silenceThreshold: number(this.config.mouth_silence_threshold, 0.08, 0, 1), syncOffsetMs: number(this.config.voice_sync_offset_ms, 0, -1000, 1000) }
  }
  private cancelTurn(): void {
    this.markActivity()
    const turn = this.activeTurn
    this.activeTurn = null
    this.tts.abort()
    if (turn && !turn.piDone) {
      void this.pi.abort(turn.sessionId).catch(() => {})
      this.emit('chat.interrupted', { session_id: turn.sessionId, turn_id: turn.turnId, text: turn.text })
    }
    this.generation++
    this.voice({ ...this.idleKey(), type: 'reset' })
  }
  private onPlayback(event: PlaybackEvent): void {
    const turn = this.activeTurn
    if (!turn) return
    if (event.type === 'ended' || event.type === 'error') {
      turn.drained = true
      if (event.type === 'error') {
        this.tts.abort()
        turn.speech = false
        this.emit('tts.error', { error: event.error || 'Audio playback unavailable', turn_id: turn.turnId })
      }
      this.markActivity()
      this.resumeListening()
    }
  }
  private resumeListening(): void {
    if (this.disposed) return
    if (this.reloadTargets.size) this.flushReload()
    if (this.reloading || this.reloadTargets.size) return
    if (this.listeningEnabled && this.sceneReady && (!this.activeTurn || (this.activeTurn.piDone && this.activeTurn.drained))) {
      const result = this.speech.start(String(this.config.asr_language || 'zh-CN'))
      if (!result.ok) this.listeningEnabled = false
    }
  }
  private onSpeech(method: string, params: Json): void {
    if (method === 'asr.recognized' && params.is_final === true) {
      if (this.reloading || this.reloadTargets.size) return
      if (!this.listeningEnabled || (this.activeTurn && (!this.activeTurn.piDone || !this.activeTurn.drained))) return
      const text = String(params.text || '').trim()
      if (!text) return
      this.speech.stop()
      const turnId = randomUUID()
      this.emit(method, { ...params, source: 'wake', turn_id: turnId })
      this.sendChat({ text, turn_id: turnId })
      return
    }
    this.emit(method, params)
    if (method === 'asr.status') {
      if (params.status === 'error') this.listeningEnabled = false
      if (params.status === 'listening') this.voice({ ...(this.activeTurn || this.idleKey()), type: 'activity', activity: 'listening' })
    }
  }
}

let runtime: AppRuntime

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#05070b',
    webPreferences: {
      preload: path.join(MODULE_DIR, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  runtime.attach(window)
  if (process.env.AMADEUS_NEXT_DEV === '1') await window.loadURL(DEV_SERVER_URL)
  else await window.loadFile(path.join(MODULE_DIR, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  runtime = new AppRuntime()
  await runtime.init()
  ipcMain.handle('next.request', (event, method: string, params: Json) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Only the application frame can call the runtime')
    return runtime.request(method, params || {})
  })
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => runtime?.dispose())
