import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, Dialog, SafeStorage } from 'electron'
import type { Clock } from './clock.ts'
import type { ensureBakedModel, importEmoteAssets, verifyEmoteRuntime } from './emoteBake.ts'
import type { FishTts } from './fishTts.ts'
import type { PiHost } from './piHost.ts'
import type { SceneHost } from './sceneHost.ts'
import type { SessionStore, StoredSession } from './sessionStore.ts'
import type { SpeechBridge } from './speechBridge.ts'
import { PresentationText } from '../shared/presentation.ts'
import { sameTurn, isTurnKey, type TurnKey, type VoiceEvent, type PlaybackEvent, type Calibration } from '../shared/voice.ts'

type Json = Record<string, unknown>

/** 集中注入所有外部环境依赖（Electron、路径、硬件、时钟），实现核心逻辑与运行环境解耦以支持无头测试。 */
export type RuntimeDeps = {
  env: NodeJS.ProcessEnv
  root: string
  moduleDir: string
  userData: string
  clock: Clock
  store: SessionStore
  settings: { read(): Json; write(data: Json): void }
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  dialog: Pick<Dialog, 'showOpenDialog'>
  exit(code: number): void
  timestampedSessionTitle(): string
  verifyEmoteRuntime: typeof verifyEmoteRuntime
  ensureBakedModel: typeof ensureBakedModel
  importEmoteAssets: typeof importEmoteAssets
  createScene(cacheDir: string): SceneHost
  createPi(env: () => Record<string, string>): PiHost
  createSpeech(emit: (method: string, params: Json) => void): SpeechBridge
  createTts(config: () => Json, emit: (event: VoiceEvent) => void): FishTts
}

export class AppRuntime {
  private readonly deps: RuntimeDeps
  private readonly root: string
  private readonly scene: SceneHost
  private readonly store: SessionStore
  private readonly pi: PiHost
  private readonly windows = new Set<BrowserWindow>()
  private readonly config: Json
  private readonly speech: SpeechBridge
  private readonly tts: FishTts
  private currentSessionId = ''
  private generation = 0
  private activeTurn: (TurnKey & { piDone: boolean; drained: boolean; speech: boolean; text: string }) | null = null
  private listeningEnabled = false
  private listeningResumeAt = 0
  private listeningResumeTimer: ReturnType<typeof setTimeout> | null = null
  private sceneReady = false
  private sceneToken = ''
  private readonly reloadTargets = new Set<string>()
  private reloading = false
  private disposed = false
  private reloadState: Json = { status: 'ready', targets: [] }
  private sceneReload: { resolve: () => void; reject: (error: Error) => void } | null = null
  private idleActive = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private emoteCache: string
  private emoteRoot: string
  private emotePreparation: Promise<void> | null = null
  private importingEmote = false

  constructor(deps: RuntimeDeps) {
    this.deps = deps
    this.root = deps.root
    this.config = {
      llm_provider: 'pi',
      presentation_locale: 'zh-CN',
      asr_backend: 'apple_speech',
      asr_language: 'zh-CN',
      tts_backend: 'fish_stream',
      tts_mode: 'stream',
      FISH_API_KEY: deps.env.FISH_API_KEY || '',
      FISH_API_MODEL: deps.env.FISH_API_MODEL || 's2-pro',
      FISH_VOICE_ID: deps.env.FISH_VOICE_ID || '',
      mouth_gain: 8,
      mouth_silence_threshold: 0.08,
      voice_sync_offset_ms: 0,
      network_proxy: '',
    }
    this.pi = deps.createPi(() => this.piEnv())
    // 角色资源与烘焙缓存与分发包解耦，置于用户数据目录以支持热更新与自定义导入。
    this.emoteCache = deps.env.AMADEUS_EMOTE_CACHE || path.join(deps.userData, 'emote-cache')
    // 资源重组后 emote 位于 character 域；保留旧布局回退以兼容已安装的分发包。
    const imported = path.join(deps.userData, 'emote')
    const bundled = path.join(this.root, 'character/emote')
    this.emoteRoot = existsSync(imported) ? imported : existsSync(bundled) ? bundled : path.join(this.root, 'emote')
    this.scene = deps.createScene(this.emoteCache)
    this.store = deps.store
    this.loadPersistedSettings()
    this.speech = deps.createSpeech((method, params) => this.onSpeech(method, params))
    this.tts = deps.createTts(() => this.config, event => {
      if (!sameTurn(this.activeTurn, event)) return
      this.voice(event)
      if (event.type === 'error' && this.activeTurn) {
        this.activeTurn.drained = true
        this.activeTurn.speech = false
        this.markActivity()
        this.emit('tts.error', { error: event.error, diagnostic: event.diagnostic, turn_id: event.turnId })
        this.resumeListening()
      }
    })
  }

  async init(): Promise<void> {
    // 资源就绪校验推迟至首屏渲染时按需触发，避免阻塞主窗口创建。
    await this.scene.start()
    this.markActivity()
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
      case 'wallpaper.start':
        try {
          if (this.importingEmote) throw new Error('正在导入角色资源，请稍后重试')
          await this.prepareEmote()
          return { ok: true, status: 'ready', url: this.scene.url }
        } catch (error) {
          return { ok: false, status: 'error', retryable: false, error: error instanceof Error ? error.message : String(error) }
        }
      case 'emote.import':
        return this.importEmoteResources()
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
        return this.deps.env.AMADEUS_NEXT_DEV === '1' ? this.queueReload(params, true) : { ok: false, error: 'Development reload is disabled' }
      case 'pi.models':
      case 'pi.model.set':
        if (this.reloading || this.reloadTargets.size || (this.activeTurn && !this.activeTurn.piDone)) return { ok: false, error: 'Wait for the current reply or reload to finish' }
        if (method === 'pi.model.set' && typeof params.model !== 'string') return { ok: false, error: 'Invalid model' }
        try {
          const result = await this.pi.request(method === 'pi.models' ? 'models' : 'set-model', { sessionId: this.currentSessionId, model: params.model, thinkingLevel: params.thinkingLevel })
          // 同步当前模型切换事件至前端，保持界面状态实时一致。
          if (method === 'pi.model.set') this.emit('pi.model', { current: result.current })
          return { ok: true, ...result }
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      case 'session.list':
        return this.sessionPayload()
      case 'session.create':
        return this.createSession(params)
      case 'session.load':
        return this.loadSession(String(params.session_id || ''))
      case 'chat.send':
        return this.sendChat(params)
      case 'chat.abort':
        return this.abortChat(params)
      case 'scene.ready':
        if (this.sceneReload && (!params.token || params.token === this.sceneToken)) return { ok: false, error: 'Stale scene handshake' }
        this.sceneToken = String(params.token || '')
        this.sceneReady = true
        // 场景重建后内部状态归零，需主动重发当前的闲置演出状态以恢复视觉表现。
        this.emit('voice.event', { type: 'conversation-idle', active: this.idleActive })
        if (this.sceneReload) this.sceneReload.resolve()
        this.resumeListening()
        return { ok: true, key: this.activeTurn || this.idleKey(), text: this.activeTurn?.text || '', calibration: this.calibration() }
      case 'scene.lost':
        if (params.token && params.token !== this.sceneToken) return { ok: true }
        this.sceneReady = false
        if (!this.sceneReload) {
          this.listeningEnabled = false
          // 渲染层崩溃支持独立重载恢复，不可中断或重放底层的模型推理与工具调用任务。
          this.tts.abort()
          if (this.activeTurn) {
            this.activeTurn.speech = false
            if (!this.activeTurn.drained) { this.activeTurn.drained = true; this.markActivity() }
          }
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
        if (this.deps.clock.now() < this.listeningResumeAt) { this.resumeListening(); return { ok: true } }
        this.cancelListeningResume()
        const result = this.speech.start(String(this.config.asr_language || 'zh-CN'))
        if (!result.ok) this.listeningEnabled = false
        return result
      }
      case 'asr.stop':
        this.listeningEnabled = false
        this.cancelListeningResume()
        this.voice({ ...(this.activeTurn || this.idleKey()), type: 'activity', activity: 'idle' })
        return this.speech.finish(true)
      default:
        return { ok: false, error: `unsupported_method:${method}` }
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelListeningResume()
    if (this.idleTimer !== null) {
      this.deps.clock.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.reloadTargets.clear()
    this.sceneReload?.reject(new Error('Application closed'))
    this.speech.dispose()
    this.tts.abort()
    this.scene.close()
    this.pi.dispose()
  }

  private prepareEmote(): Promise<void> {
    if (!this.emotePreparation) {
      this.emotePreparation = (async () => {
        await this.deps.verifyEmoteRuntime(this.emoteRoot)
        const baked = await this.deps.ensureBakedModel('kurisu_ab_white', { moduleDir: this.deps.moduleDir, modelRoot: path.join(this.emoteRoot, 'models'), cacheDir: this.emoteCache })
        this.scene.setEmoteAssets(this.emoteRoot, path.dirname(baked.psb))
      })().finally(() => { this.emotePreparation = null })
    }
    return this.emotePreparation
  }

  private async importEmoteResources(): Promise<Json> {
    if (this.importingEmote || this.reloading || this.reloadTargets.size || this.activeTurn && (!this.activeTurn.piDone || !this.activeTurn.drained)) {
      return { ok: false, error: '请等待当前回复或资源操作完成后再导入' }
    }
    this.importingEmote = true
    try {
      const selection = await this.deps.dialog.showOpenDialog({
        title: '导入 E-mote 角色资源', properties: ['openDirectory'],
        message: '选择包含 FreeMoteDriver.js、emoteplayer.js 和 models/ 的 emote 目录。资源将复制到本应用，不使用软链接。',
      })
      if (selection.canceled || !selection.filePaths[0]) return { ok: true, cancelled: true }
      await this.emotePreparation?.catch(() => {})
      const destination = path.join(this.deps.userData, 'emote')
      const baked = await this.deps.importEmoteAssets(selection.filePaths[0], destination, { moduleDir: this.deps.moduleDir, cacheDir: this.emoteCache })
      this.emoteRoot = destination
      this.scene.setEmoteAssets(destination, path.dirname(baked.psb))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally { this.importingEmote = false }
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
      // 等待已中断的回合彻底排空工具清理逻辑，防止热重载期间残留死锁。
      if (!this.pi.error) await this.pi.request('checkpoint')
      if (targets.includes('main')) {
        this.dispose()
        this.deps.exit(75) // 约定退出码 75 触发开发脚手架热重启主进程。
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
        timer = this.deps.clock.setTimeout(() => reject(new Error('Scene reload timed out')), 20000)
        this.sceneReload = { resolve, reject }
        if (preload) {
          for (const window of this.windows) if (!window.isDestroyed()) window.webContents.reload()
        } else this.emit('scene.reload', {})
      })
    } finally {
      this.deps.clock.clearTimeout(timer!)
      this.sceneReload = null
    }
  }

  /** 对话回复与语音播放均完全结束后延时触发闲置，避免打断交互。 */
  private markActivity(): void {
    if (this.idleTimer !== null) this.deps.clock.clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.disposed) return
    this.publishIdle(false)
    const turn = this.activeTurn
    if (turn && (!turn.piDone || !turn.drained)) return
    this.idleTimer = this.deps.clock.setTimeout(() => {
      this.idleTimer = null
      this.publishIdle(true)
    }, 180_000)
  }

  /** 仅在闲置状态翻转时广播，防止冗余重绘。 */
  private publishIdle(idle: boolean): void {
    if (idle === this.idleActive) return
    this.idleActive = idle
    this.emit('voice.event', { type: 'conversation-idle', active: idle })
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

  // Pi 子进程在启动时从环境变量加载代理配置，故代理变更需重建 worker。
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
      // 仅支持 HTTP CONNECT 代理，拒绝 SOCKS/PAC 协议以匹配底层的网络栈限制。
      if (proxy && (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname)) {
        return { ok: false, error: 'Invalid network_proxy: expected an http:// or https:// proxy URL' }
      }
      values.network_proxy = proxy
    }
    const previousLanguage = this.config.asr_language
    const previousProxy = this.config.network_proxy
    Object.assign(this.config, values)
    this.persistSettings()
    // 代理变更仅在子进程边界热重启，避免破坏正在进行的语音合成与场景渲染。
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
      if (['FISH_API_KEY', 'FISH_VOICE_ID', 'voice_configuration', 'general_configuration', 'asr_backends'].includes(key)) return []
      return [[key, String(value ?? '')]]
    }))
    const secrets = Object.fromEntries(['FISH_API_KEY', 'FISH_VOICE_ID'].map(key => [key, { configured: Boolean(this.config[key]), source: 'user', locked: false }]))
    return { values, sources: {}, locked: {}, secrets, encryptionAvailable: this.deps.safeStorage.isEncryptionAvailable() }
  }

  private configSnapshot(): Json {
    const { FISH_API_KEY: _fishApiKey, ...publicConfig } = this.config
    return {
      ...publicConfig,
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
    const stored = this.deps.settings.read()
    for (const [key, value] of Object.entries(stored)) {
      if (key in this.config && key !== 'FISH_API_KEY') this.config[key] = value
    }
    if (this.deps.safeStorage.isEncryptionAvailable() && typeof stored.FISH_API_KEY_ENCRYPTED === 'string') {
      try { this.config.FISH_API_KEY = this.deps.safeStorage.decryptString(Buffer.from(stored.FISH_API_KEY_ENCRYPTED, 'base64')) } catch { /* keep environment value */ }
    }
  }

  private persistSettings(): void {
    const data: Json = Object.fromEntries(Object.entries(this.config).filter(([key]) => key !== 'FISH_API_KEY'))
    if (this.deps.safeStorage.isEncryptionAvailable() && String(this.config.FISH_API_KEY || '')) {
      try { data.FISH_API_KEY_ENCRYPTED = this.deps.safeStorage.encryptString(String(this.config.FISH_API_KEY)).toString('base64') } catch { /* keep the in-memory value */ }
    }
    this.deps.settings.write(data)
  }

  private sendChat(params: Json): Json {
    this.markActivity()
    if (this.importingEmote) return { ok: false, error: '正在导入角色资源，请稍后重试' }
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
    // 延迟命名：首次发送消息才落时间戳，避免产生大量无内容的幽灵会话。
    if (session.title === '新对话') {
      session.title = this.deps.timestampedSessionTitle()
      this.emit('session.titled', { session_id: session.id, title: session.title })
    }
    session.messages.push({ role: 'user', text, turn_id: turnId })
    this.store.save()
    void this.runChat(session, text, turnId)
    return { ok: true, session_id: sessionId, turn_id: turnId }
  }

  private async runChat(session: StoredSession, text: string, turnId: string): Promise<void> {
    const turn = { sessionId: session.id, turnId, generation: ++this.generation, piDone: false, drained: false, speech: this.tts.configured && this.sceneReady, text: '' }
    turn.drained = !turn.speech
    this.activeTurn = turn
    this.markActivity()
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
        onTool: (_name, done) => {
          if (!sameTurn(this.activeTurn, turn)) return
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
    this.cancelListeningResume()
    const turn = this.activeTurn
    this.activeTurn = null
    this.markActivity()
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
      // 播放排空后保留 1 秒自然停顿缓冲，并防止过早开启监听引入麦克风回音。
      if (event.type === 'ended' && !turn.drained) this.listeningResumeAt = this.deps.clock.now() + 1000
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
  private cancelListeningResume(): void {
    if (this.listeningResumeTimer !== null) this.deps.clock.clearTimeout(this.listeningResumeTimer)
    this.listeningResumeTimer = null
  }
  private resumeListening(): void {
    this.cancelListeningResume()
    if (this.disposed) return
    if (this.reloadTargets.size) this.flushReload()
    if (this.reloading || this.reloadTargets.size) return
    if (this.listeningEnabled && this.sceneReady && (!this.activeTurn || (this.activeTurn.piDone && this.activeTurn.drained))) {
      const delay = this.listeningResumeAt - this.deps.clock.now()
      if (delay > 0) {
        this.listeningResumeTimer = this.deps.clock.setTimeout(() => this.resumeListening(), delay)
        return
      }
      const result = this.speech.start(String(this.config.asr_language || 'zh-CN'))
      if (!result.ok) this.listeningEnabled = false
    }
  }
  private onSpeech(method: string, params: Json): void {
    if (this.disposed) return
    if (method === 'asr.recognized' && params.is_final === true) {
      if (this.reloading || this.reloadTargets.size) return
      if (this.activeTurn && (!this.activeTurn.piDone || !this.activeTurn.drained)) return
      if (params.source === 'manual') { this.emit(method, params); return }
      if (!this.listeningEnabled) return
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
      if (params.status === 'error' || (params.status === 'idle' && params.reason === 'no-speech')) {
        this.listeningEnabled = false
        this.cancelListeningResume()
      }
      if (params.status === 'listening') this.voice({ ...(this.activeTurn || this.idleKey()), type: 'activity', activity: 'listening' })
    }
  }
}
