import { app, BrowserWindow, ipcMain, safeStorage, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { SceneHost } from './sceneHost.ts'
import { FishTts } from './fishTts.ts'
import { PresentationText } from '../shared/presentation.ts'
import { sameTurn, isTurnKey, type TurnKey, type VoiceEvent, type PlaybackEvent, type Calibration } from '../shared/voice.ts'

type Json = Record<string, unknown>
type StoredMessage = { role: 'user' | 'assistant'; text: string; turn_id?: string }
type StoredSession = { id: string; title: string; messages: StoredMessage[] }

const DEV_SERVER_URL = process.env.SALIERI_NEXT_DEV_URL || 'http://127.0.0.1:5199'
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

function projectRoot(): string {
  if (process.env.SALIERI_NEXT_PROJECT_ROOT) return process.env.SALIERI_NEXT_PROJECT_ROOT
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


class SessionStore {
  private readonly file: string
  sessions: StoredSession[] = []

  constructor(file: string) {
    this.file = file
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(value)) this.sessions = value as StoredSession[]
    } catch {
      this.sessions = []
    }
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.sessions, null, 2), 'utf8')
  }
}

class PiHost {
  private process: UtilityProcess | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<string, {
    resolve: (text: string) => void
    reject: (error: Error) => void
    onText: (delta: string) => void
    onTool: (name: string, done: boolean) => void
  }>()
  error = ''

  async init(): Promise<void> {
    this.process = utilityProcess.fork(path.join(MODULE_DIR, 'pi-worker.js'), [], {
      cwd: process.cwd(),
      env: { ...process.env, SALIERI_NEXT_PI_CWD: process.cwd() },
      serviceName: 'Salieri Pi Runtime',
      stdio: 'pipe',
    })
    console.info(`[salieri-next] Pi utility process starting: ${this.process.pid ?? 'pending'}`)
    this.process.on('spawn', () => console.info(`[salieri-next] Pi utility process ready: ${this.process?.pid ?? 'unknown'}`))
    this.process.on('error', (type, location, report) => console.error('[salieri-next] Pi utility process error', type, location, report))
    this.process.on('message', message => this.receive(message))
    this.process.on('exit', () => {
      this.error = this.error || 'Pi utility process exited'
      for (const pending of this.pending.values()) pending.reject(new Error(this.error))
      this.pending.clear()
      this.process = null
    })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pi utility process startup timed out')), 20000)
      const check = (message: unknown) => {
        const value = message && typeof message === 'object' ? message as Json : {}
        if (value.type !== 'ready') return
        clearTimeout(timer)
        this.process?.off('message', check)
        if (value.error) reject(new Error(String(value.error)))
        else resolve()
      }
      this.process?.on('message', check)
    })
    try {
      await this.ready
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.process?.kill()
      this.process = null
    }
  }

  async prompt(
    id: string,
    text: string,
    callbacks: { onText: (delta: string) => void; onTool: (name: string, done: boolean) => void },
  ): Promise<string> {
    await this.ready
    if (!this.process) throw new Error(this.error || 'Pi utility process is unavailable')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onText: callbacks.onText, onTool: callbacks.onTool })
      this.process?.postMessage({ id: requestId, command: 'prompt', sessionId: id, text })
    })
  }

  async abort(id: string): Promise<void> {
    if (!this.process) return
    this.process.postMessage({ id: randomUUID(), command: 'abort', sessionId: id })
  }

  dispose(): void {
    this.process?.kill()
    this.process = null
  }

  private receive(raw: unknown): void {
    const message = raw && typeof raw === 'object' ? raw as Json : {}
    const requestId = String(message.id || '')
    const pending = this.pending.get(requestId)
    if (!pending) return
    if (message.type === 'text') pending.onText(String(message.delta || ''))
    else if (message.type === 'tool') pending.onTool(String(message.name || 'tool'), message.done === true)
    else if (message.type === 'done') {
      this.pending.delete(requestId)
      pending.resolve(String(message.text || ''))
    } else if (message.type === 'error') {
      this.pending.delete(requestId)
      pending.reject(new Error(String(message.error || 'Pi request failed')))
    } else if (message.type === 'aborted') {
      this.pending.delete(requestId)
      pending.resolve('')
    }
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
        process.env.SALIERI_SPEECH_HELPER || '',
        path.join(MODULE_DIR, '../bin/SalieriSpeechRecognizer'),
        path.join(process.resourcesPath || '', 'SalieriSpeechRecognizer'),
      ].find(candidate => candidate && existsSync(candidate)) || ''
      if (!existsSync(helper)) {
        const error = 'Apple Speech helper is not built; run npm run build on macOS'
        this.emit('asr.status', { status: 'error', error })
        return { ok: false, error }
      }
      this.process = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] })
      this.process.stdout?.on('data', chunk => this.read(chunk.toString('utf8')))
      this.process.on('exit', () => {
        this.process = null
        this.listening = false
        this.emit('asr.status', { status: 'idle' })
      })
      this.process.on('error', () => {
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
    this.process?.kill()
    this.process = null
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
  private readonly pi = new PiHost()
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
  }
  private readonly speech: SpeechBridge
  private readonly tts: FishTts
  private currentSessionId = ''
  private generation = 0
  private activeTurn: (TurnKey & { piDone: boolean; drained: boolean; speech: boolean; text: string }) | null = null
  private listeningEnabled = false
  private sceneReady = false

  constructor() {
    this.root = projectRoot()
    this.scene = new SceneHost(this.root, path.join(MODULE_DIR, '../scene'))
    this.store = new SessionStore(path.join(app.getPath('userData'), 'salieri-next-sessions.json'))
    this.settingsFile = path.join(app.getPath('userData'), 'salieri-next-settings.json')
    this.loadPersistedSettings()
    this.speech = new SpeechBridge((method, params) => this.onSpeech(method, params))
    this.tts = new FishTts(() => this.config, event => {
      if (!sameTurn(this.activeTurn, event)) return
      this.voice(event)
      if (event.type === 'error' && this.activeTurn) {
        this.activeTurn.drained = true
        this.activeTurn.speech = false
        this.emit('tts.error', { error: event.error, turn_id: event.turnId })
        this.resumeListening()
      }
    })
  }

  async init(): Promise<void> {
    await this.scene.start()
    await this.pi.init()
    if (!this.store.sessions.length) {
      this.store.sessions.push({ id: randomUUID(), title: '新对话', messages: [] })
      this.store.save()
    }
    this.currentSessionId = this.store.sessions[0].id
  }

  attach(window: BrowserWindow): void {
    this.windows.add(window)
    window.on('closed', () => { this.windows.delete(window); this.sceneReady = false; this.listeningEnabled = false; this.cancelTurn(); this.speech.stop() })
    window.webContents.on('render-process-gone', () => { this.sceneReady = false; this.listeningEnabled = false; this.cancelTurn(); this.speech.stop() })
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
        this.sceneReady = true
        this.cancelTurn()
        this.resumeListening()
        return { ok: true, key: this.idleKey(), calibration: this.calibration() }
      case 'scene.lost':
        this.sceneReady = false
        this.listeningEnabled = false
        this.cancelTurn()
        this.speech.stop()
        return { ok: true }
      case 'voice.playback':
        if (isTurnKey(params) && sameTurn(this.activeTurn, params)) this.onPlayback(params as PlaybackEvent)
        return { ok: true }
      case 'asr.start': {
        this.listeningEnabled = true
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
    this.speech.dispose()
    this.tts.abort()
    this.scene.close()
    this.pi.dispose()
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
    this.cancelTurn()
    this.store.save()
    const payload = { ...this.sessionPayload(session), ok: true, client_request_id: String(params.client_request_id || ''), source: 'next' }
    this.emit('session.changed', payload)
    return payload
  }

  private loadSession(id: string): Json {
    const session = this.store.sessions.find(item => item.id === id)
    if (!session) return { ok: false, error: 'session not found' }
    this.currentSessionId = id
    this.listeningEnabled = false
    this.speech.stop()
    this.cancelTurn()
    return { ...this.sessionPayload(session), ok: true, source: 'next' }
  }

  private setConfig(values: Json): Json {
    Object.assign(this.config, values)
    this.persistSettings()
    this.emit('system.config', { values: this.configSnapshot() })
    return { ok: true, values: this.configSnapshot() }
  }

  private desktopSettings(): Json {
    const snapshot = this.configSnapshot()
    const values = Object.fromEntries(Object.entries(snapshot).flatMap(([key, value]) => {
      if (['FISH_API_KEY', 'FISH_VOICE_ID', 'model_connections', 'model_roles', 'voice_configuration', 'work_provider_configuration', 'asr_backends'].includes(key)) return []
      return [[key, String(value ?? '')]]
    }))
    const secrets = Object.fromEntries(['FISH_API_KEY', 'FISH_VOICE_ID'].map(key => [key, { configured: Boolean(this.config[key]), source: 'user', locked: false }]))
    return { values, sources: {}, locked: {}, secrets, encryptionAvailable: safeStorage.isEncryptionAvailable() }
  }

  private configSnapshot(): Json {
    const { FISH_API_KEY: _fishApiKey, ...publicConfig } = this.config
    return {
      ...publicConfig,
      model_connections: [],
      model_roles: [],
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
            { key: 'asr_language', label: 'Recognition language', type: 'select', value: 'zh-CN', options: ['zh-CN', 'en-US'], editable: true, restart_required: false },
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
            { key: 'FISH_API_MODEL', label: 'Fish model', type: 'select', value: String(this.config.FISH_API_MODEL || 's2-pro'), options: ['s2-pro', 's1'], editable: true, restart_required: false },
          ],
        },
      ],
    }
  }

  private updateDesktopSettings(params: Json): Json {
    const values = params.values && typeof params.values === 'object' ? params.values as Json : {}
    const secrets = params.secrets && typeof params.secrets === 'object' ? params.secrets as Json : {}
    for (const [key, value] of Object.entries(values)) this.config[key] = value
    for (const [key, value] of Object.entries(secrets)) this.config[key] = value
    this.persistSettings()
    this.emit('system.config', { values: this.configSnapshot() })
    return { ok: true, settings: this.desktopSettings() }
  }

  private loadPersistedSettings(): void {
    const stored = jsonFile(this.settingsFile, {})
    const values = stored.values && typeof stored.values === 'object' ? stored.values as Json : {}
    for (const [key, value] of Object.entries(values)) {
      if (key in this.config && key !== 'FISH_API_KEY') this.config[key] = value
    }
    const encrypted = stored.encrypted && typeof stored.encrypted === 'object' ? stored.encrypted as Json : {}
    if (safeStorage.isEncryptionAvailable() && typeof encrypted.FISH_API_KEY === 'string') {
      try { this.config.FISH_API_KEY = safeStorage.decryptString(Buffer.from(encrypted.FISH_API_KEY, 'base64')) } catch { /* keep environment value */ }
    }
  }

  private persistSettings(): void {
    const values = Object.fromEntries(Object.entries(this.config).filter(([key]) => key !== 'FISH_API_KEY'))
    const encrypted: Json = {}
    if (safeStorage.isEncryptionAvailable() && String(this.config.FISH_API_KEY || '')) {
      try { encrypted.FISH_API_KEY = safeStorage.encryptString(String(this.config.FISH_API_KEY)).toString('base64') } catch { /* keep the in-memory value */ }
    }
    mkdirSync(path.dirname(this.settingsFile), { recursive: true })
    writeFileSync(this.settingsFile, JSON.stringify({ values, encrypted }, null, 2), 'utf8')
  }

  private sendChat(params: Json): Json {
    const sessionId = String(params.session_id || this.currentSessionId)
    const session = this.store.sessions.find(item => item.id === sessionId)
    const text = String(params.text || '').trim()
    const turnId = String(params.turn_id || randomUUID())
    if (!session) return { ok: false, error: 'session not found' }
    if (!text) return { ok: false, error: 'message is empty' }
    this.cancelTurn()
    this.speech.stop()
    this.currentSessionId = sessionId
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
      turn.text += value.text
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
    const turn = this.activeTurn
    this.activeTurn = null
    this.tts.abort()
    if (turn && !turn.piDone) {
      void this.pi.abort(turn.sessionId)
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
      this.resumeListening()
    }
  }
  private resumeListening(): void {
    if (this.listeningEnabled && this.sceneReady && (!this.activeTurn || (this.activeTurn.piDone && this.activeTurn.drained))) {
      const result = this.speech.start(String(this.config.asr_language || 'zh-CN'))
      if (!result.ok) this.listeningEnabled = false
    }
  }
  private onSpeech(method: string, params: Json): void {
    if (method === 'asr.recognized' && params.is_final === true) {
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
  if (process.env.SALIERI_NEXT_DEV === '1') await window.loadURL(DEV_SERVER_URL)
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
