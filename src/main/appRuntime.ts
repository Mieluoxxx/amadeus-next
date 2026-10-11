import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, Dialog, SafeStorage, Shell } from 'electron'
import type { Clock } from './clock.ts'
import type { Baker, ensureBakedModel, importEmoteAssets, verifyEmoteRuntime } from './emoteBake.ts'
import type { FishTts } from './fishTts.ts'
import { Floor, type PendingReport, type ReportOutcome } from './floor.ts'
import type { PiHost } from './piHost.ts'
import type { SceneHost } from './sceneHost.ts'
import type { SessionStore } from './sessionStore.ts'
import type { SpeechBridge } from './speechBridge.ts'
import { DEFAULT_JEV_MODEL, DEFAULT_JEV_URL } from './jev.ts'
import { PresentationText } from '../shared/presentation.ts'
import { isTurnKey, SCENE_FRAME_RATES, sameTurn, type Calibration, type PlaybackEvent, type SceneFrameRate, type TurnKey, type VoiceEvent } from '../shared/voice.ts'

type Json = Record<string, unknown>
type TurnKind = 'user' | 'report'
type WorkerSession = { id: string; title: string; updatedAt: number; hasActive: boolean; pendingReports: number }
type ActiveTurn = TurnKey & {
  kind: TurnKind
  piDone: boolean
  drained: boolean
  speech: boolean
  text: string
  parser: PresentationText
  receivedText: boolean
  synthesisStarted: boolean
  /** 最近一次收到本回合 turn.* 事件（或回合开始）的时刻，看门狗据此判断是否沉默太久。 */
  lastEventAt: number
}

// 落盘时以 `<key>_ENCRYPTED` 形式经 safeStorage 加密，明文永不写入设置文件。
const SECRET_KEYS = ['FISH_API_KEY', 'JEV_API_KEY', 'web_search_api_key']
const UNFOCUSED_FRAME_RATE: SceneFrameRate = 15
const DEFAULT_SESSION_TITLE = '新对话'
const LEGACY_READONLY = 'legacy session is read-only'
const MEMORY_RECALL_MODES = ['off', 'log', 'on']
const SEARCH_PROVIDERS = ['brave', 'tavily']
// model.list 的取值是 `${provider}/${id}`：provider 不含斜杠，id 可以含（如 openrouter/anthropic/x）。
const DELEGATION_MODEL_PATTERN = /^[^\s/]+\/\S+$/
// 进行中的回合这么久没有任何 turn.* 事件，就当它的终止事件丢了；没有它 Floor 会一直 responding，重载与汇报都排不上。
const TURN_WATCHDOG_MS = 120_000
// worker 被替换期间这些转发方法统一回绝，避免请求落到正在关库的进程上。
const WORKER_METHODS = /^(session\.(list|create|load|rename|delete)|task\.(cancel|approve)|memory\.(list|write|delete|accept|reject|clear|status|configure))$/

// 窗口先于 runtime 就绪创建；这些只读本地状态，不必排在 Pi 启动后面。其余方法可能开麦、投递汇报或碰会话，必须等启动完成。
const PRE_INIT_METHODS = /^(system\.get_config|desktop\.settings\.get|runtime\.status|voice\.playback)$/

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const codeOf = (error: unknown): string => error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'failed'

/** 集中注入所有外部环境依赖（Electron、路径、硬件、时钟），实现核心逻辑与运行环境解耦以支持无头测试。 */
export type RuntimeDeps = {
  env: NodeJS.ProcessEnv
  root: string
  emoteBaker: Baker
  userData: string
  /** 记忆目录；也是 worker 的 AMADEUS_MEMORY_DIR，主进程只用它打开文件夹。 */
  memoryDir: string
  clock: Clock
  /** 旧会话，只读。 */
  store: SessionStore
  settings: { read(): Json; write(data: Json): void }
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  dialog: Pick<Dialog, 'showOpenDialog'>
  shell: Pick<Shell, 'openPath'>
  /** 窗口无焦点时的系统通知。 */
  notify(title: string, body: string): void
  exit(code: number): void
  timestampedSessionTitle(): string
  verifyEmoteRuntime: typeof verifyEmoteRuntime
  ensureBakedModel: typeof ensureBakedModel
  importEmoteAssets: typeof importEmoteAssets
  createScene(cacheDir: string): SceneHost
  createPi(env: () => Record<string, string>, onEvent: (event: Json) => void): PiHost
  createSpeech(emit: (method: string, params: Json) => void): SpeechBridge
  createTts(config: () => Json, emit: (event: VoiceEvent) => void): FishTts
}

export class AppRuntime {
  private readonly deps: RuntimeDeps
  private readonly root: string
  private readonly scene: SceneHost
  private readonly store: SessionStore
  private readonly pi: PiHost
  private readonly floor: Floor
  private readonly windows = new Set<BrowserWindow>()
  private windowFocused = true
  private readonly config: Json
  private readonly speech: SpeechBridge
  private readonly tts: FishTts
  private currentSessionId = ''
  private readonly workerSessions = new Map<string, WorkerSession>()
  private workerCurrentId = ''
  private ensuring: Promise<void> | null = null
  private started = false
  private initializing: Promise<void> | null = null
  private initialized = false
  private sceneStarting: Promise<void> | null = null
  // 删除中的会话不再接受新消息（architecture §2.2 删除时序第 0 步）。
  private readonly deleting = new Set<string>()
  private readonly approvals = new Map<string, Set<string>>()
  // 首条消息的乐观标题：chat.submit 排在 session.rename 前面，在 worker 确认前不能被它发来的旧标题盖掉。
  private readonly pendingTitles = new Map<string, string>()
  private generation = 0
  private activeTurn: ActiveTurn | null = null
  private turnWatchdog: ReturnType<typeof setTimeout> | null = null
  private sceneReady = false
  private sceneToken = ''
  private readonly reloadTargets = new Set<string>()
  private reloading = false
  private workerReloading = false
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
      FISH_API_MODEL: deps.env.FISH_API_MODEL || 's2.1-pro-free',
      FISH_VOICE_ID: deps.env.FISH_VOICE_ID || '',
      JEV_API_URL: deps.env.JEV_API_URL || DEFAULT_JEV_URL,
      JEV_API_KEY: deps.env.JEV_API_KEY || '',
      JEV_MODEL: deps.env.JEV_MODEL || DEFAULT_JEV_MODEL,
      web_search_provider: deps.env.AMADEUS_SEARCH_PROVIDER || '',
      web_search_api_key: deps.env.AMADEUS_SEARCH_API_KEY || '',
      report_proactive: true,
      delegation_model: '',
      memory_enabled: true,
      memory_recall: 'log',
      mouth_gain: 8,
      mouth_silence_threshold: 0.08,
      voice_sync_offset_ms: 0,
      scene_frame_rate: 30,
      network_proxy: '',
    }
    this.pi = deps.createPi(() => this.piEnv(), event => this.onPiEvent(event))
    this.floor = new Floor({
      clock: deps.clock,
      gates: () => ({
        blocked: this.reloading || this.reloadTargets.size > 0 || this.importingEmote,
        sceneReady: this.sceneReady,
        proactive: this.config.report_proactive !== false,
        sessionId: this.currentSessionId,
        readonly: this.isLegacy(this.currentSessionId),
      }),
      turn: () => this.activeTurn,
      speechStart: () => this.speech.start(String(this.config.asr_language || 'zh-CN')),
      speechStop: () => { this.speech.stop() },
      speechFinish: manual => this.speech.finish(manual),
      deliver: report => this.deliverReport(report),
      flushReload: () => this.flushReload(),
    })
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
      if (!this.activeTurn || !sameTurn(this.activeTurn, event)) return
      this.voice(event)
      if (event.type === 'error') {
        this.activeTurn.drained = true
        this.activeTurn.speech = false
        this.markActivity()
        this.emit('tts.error', { error: event.error, diagnostic: event.diagnostic, turn_id: event.turnId })
        this.floor.pump()
      }
    })
  }

  init(): Promise<void> {
    this.initializing ??= (async () => {
      try {
        // 资源就绪校验推迟至首屏渲染时按需触发，避免阻塞主窗口创建。
        this.sceneStarting = this.scene.start()
        // worker 在第一个 await 之前 fork，才能赶在窗口创建之前起跑；它与场景服务互不依赖。
        const piStarting = this.pi.init()
        await this.sceneStarting
        this.markActivity()
        await piStarting
        // worker 没起来也不能让应用起不来；会话列表和首条消息会再试。
        await this.ensureCurrent().catch(() => {})
        this.started = true
      } finally { this.initialized = true }
    })()
    return this.initializing
  }

  attach(window: BrowserWindow): void {
    this.windows.add(window)
    window.on('closed', () => {
      this.windows.delete(window)
      this.sceneReady = false
      this.cancelTurn()
      this.floor.windowClosed()
    })
    window.webContents.on('render-process-gone', () => { void this.request('scene.lost') })
    window.on('focus', () => this.setWindowFocused(true))
    window.on('blur', () => this.setWindowFocused(false))
  }

  private setWindowFocused(focused: boolean): void {
    const previous = this.sceneFrameRate()
    this.windowFocused = focused
    if (this.sceneFrameRate() !== previous) this.emit('voice.event', { type: 'frame-rate', fps: this.sceneFrameRate() })
  }

  async request(method: string, params: Json = {}): Promise<Json> {
    // 启动完成后不再多等一个微任务，保持就绪后的调度时序与原来一致。
    if (!this.initialized && this.initializing && method !== 'wallpaper.start' && !PRE_INIT_METHODS.test(method)) await this.initializing.catch(() => {})
    if (this.workerReloading && WORKER_METHODS.test(method)) return { ok: false, error: 'Runtime reload pending' }
    switch (method) {
      case 'wallpaper.start':
        try {
          if (this.importingEmote) throw new Error('正在导入角色资源，请稍后重试')
          // 场景地址依赖本地服务端口；角色烘焙校验与 Pi 启动互不依赖，可以并行。
          await this.sceneStarting
          await this.prepareEmote()
          return { ok: true, status: 'ready', url: this.scene.url }
        } catch (error) {
          return { ok: false, status: 'error', retryable: false, error: message(error) }
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
      case 'pi.model.set': {
        if (this.reloading || this.reloadTargets.size || this.floor.busy()) return { ok: false, error: 'Wait for the current reply or reload to finish' }
        if (method === 'pi.model.set' && typeof params.model !== 'string') return { ok: false, error: 'Invalid model' }
        const sessionId = this.currentSessionId && !this.isLegacy(this.currentSessionId) ? this.currentSessionId : undefined
        const result = await this.forward(method === 'pi.models' ? 'model.list' : 'model.set', method === 'pi.models' ? { sessionId } : { sessionId, model: params.model, thinkingLevel: params.thinkingLevel })
        // 同步当前模型切换事件至前端，保持界面状态实时一致。
        if (method === 'pi.model.set' && result.ok) this.emit('pi.model', { current: result.current })
        return result
      }
      case 'session.list':
        return this.listSessions()
      case 'session.create':
        return this.createSession(params)
      case 'session.load':
        return this.loadSession(this.sessionParam(params, ''), params)
      case 'session.rename':
        return this.renameSession(this.sessionParam(params, ''), String(params.title || ''))
      case 'session.delete':
        return this.deleteSession(this.sessionParam(params, ''))
      case 'chat.send':
        return this.sendChat(params)
      case 'chat.abort':
        return this.abortChat(params)
      case 'chat.composing':
        this.floor.setComposing(params.active === true)
        return { ok: true }
      case 'task.cancel':
        return this.forward('task.cancel', { sessionId: this.sessionParam(params), taskId: String(params.taskId ?? params.task_id ?? '') })
      case 'task.approve':
        return this.forward('task.approve', {
          sessionId: this.sessionParam(params), taskId: String(params.taskId ?? params.task_id ?? ''),
          approvalId: String(params.approvalId ?? params.approval_id ?? ''), allow: params.allow === true,
        })
      case 'memory.open-folder': {
        try { mkdirSync(this.deps.memoryDir, { recursive: true, mode: 0o700 }) } catch (error) { return { ok: false, error: message(error) } }
        const error = await this.deps.shell.openPath(this.deps.memoryDir)
        return error ? { ok: false, error } : { ok: true }
      }
      case 'memory.configure':
        return this.configureMemory(params)
      case 'scene.ready':
        if (this.sceneReload && (!params.token || params.token === this.sceneToken)) return { ok: false, error: 'Stale scene handshake' }
        this.sceneToken = String(params.token || '')
        this.sceneReady = true
        // 场景重建后内部状态归零，需主动重发当前的闲置演出状态以恢复视觉表现。
        this.emit('voice.event', { type: 'conversation-idle', active: this.idleActive })
        if (this.sceneReload) this.sceneReload.resolve()
        this.floor.wake()
        return { ok: true, key: this.activeTurn ? this.key(this.activeTurn) : this.idleKey(), text: this.activeTurn?.text || '', calibration: this.calibration(), frameRate: this.sceneFrameRate() }
      case 'scene.lost':
        if (params.token && params.token !== this.sceneToken) return { ok: true }
        this.sceneReady = false
        if (!this.sceneReload) {
          // 渲染层崩溃支持独立重载恢复，不可中断或重放底层的模型推理与工具调用任务。
          this.tts.abort()
          if (this.activeTurn) {
            this.activeTurn.speech = false
            if (!this.activeTurn.drained) { this.activeTurn.drained = true; this.markActivity() }
          }
        }
        this.floor.sceneLost(Boolean(this.sceneReload))
        return { ok: true }
      case 'voice.playback':
        if (isTurnKey(params) && this.activeTurn && sameTurn(this.activeTurn, params)) this.onPlayback(params as PlaybackEvent)
        return { ok: true }
      case 'asr.start':
        return this.floor.asrStart()
      case 'asr.stop':
        this.voice({ ...(this.activeTurn ? this.key(this.activeTurn) : this.idleKey()), type: 'activity', activity: 'idle' })
        return this.floor.asrStop()
      default:
        if (method.startsWith('memory.')) return this.forward(method, params)
        return { ok: false, error: `unsupported_method:${method}` }
    }
  }

  dispose(): void {
    this.disposed = true
    this.floor.dispose()
    this.disarmWatchdog()
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
        const baked = await this.deps.ensureBakedModel('kurisu_ab_white', { baker: this.deps.emoteBaker, modelRoot: path.join(this.emoteRoot, 'models'), cacheDir: this.emoteCache })
        this.scene.setEmoteAssets(this.emoteRoot, path.dirname(baked.psb))
      })().finally(() => { this.emotePreparation = null })
    }
    return this.emotePreparation
  }

  private async importEmoteResources(): Promise<Json> {
    if (this.importingEmote || this.reloading || this.reloadTargets.size || this.floor.busy()) {
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
      const baked = await this.deps.importEmoteAssets(selection.filePaths[0], destination, { baker: this.deps.emoteBaker, cacheDir: this.emoteCache })
      this.emoteRoot = destination
      this.scene.setEmoteAssets(destination, path.dirname(baked.psb))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    } finally {
      this.importingEmote = false
      this.floor.wake()
    }
  }

  private queueReload(params: Json, development: boolean): Json {
    const targets = params.targets ?? ['pi', 'scene']
    const allowed = ['pi', 'scene', 'speech', 'pi-worker', ...(development ? ['preload', 'main'] : [])]
    if (!Array.isArray(targets) || !targets.length || targets.some(target => typeof target !== 'string' || !allowed.includes(target))) {
      return { ok: false, error: 'Invalid reload target' }
    }
    for (const target of targets) this.reloadTargets.add(target)
    this.reportReload(this.reloading ? 'applying' : 'queued', [...this.reloadTargets])
    this.floor.pump()
    return { ok: true, ...this.reloadState }
  }

  private reportReload(status: string, targets: string[], error?: string): void {
    this.reloadState = { status, targets, ...(error ? { error } : {}) }
    this.emit('runtime.reload', this.reloadState)
  }

  // 由 Floor 在每次 pump 开头调用（重载优先于汇报与开麦）；是否空闲在这里判断。
  private flushReload(): void {
    if (this.disposed || this.reloading || !this.reloadTargets.size || this.floor.busy()) return
    const targets = [...this.reloadTargets]
    this.reloadTargets.clear()
    this.reloading = true
    this.workerReloading = targets.some(target => target === 'pi' || target === 'pi-worker' || target === 'main')
    this.floor.stopMic()
    this.reportReload('applying', targets)
    void (async () => {
      if (targets.includes('main')) {
        // 退出前落盘；只在这里和替换 worker 时发 checkpoint，它会关闭全部会话库（architecture §2.2）。
        if (!this.pi.error) await this.pi.request('checkpoint').catch(() => {})
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
      this.reportReload('error', targets, message(error))
    }).finally(() => {
      this.reloading = false
      this.workerReloading = false
      this.floor.wake()
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
    if (this.floor.busy()) return
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

  // ---- 会话 ----

  private isLegacy(id: string): boolean {
    return !!id && !this.workerSessions.has(id) && this.store.sessions.some(item => item.id === id)
  }

  /** 渲染进程对同一个参数两种拼写都发过（session_id / sessionId）。 */
  private sessionParam(params: Json, fallback = this.currentSessionId): string {
    return String(params.session_id || params.sessionId || fallback)
  }

  private sessionEntries(): Json[] {
    const worker = [...this.workerSessions.values()].map(item => {
      const approvals = this.approvals.get(item.id)?.size ?? 0
      return {
        id: item.id, title: item.title, updatedAt: item.updatedAt, hasActive: item.hasActive,
        ...(item.pendingReports ? { pendingReports: item.pendingReports } : {}),
        ...(approvals ? { pendingApprovals: approvals } : {}),
      }
    })
    // 没有任何消息的旧会话只是历史上的空壳，列出来没有意义。
    const legacy = this.store.sessions
      .filter(item => item.messages.length && !this.workerSessions.has(item.id))
      .map(item => ({ id: item.id, title: item.title, readonly: true }))
    return [...worker, ...legacy]
  }

  private sessionPayload(): Json {
    const id = this.currentSessionId
    const worker = this.workerSessions.get(id)
    const legacy = worker ? undefined : this.store.sessions.find(item => item.id === id)
    const title = worker?.title ?? legacy?.title ?? DEFAULT_SESSION_TITLE
    return {
      sessions: this.sessionEntries(),
      current_session_id: id,
      session: id ? { id, title, ...(legacy ? { readonly: true } : {}) } : null,
    }
  }

  private async refreshSessions(): Promise<void> {
    const result = await this.pi.request('session.list')
    this.workerSessions.clear()
    for (const item of Array.isArray(result.sessions) ? result.sessions as Json[] : []) {
      const id = String(item?.id || '')
      if (!id) continue
      this.workerSessions.set(id, {
        id, title: this.reconcileTitle(id, String(item.title || DEFAULT_SESSION_TITLE)), updatedAt: Number(item.updatedAt) || 0,
        hasActive: item.hasActive === true, pendingReports: Number(item.pendingReports) || 0,
      })
    }
    this.workerCurrentId = String(result.currentId || '')
  }

  /** 沿用 worker 记的当前会话；没有可用的才新建，已有的不重复加载（界面马上会自己 load）。 */
  private ensureCurrent(): Promise<void> {
    if (this.currentSessionId) return Promise.resolve()
    this.ensuring ??= (async () => {
      await this.refreshSessions()
      if (this.workerCurrentId && this.workerSessions.has(this.workerCurrentId)) {
        this.currentSessionId = this.workerCurrentId
        return
      }
      const id = randomUUID()
      await this.pi.request('session.create', { sessionId: id, title: DEFAULT_SESSION_TITLE })
      await this.pi.request('session.load', { sessionId: id })
      this.currentSessionId = id
      await this.refreshSessions()
    })().finally(() => { this.ensuring = null })
    return this.ensuring
  }

  private async listSessions(): Promise<Json> {
    try {
      await this.refreshSessions()
      if (!this.currentSessionId) await this.ensureCurrent()
    } catch (error) {
      // worker 暂时不可用时仍能看到旧会话；恢复后 worker.ready 会补发 session.changed。
      return { ...this.sessionPayload(), ok: true, warning: message(error) }
    }
    return { ...this.sessionPayload(), ok: true }
  }

  /** 切走当前会话的公共部分：回合作废、草稿清零，监听意图保留（转移 9）。 */
  private leaveSession(): void {
    this.cancelTurn()
    this.floor.composing = false
  }

  private async createSession(params: Json): Promise<Json> {
    this.leaveSession()
    const id = randomUUID()
    try {
      await this.pi.request('session.create', { sessionId: id, title: String(params.title || DEFAULT_SESSION_TITLE) })
      await this.pi.request('session.load', { sessionId: id })
      await this.refreshSessions()
    } catch (error) {
      this.floor.wake()
      return { ok: false, code: codeOf(error), error: message(error) }
    }
    this.currentSessionId = id
    const payload = { ...this.sessionPayload(), messages: [], tasks: [], ok: true, client_request_id: String(params.client_request_id || ''), source: 'next' }
    this.emit('session.changed', payload)
    this.floor.wake()
    return payload
  }

  private async loadSession(id: string, params: Json = {}): Promise<Json> {
    if (!id) return { ok: false, error: 'session not found' }
    if (!this.workerSessions.has(id) && !this.isLegacy(id)) {
      await this.refreshSessions().catch(() => {})
      if (!this.workerSessions.has(id) && !this.isLegacy(id)) return { ok: false, error: 'session not found' }
    }
    this.leaveSession()
    if (this.isLegacy(id)) {
      this.currentSessionId = id
      const session = this.store.sessions.find(item => item.id === id)!
      this.floor.wake()
      return { ...this.sessionPayload(), messages: session.messages.map(item => ({ ...item, session_id: id })), tasks: [], ok: true, source: 'next' }
    }
    try {
      const loaded = await this.pi.request('session.load', { sessionId: id })
      this.currentSessionId = id
      const title = (loaded.session as Json | undefined)?.title
      const known = this.workerSessions.get(id)
      if (known && title) known.title = this.reconcileTitle(id, String(title))
      const messages = (Array.isArray(loaded.messages) ? loaded.messages as Json[] : []).map(item => ({ ...item, session_id: id, ...(item.turnId ? { turn_id: item.turnId } : {}) }))
      const pendingReports = Array.isArray(loaded.pendingReports) ? loaded.pendingReports as Json[] : []
      // 缓存只靠事件维护；打开会话时 worker 给的 pending 清单是权威的，缺的补上（Floor 按 id 去重）。
      for (const item of pendingReports) if (item?.id) this.floor.reportReady({ sessionId: id, id: String(item.id), title: String(item.title || ''), status: String(item.status || 'done') })
      this.floor.wake()
      return {
        ...this.sessionPayload(), messages, tasks: Array.isArray(loaded.tasks) ? loaded.tasks : [],
        pending_reports: pendingReports,
        ok: true, client_request_id: String(params.client_request_id || ''), source: 'next',
      }
    } catch (error) {
      this.floor.wake()
      return { ok: false, code: codeOf(error), error: codeOf(error) === 'not_found' ? 'session not found' : message(error) }
    }
  }

  private async renameSession(id: string, title: string): Promise<Json> {
    const next = title.trim()
    if (!id || !next) return { ok: false, error: 'invalid session title' }
    if (this.isLegacy(id)) return { ok: false, error: LEGACY_READONLY }
    const result = await this.forward('session.rename', { sessionId: id, title: next })
    if (result.ok) {
      this.pendingTitles.delete(id)
      this.applyTitle(id, next)
    }
    return result
  }

  private async deleteSession(id: string): Promise<Json> {
    if (!id) return { ok: false, error: 'session not found' }
    if (this.isLegacy(id)) return { ok: false, error: LEGACY_READONLY }
    this.deleting.add(id)
    if (id === this.currentSessionId || this.activeTurn?.sessionId === id) this.leaveSession()
    this.floor.dropSession(id)
    this.approvals.delete(id)
    this.pendingTitles.delete(id)
    try {
      await this.pi.request('session.delete', { sessionId: id })
      await this.refreshSessions()
    } catch (error) {
      return { ok: false, code: codeOf(error), error: message(error) }
    } finally { this.deleting.delete(id) }
    if (id !== this.currentSessionId) return { ...this.sessionPayload(), ok: true }
    // 删掉的是当前会话：换到列表里的下一个，没有就懒创建一个。
    this.currentSessionId = ''
    const next = [...this.workerSessions.keys()][0]
    if (next) {
      const loaded = await this.loadSession(next)
      this.emit('session.changed', loaded)
      return loaded
    }
    await this.ensureCurrent().catch(() => {})
    const payload = { ...this.sessionPayload(), messages: [], tasks: [], ok: true, source: 'next' }
    this.emit('session.changed', payload)
    this.floor.wake()
    return payload
  }

  private applyTitle(id: string, title: string): void {
    const known = this.workerSessions.get(id)
    if (known) known.title = title
    this.emit('session.titled', { session_id: id, title })
  }

  /** 乐观标题还没被 worker 确认时，它带来的默认标题是改名之前的旧值，不算数；其它标题说明已有定论，乐观值作废。 */
  private reconcileTitle(id: string, incoming: string): string {
    const pending = this.pendingTitles.get(id)
    if (pending === undefined) return incoming
    if (incoming === DEFAULT_SESSION_TITLE) return pending
    this.pendingTitles.delete(id)
    return incoming
  }

  // ---- 设置 ----

  // Pi 子进程在启动时从环境变量加载代理、Jev、搜索与委托模型配置，故这些变更都需重建 worker。
  private piEnv(): Record<string, string> {
    const proxy = String(this.config.network_proxy || '').trim()
    const env: Record<string, string> = proxy ? { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}
    const jevKey = String(this.config.JEV_API_KEY || '')
    if (jevKey) Object.assign(env, { AMADEUS_JEV_URL: String(this.config.JEV_API_URL), AMADEUS_JEV_MODEL: String(this.config.JEV_MODEL), AMADEUS_JEV_API_KEY: jevKey })
    const searchProvider = String(this.config.web_search_provider || '')
    const searchKey = String(this.config.web_search_api_key || '')
    if (searchProvider) env.AMADEUS_SEARCH_PROVIDER = searchProvider
    if (searchKey) env.AMADEUS_SEARCH_API_KEY = searchKey
    const delegationModel = String(this.config.delegation_model || '')
    if (delegationModel) env.AMADEUS_DELEGATION_MODEL = delegationModel
    return env
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
    if ('scene_frame_rate' in values) {
      const fps = Number(values.scene_frame_rate)
      if (!SCENE_FRAME_RATES.includes(fps as SceneFrameRate)) return { ok: false, error: `Invalid scene_frame_rate: expected one of ${SCENE_FRAME_RATES.join(', ')}` }
      values.scene_frame_rate = fps
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
    if ('JEV_API_URL' in values) {
      const url = String(values.JEV_API_URL ?? '').trim()
      let parsed: URL | null = null
      try { parsed = new URL(url) } catch { parsed = null }
      if (url && (!parsed || !['http:', 'https:'].includes(parsed.protocol))) {
        return { ok: false, error: 'Invalid JEV_API_URL: expected an http:// or https:// URL' }
      }
      values.JEV_API_URL = url || DEFAULT_JEV_URL
    }
    if ('JEV_MODEL' in values) values.JEV_MODEL = String(values.JEV_MODEL ?? '').trim() || DEFAULT_JEV_MODEL
    if (typeof values.JEV_API_KEY === 'string') values.JEV_API_KEY = values.JEV_API_KEY.trim()
    if ('web_search_provider' in values) {
      const provider = String(values.web_search_provider ?? '').trim().toLowerCase()
      if (provider && !SEARCH_PROVIDERS.includes(provider)) return { ok: false, error: `Invalid web_search_provider: expected one of ${SEARCH_PROVIDERS.join(', ')} or empty` }
      values.web_search_provider = provider
    }
    if (typeof values.web_search_api_key === 'string') values.web_search_api_key = values.web_search_api_key.trim()
    if ('delegation_model' in values) {
      const model = String(values.delegation_model ?? '').trim()
      if (model && !DELEGATION_MODEL_PATTERN.test(model)) return { ok: false, error: 'Invalid delegation_model: expected provider/model or empty' }
      values.delegation_model = model
    }
    for (const key of ['report_proactive', 'memory_enabled']) {
      if (!(key in values)) continue
      // 设置页的开关经 desktop.settings 回传时可能是字符串。
      if (values[key] === 'true' || values[key] === 'false') values[key] = values[key] === 'true'
      if (typeof values[key] !== 'boolean') return { ok: false, error: `Invalid ${key}: expected a boolean` }
    }
    if ('memory_recall' in values && !MEMORY_RECALL_MODES.includes(String(values.memory_recall))) {
      return { ok: false, error: `Invalid memory_recall: expected one of ${MEMORY_RECALL_MODES.join(', ')}` }
    }
    const previousLanguage = this.config.asr_language
    const previousProactive = this.config.report_proactive
    const previousPiEnv = JSON.stringify(this.piEnv())
    Object.assign(this.config, values)
    this.persistSettings()
    // 代理、Jev 与搜索配置变更仅在子进程边界热重启，避免破坏正在进行的语音合成与场景渲染。
    if (JSON.stringify(this.piEnv()) !== previousPiEnv) this.queueReload({ targets: ['pi-worker'] }, false)
    if (this.floor.listeningEnabled && this.config.asr_language !== previousLanguage) {
      this.floor.stopMic()
      this.floor.pump()
    }
    // 转移 17：打开主动汇报后，积压的汇报才有资格开口。
    if (this.config.report_proactive !== false && previousProactive === false) this.floor.wake()
    this.emit('system.config', { values: this.configSnapshot() })
    if (['mouth_gain', 'mouth_silence_threshold', 'voice_sync_offset_ms'].some(key => key in values)) {
      this.voice({ ...(this.activeTurn ? this.key(this.activeTurn) : this.idleKey()), type: 'calibration', calibration: this.calibration() })
    }
    if ('scene_frame_rate' in values) this.emit('voice.event', { type: 'frame-rate', fps: this.sceneFrameRate() })
    return { ok: true, values: this.configSnapshot() }
  }

  /** 开关和召回模式热生效，不经 piEnv（architecture §5）：主进程持久化，worker 每次就绪后再补发。 */
  private async configureMemory(params: Json): Promise<Json> {
    const values: Json = {}
    if ('enabled' in params) values.memory_enabled = params.enabled
    if ('recall' in params) values.memory_recall = params.recall
    if (Object.keys(values).length) {
      const result = this.setConfig(values)
      if (!result.ok) return result
    }
    const forwarded = await this.forward('memory.configure', this.memoryConfig())
    // 持久化已成功；worker 暂时不在时就绪后会补发，不算失败。
    if (!forwarded.ok && ['closed', 'worker_exit', 'timeout'].includes(String(forwarded.code))) return { ok: true, deferred: true }
    return forwarded
  }

  private memoryConfig(): Json {
    return { enabled: this.config.memory_enabled !== false, recall: this.config.memory_recall }
  }

  private desktopSettings(): Json {
    const snapshot = this.configSnapshot()
    const values = Object.fromEntries(Object.entries(snapshot).flatMap(([key, value]) => {
      if ([...SECRET_KEYS, 'FISH_VOICE_ID', 'voice_configuration', 'general_configuration', 'asr_backends'].includes(key)) return []
      return [[key, String(value ?? '')]]
    }))
    const secrets = Object.fromEntries([...SECRET_KEYS, 'FISH_VOICE_ID'].map(key => [key, { configured: Boolean(this.config[key]), source: 'user', locked: false }]))
    return { values, sources: {}, locked: {}, secrets, encryptionAvailable: this.deps.safeStorage.isEncryptionAvailable() }
  }

  private configSnapshot(): Json {
    const publicConfig = Object.fromEntries(Object.entries(this.config).filter(([key]) => !SECRET_KEYS.includes(key)))
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
            { key: 'FISH_API_MODEL', label: 'Fish model', type: 'select', value: String(this.config.FISH_API_MODEL || 's2.1-pro-free'), options: ['s2.1-pro-free', 's2-pro', 's1'], editable: true, restart_required: false },
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
          id: 'display', label: 'Display', configured: true,
          fields: [
            { key: 'scene_frame_rate', label: 'Scene frame rate (FPS)', type: 'select', value: String(this.frameRate()), options: SCENE_FRAME_RATES.map(String), editable: true },
          ],
        },
        {
          id: 'network', label: 'Network', configured: true,
          fields: [
            { key: 'network_proxy', label: 'Network proxy', type: 'text', value: String(this.config.network_proxy || ''), editable: true },
          ],
        },
        {
          id: 'delegation', label: 'Delegation', configured: true,
          fields: [
            { key: 'report_proactive', label: 'Proactive reports', type: 'boolean', value: this.config.report_proactive !== false, editable: true },
            { key: 'delegation_model', label: 'Delegation model', type: 'text', value: String(this.config.delegation_model || ''), editable: true },
          ],
        },
        {
          id: 'web_search', label: 'Web search', configured: Boolean(this.config.web_search_provider && this.config.web_search_api_key),
          fields: [
            { key: 'web_search_provider', label: 'Search provider', type: 'select', value: String(this.config.web_search_provider || ''), options: [{ value: '', label: '-' }, ...SEARCH_PROVIDERS.map(value => ({ value, label: value }))], editable: true },
            { key: 'web_search_api_key', label: 'Search API key', type: 'secret', editable: true },
          ],
        },
        {
          id: 'memory', label: 'Long-term memory (Jev)', configured: Boolean(this.config.JEV_API_KEY),
          fields: [
            { key: 'JEV_API_URL', label: 'Jev API endpoint', type: 'text', value: String(this.config.JEV_API_URL), editable: true },
            { key: 'JEV_API_KEY', label: 'Jev API key', type: 'secret', editable: true },
            { key: 'JEV_MODEL', label: 'Jev model', type: 'text', value: String(this.config.JEV_MODEL), editable: true },
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
      if (key in this.config && !SECRET_KEYS.includes(key)) this.config[key] = value
    }
    if (!this.deps.safeStorage.isEncryptionAvailable()) return
    for (const key of SECRET_KEYS) {
      const encrypted = stored[`${key}_ENCRYPTED`]
      if (typeof encrypted !== 'string') continue
      try { this.config[key] = this.deps.safeStorage.decryptString(Buffer.from(encrypted, 'base64')) } catch { /* keep environment value */ }
    }
  }

  private persistSettings(): void {
    const data: Json = Object.fromEntries(Object.entries(this.config).filter(([key]) => !SECRET_KEYS.includes(key)))
    for (const key of SECRET_KEYS) {
      if (!this.deps.safeStorage.isEncryptionAvailable() || !String(this.config[key] || '')) continue
      try { data[`${key}_ENCRYPTED`] = this.deps.safeStorage.encryptString(String(this.config[key])).toString('base64') } catch { /* keep the in-memory value */ }
    }
    this.deps.settings.write(data)
  }

  // ---- worker 通信 ----

  /** 转发给 worker 并抹掉应答封包字段；业务失败（`ok: false`）原样透传，异常转成 `{ ok: false, code, error }`。 */
  private async forward(command: string, params: Json = {}): Promise<Json> {
    try {
      const { type: _type, id: _id, ...result } = await this.pi.request(command, params)
      return result.ok === false ? result : { ok: true, ...result }
    } catch (error) {
      return { ok: false, code: codeOf(error), error: message(error) }
    }
  }

  private onPiEvent(event: Json): void {
    if (this.disposed) return
    const sessionId = String(event.sessionId || '')
    switch (event.name) {
      case 'worker.ready':
        // 待投递汇报由 worker 打开会话时重放重建，待确认已被作废（architecture §2.2 崩溃恢复第 5 步）。
        this.floor.workerUp()
        this.voidApprovals()
        void this.pi.request('memory.configure', this.memoryConfig()).catch(() => {})
        if (this.started && !this.currentSessionId) void this.recoverSessions()
        return
      case 'worker.down':
        this.floor.workerDown()
        this.voidApprovals()
        return
      case 'turn.text': case 'turn.tool': case 'turn.done': case 'turn.error': case 'turn.aborted':
        this.onTurnEvent(event)
        return
      case 'task.report-ready':
        if (sessionId && event.id) this.floor.reportReady({ sessionId, id: String(event.id), title: String(event.title || ''), status: String(event.status || 'done') })
        return
      case 'task.graph':
        this.emit('task.graph', { sessionId, tasks: Array.isArray(event.tasks) ? event.tasks : [] })
        return
      case 'task.approval-request': {
        const approvalId = String(event.approvalId || '')
        if (sessionId && approvalId) this.approvals.set(sessionId, (this.approvals.get(sessionId) ?? new Set()).add(approvalId))
        this.emit('task.approval-request', this.payload(event))
        if (!this.windowFocused) this.deps.notify('Amadeus', '有操作等待确认')
        this.emitSessionUpdated(sessionId)
        return
      }
      case 'task.approval-resolved': {
        const pending = this.approvals.get(sessionId)
        pending?.delete(String(event.approvalId || ''))
        if (pending && !pending.size) this.approvals.delete(sessionId)
        this.emit('task.approval-resolved', this.payload(event))
        this.emitSessionUpdated(sessionId)
        return
      }
      case 'session.updated': {
        if (!sessionId) return
        if (event.deleted === true) {
          this.workerSessions.delete(sessionId)
          this.floor.dropSession(sessionId)
          this.approvals.delete(sessionId)
          this.pendingTitles.delete(sessionId)
          return
        }
        const previous = this.workerSessions.get(sessionId)
        const title = this.reconcileTitle(sessionId, String(event.title || previous?.title || DEFAULT_SESSION_TITLE))
        this.workerSessions.set(sessionId, {
          id: sessionId, title, updatedAt: Number(event.updatedAt) || previous?.updatedAt || 0,
          hasActive: event.hasActive === true, pendingReports: Number(event.pendingReports) || 0,
        })
        if (previous && previous.title !== title) this.emit('session.titled', { session_id: sessionId, title })
        this.emitSessionUpdated(sessionId)
        return
      }
      case 'memory.changed':
        this.emit('memory.changed', this.payload(event))
        return
    }
  }

  /** worker 倒下或重启后，所有未决确认都不会再有人等；渲染进程靠这些事件收起卡片和徽标。 */
  private voidApprovals(): void {
    const open = [...this.approvals]
    this.approvals.clear()
    for (const [sessionId, ids] of open) {
      for (const approvalId of ids) this.emit('task.approval-resolved', { sessionId, approvalId, state: 'expired' })
      this.emitSessionUpdated(sessionId)
    }
  }

  /** 去掉封包字段，剩下的就是事件载荷。 */
  private payload(event: Json): Json {
    const { type: _type, name: _name, ...rest } = event
    return rest
  }

  private emitSessionUpdated(sessionId: string): void {
    const entry = this.sessionEntries().find(item => item.id === sessionId)
    if (entry) this.emit('session.updated', entry)
  }

  // init 时 worker 没起来、之后才就绪：补一次当前会话并通知界面同步。
  private async recoverSessions(): Promise<void> {
    try {
      await this.ensureCurrent()
      const loaded = await this.loadSession(this.currentSessionId)
      if (loaded.ok) this.emit('session.changed', loaded)
    } catch { /* 下一次 session.list 再试 */ }
  }

  // ---- 回合 ----

  private key(turn: TurnKey): TurnKey { return { sessionId: turn.sessionId, turnId: turn.turnId, generation: turn.generation } }

  private beginTurn(sessionId: string, turnId: string, kind: TurnKind): ActiveTurn {
    const turn: ActiveTurn = {
      sessionId, turnId, generation: ++this.generation, kind, piDone: false, drained: false,
      speech: this.tts.configured && this.sceneReady, text: '', parser: new PresentationText(), receivedText: false, synthesisStarted: false,
      lastEventAt: this.deps.clock.now(),
    }
    turn.drained = !turn.speech
    this.activeTurn = turn
    this.armWatchdog(turn)
    this.markActivity()
    this.voice({ ...this.key(turn), type: 'begin', speech: turn.speech, calibration: this.calibration() })
    this.voice({ ...this.key(turn), type: 'activity', activity: 'thinking' })
    return turn
  }

  private present(turn: ActiveTurn, value: ReturnType<PresentationText['push']>): void {
    if (this.activeTurn !== turn) return
    turn.text += value.display
    this.emit('chat.token', { session_id: turn.sessionId, turn_id: turn.turnId, kind: turn.kind, token: turn.text })
    this.voice({ ...this.key(turn), type: 'text', value })
    if (turn.speech && value.speech) {
      if (!turn.synthesisStarted) { this.tts.start(this.key(turn)); turn.synthesisStarted = true }
      this.tts.push(value.speech)
    }
  }

  private sendChat(params: Json): Json {
    this.markActivity()
    if (this.importingEmote) return { ok: false, error: '正在导入角色资源，请稍后重试' }
    if (this.reloading || this.reloadTargets.size) return { ok: false, error: 'Runtime reload pending; please retry after it completes' }
    const sessionId = this.sessionParam(params)
    const text = String(params.text || '').trim()
    const turnId = String(params.turn_id ?? params.turnId ?? '') || randomUUID()
    if (!sessionId) return { ok: false, error: 'session not found' }
    if (this.isLegacy(sessionId)) return { ok: false, error: LEGACY_READONLY }
    if (this.deleting.has(sessionId) || (this.workerSessions.size && !this.workerSessions.has(sessionId))) return { ok: false, error: 'session not found' }
    if (!text) return { ok: false, error: 'message is empty' }
    this.cancelTurn()
    this.floor.preempt()
    this.currentSessionId = sessionId
    const turn = this.beginTurn(sessionId, turnId, 'user')
    void this.submit(turn, text)
    // 延迟命名：首次发送消息才落时间戳，避免产生大量无内容的幽灵会话。
    const known = this.workerSessions.get(sessionId)
    if (known?.title === DEFAULT_SESSION_TITLE) {
      const title = this.deps.timestampedSessionTitle()
      this.pendingTitles.set(sessionId, title)
      this.applyTitle(sessionId, title)
      // 改名失败时退回默认标题，下一条消息再试，不让界面和索引长期不一致。
      this.pi.request('session.rename', { sessionId, title }).then(
        () => { if (this.pendingTitles.get(sessionId) === title) this.pendingTitles.delete(sessionId) },
        () => {
          if (this.pendingTitles.get(sessionId) !== title) return
          this.pendingTitles.delete(sessionId)
          if (this.workerSessions.get(sessionId)?.title === title) this.applyTitle(sessionId, DEFAULT_SESSION_TITLE)
        },
      )
    }
    return { ok: true, session_id: sessionId, turn_id: turnId }
  }

  private async submit(turn: ActiveTurn, text: string): Promise<void> {
    try {
      await this.pi.request('chat.submit', { sessionId: turn.sessionId, turnId: turn.turnId, text })
    } catch (error) {
      this.failTurn(turn, codeOf(error), message(error))
    }
  }

  /** 汇报回合（转移 17、18）：先建回合让场景进入"思考"，再向 worker 投递；没真正开始就静默作废。 */
  private deliverReport(report: PendingReport): void {
    const turnId = randomUUID()
    const turn = this.beginTurn(report.sessionId, turnId, 'report')
    const settle = (outcome: ReportOutcome) => {
      this.floor.reportResult(report, outcome)
      if (outcome !== 'started') this.discardTurn(turn)
      // 被撤回的汇报等下一次自然的 pump（别人的回合结束、闸门解除），立刻重投会违背打断者的意思。
      // deferred 在 Floor 里按退避搁置，这里的 pump 不会立刻重投。
      if (outcome !== 'aborted') this.floor.pump()
    }
    this.pi.request('report.deliver', { sessionId: report.sessionId, id: report.id, turnId }).then(reply => {
      if (reply.type === 'aborted') return settle('aborted')
      const status = String(reply.status ?? 'started')
      if (status !== 'started') return settle(status === 'already' ? 'already' : 'missing')
      const card = reply.card && typeof reply.card === 'object' ? reply.card as Json : {}
      const round = Number(card.round)
      this.emit('task.report', {
        sessionId: report.sessionId, turnId, taskId: String(card.taskId ?? ''), title: String(card.title ?? report.title),
        status: String(card.status ?? report.status), summary: String(card.summary ?? ''),
        ...(Number.isInteger(round) && round > 0 ? { round } : {}),
        ...(typeof card.question === 'string' && card.question ? { question: card.question } : {}),
      })
      settle('started')
    }, error => {
      const code = codeOf(error)
      settle(code === 'not_found' || code === 'invalid' ? 'dropped' : code === 'closed' || code === 'worker_exit' || code === 'timeout' ? 'deferred' : 'busy')
    })
  }

  // 事件密集时不逐个重置计时器：只记时刻，到点发现还没沉默够久就按剩余时间重新挂。
  private armWatchdog(turn: ActiveTurn, delay = TURN_WATCHDOG_MS): void {
    this.disarmWatchdog()
    this.turnWatchdog = this.deps.clock.setTimeout(() => {
      this.turnWatchdog = null
      if (this.disposed || this.activeTurn !== turn || turn.piDone) return
      const silent = this.deps.clock.now() - turn.lastEventAt
      if (silent < TURN_WATCHDOG_MS) return this.armWatchdog(turn, TURN_WATCHDOG_MS - silent)
      // worker 那边的回合可能还挂着：先让它放手，再按被打断收尾，Floor 才能回到空闲。
      void this.pi.abort(turn.sessionId).catch(() => {})
      this.interruptTurn(turn)
    }, delay)
  }

  private disarmWatchdog(): void {
    if (this.turnWatchdog !== null) this.deps.clock.clearTimeout(this.turnWatchdog)
    this.turnWatchdog = null
  }

  private onTurnEvent(event: Json): void {
    const turn = this.activeTurn
    if (!turn || turn.piDone || turn.sessionId !== event.sessionId || turn.turnId !== event.turnId) return
    turn.lastEventAt = this.deps.clock.now()
    switch (event.name) {
      case 'turn.text':
        turn.receivedText = true
        this.present(turn, turn.parser.push(String(event.delta || '')))
        return
      case 'turn.tool':
        this.voice({ ...this.key(turn), type: 'activity', activity: event.done === true ? 'thinking' : 'tool' })
        return
      case 'turn.done':
        this.finishTurn(turn, String(event.text || ''))
        return
      case 'turn.error':
        // worker 在 checkpoint 的宽限期后关库，会以 closed 收掉还在流式的回合：这是被打断，不该弹错误。
        if (event.code === 'closed') return this.interruptTurn(turn)
        this.failTurn(turn, String(event.code || 'failed'), String(event.error || 'Turn failed'))
        return
      case 'turn.aborted':
        // 本地取消的回合早已不是 activeTurn；走到这里说明 worker 侧自己打断了它。
        this.interruptTurn(turn)
    }
  }

  private finishTurn(turn: ActiveTurn, fullText: string): void {
    if (!turn.receivedText && fullText) this.present(turn, turn.parser.push(fullText))
    this.present(turn, turn.parser.finish())
    turn.piDone = true
    this.disarmWatchdog()
    this.markActivity()
    this.emit('chat.complete', { session_id: turn.sessionId, turn_id: turn.turnId, kind: turn.kind, full_text: turn.text })
    this.voice({ ...this.key(turn), type: 'activity', activity: 'idle' })
    if (turn.speech && turn.synthesisStarted) this.tts.finish()
    else if (turn.speech) this.voice({ ...this.key(turn), type: 'input-ended' })
    this.floor.pump()
  }

  private failTurn(turn: ActiveTurn, code: string, error: string): void {
    if (this.activeTurn !== turn || turn.piDone) return
    this.endTurn(turn)
    this.emit('chat.error', { session_id: turn.sessionId, turn_id: turn.turnId, kind: turn.kind, code, error })
    this.floor.pump()
  }

  private interruptTurn(turn: ActiveTurn): void {
    this.endTurn(turn)
    this.emit('chat.interrupted', { session_id: turn.sessionId, turn_id: turn.turnId, kind: turn.kind, text: turn.text })
    this.floor.pump()
  }

  /** 回合提前结束：停掉语音，文本不再继续。 */
  private endTurn(turn: ActiveTurn): void {
    this.disarmWatchdog()
    this.tts.abort()
    turn.piDone = true
    turn.drained = true
    this.markActivity()
    this.voice({ ...this.key(turn), type: 'reset' })
  }

  /** 汇报没有真正开始（已投递、已不存在、对话忙）：不留下空回合，也不通知界面。 */
  private discardTurn(turn: ActiveTurn): void {
    if (this.activeTurn !== turn || turn.piDone) return
    this.endTurn(turn)
  }

  private async abortChat(params: Json): Promise<Json> {
    const sessionId = this.sessionParam(params, ''), turnId = String(params.turn_id ?? params.turnId ?? '')
    if (sessionId && sessionId !== this.activeTurn?.sessionId) return { ok: true }
    if (turnId && turnId !== this.activeTurn?.turnId) return { ok: true }
    this.cancelTurn()
    this.floor.pump()
    return { ok: true }
  }

  private idleKey(): TurnKey { return { sessionId: this.currentSessionId, turnId: '', generation: this.generation } }
  private voice(event: VoiceEvent): void { this.emit('voice.event', event as unknown as Json) }
  private calibration(): Calibration {
    const number = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback
    return { mouthGain: number(this.config.mouth_gain, 8, 0, 32), silenceThreshold: number(this.config.mouth_silence_threshold, 0.08, 0, 1), syncOffsetMs: number(this.config.voice_sync_offset_ms, 0, -1000, 1000) }
  }
  private frameRate(): SceneFrameRate {
    const fps = Number(this.config.scene_frame_rate)
    return SCENE_FRAME_RATES.includes(fps as SceneFrameRate) ? fps as SceneFrameRate : 30
  }
  // 失焦时窗口多半只是挂在一旁陪伴，15fps 足以维持角色呼吸与口型，用户设得更低时仍以其为准。
  private sceneFrameRate(): SceneFrameRate {
    return this.windowFocused ? this.frameRate() : Math.min(this.frameRate(), UNFOCUSED_FRAME_RATE) as SceneFrameRate
  }
  private cancelTurn(): void {
    const turn = this.activeTurn
    this.activeTurn = null
    this.disarmWatchdog()
    this.markActivity()
    this.tts.abort()
    if (turn && !turn.piDone) {
      void this.pi.abort(turn.sessionId).catch(() => {})
      this.emit('chat.interrupted', { session_id: turn.sessionId, turn_id: turn.turnId, kind: turn.kind, text: turn.text })
    }
    this.generation++
    this.voice({ ...this.idleKey(), type: 'reset' })
  }
  private onPlayback(event: PlaybackEvent): void {
    const turn = this.activeTurn
    if (!turn) return
    if (event.type === 'ended' || event.type === 'error') {
      // 播放排空后保留 1 秒自然停顿缓冲，并防止过早开启监听引入麦克风回音。
      if (event.type === 'ended' && !turn.drained) this.floor.playbackEnded()
      turn.drained = true
      if (event.type === 'error') {
        this.tts.abort()
        turn.speech = false
        this.emit('tts.error', { error: event.error || 'Audio playback unavailable', turn_id: turn.turnId })
      }
      this.markActivity()
      this.floor.pump()
    }
  }
  private onSpeech(method: string, params: Json): void {
    if (this.disposed) return
    if (method === 'asr.recognized') {
      const text = String(params.text || '').trim()
      const verdict = this.floor.recognized(text, params.is_final === true, params.source === 'manual')
      if (verdict === 'drop') return
      if (verdict === 'turn') {
        const turnId = randomUUID()
        this.emit(method, { ...params, source: 'wake', turn_id: turnId })
        if (!this.sendChat({ text, turn_id: turnId }).ok) this.floor.pump()
        return
      }
      this.emit(method, params)
      return
    }
    this.emit(method, params)
    if (method === 'asr.status') {
      this.floor.status(String(params.status || ''), typeof params.reason === 'string' ? params.reason : undefined)
      if (params.status === 'listening') this.voice({ ...(this.activeTurn ? this.key(this.activeTurn) : this.idleKey()), type: 'activity', activity: 'listening' })
    }
  }
}
