import type { Activity, CharacterEvent, Emotion } from '../shared/character.ts'
import type { EmoteMeta, EmoteMetadata, Snaps } from '../shared/emote/bake.ts'
import type { PartTable } from '../shared/emote/parts.ts'

export const EMOTE_EXPRESSIONS: Record<Emotion, string> = {
  neutral: '表情_普通', thinking: '表情_困る00', serious: '表情_睨む',
  smile: '表情_笑う', sad: '表情_哀しい00', shy: '表情_照れる',
  surprise: '表情_驚き00', angry: '表情_怒る',
}

type Player = {
  mainTimelineLabel: string
  mainTimelineLabels: string[]
  getVariable(label: string): number
  setVariable(label: string, value: number, ms?: number): void
  setVariableDiff(module: string, label: string, value: number, ms?: number): void
}

/** 提取离散轨道延迟写入（延后 175ms），避免与头身 350ms 线性过渡产生跳变撕裂。 */
const SNAP_DELAY_MS = 175

/** 基于查表映射计算部件显隐，与模型原始规则保持语义一致。 */
export function partVariablesFromTable(table: PartTable, values: Record<string, number>): Record<string, number> {
  for (const label of Object.keys(values)) {
    if (!table.some((selector) => selector.label === label)) throw Object.assign(new Error('error.partControlUnsupported'), { label })
  }
  const result: Record<string, number> = {}
  for (const selector of table) {
    const value = values[selector.label] ?? selector.defaultValue
    const hits = selector.options.filter((option) => value >= option.lower && value <= option.upper)
    if (!Number.isFinite(value) || hits.length !== 1) throw Object.assign(new Error('error.partControlRange'), { label: selector.label, value })
    Object.assign(result, hits[0].writes)
    result[selector.label] = value
  }
  return result
}

export function snapWrites(snaps: Snaps, label: string): [string, number][] {
  return snaps[label] ?? []
}

/** 思考状态视线往复扫描参数：保持眼球运动与头部姿态独立平滑。 */
export const THINKING_SCAN = { head: 66.7, eye: 66.7, holdMs: 2000, transitionMs: 2000, eyeTravelMs: 3000, blendMs: 350, enterMs: 600 }
/** 默认等待上限，防止无回复时无限冻结。 */
export const THINKING_HANDOFF_WAIT_MS = 30_000
const THINKING_SCAN_MODULE = 'thinking-scan'
const THINKING_ENTER_MODULE = 'thinking-enter'
const THINKING_ENTER_TRACKS = ['head_UD', 'head_LR', 'head_slant', 'body_LR', 'face_eye_LR', 'face_eye_UD', 'face_eyebrow']
/** 思考超时退回平静表情，避免整段回复始终保持困惑神态。 */
export const SPOKEN_THINKING_MS = 2000

function thinkingScanAt(elapsedMs: number): { head: number; eye: number } {
  const span = THINKING_SCAN.holdMs + THINKING_SCAN.transitionMs
  const time = Math.max(0, elapsedMs) % (span * 2)
  const phase = time % span
  const direction = time < span ? 1 : -1
  const holding = phase < THINKING_SCAN.holdMs
  const progress = holding ? phase / THINKING_SCAN.holdMs : (phase - THINKING_SCAN.holdMs) / THINKING_SCAN.transitionMs
  // 眼球扫描完全由独立时间线驱动，解耦头部摆动的停顿与转向影响。
  const eyeTime = Math.max(0, elapsedMs) % (THINKING_SCAN.eyeTravelMs * 2)
  const eyeProgress = (eyeTime % THINKING_SCAN.eyeTravelMs) / THINKING_SCAN.eyeTravelMs
  const eyeEased = eyeProgress * eyeProgress * (3 - 2 * eyeProgress)
  return {
    head: direction * THINKING_SCAN.head * (holding ? 1 : 1 - 2 * progress),
    eye: (eyeTime < THINKING_SCAN.eyeTravelMs ? 1 : -1) * THINKING_SCAN.eye * (2 * eyeEased - 1),
  }
}

/** 动画由底层时间线自主驱动，外部语音事件仅选择表情基调与口型能量。 */
export class EmoteCharacter {
  state = { activity: 'idle' as Activity, emotion: 'neutral' as Emotion, playback: 'quiet', label: EMOTE_EXPRESSIONS.neutral }
  private holdUntil = 0
  private waitingForSpeech = false
  private waitingSince: number | null = null
  private thinkingSince: number | null = null
  private thinkingOffsets = false
  private entering: { since: number | null; from: Map<string, number> } | null = null
  private spokenThinkingSince: number | null = null
  private snapTimer: ReturnType<typeof setTimeout> | null = null
  private snaps: Snaps
  private snapDelayMs: number
  constructor(privatePlayer: Player, snaps: Snaps = {}, snapDelayMs = SNAP_DELAY_MS) {
    this.player = privatePlayer
    this.snaps = snaps
    this.snapDelayMs = snapDelayMs
    this.dispatch({ type: 'reset' })
  }
  private player: Player

  private express(emotion: Emotion): void {
    const label = EMOTE_EXPRESSIONS[emotion]
    this.state.emotion = emotion
    this.state.label = this.player.mainTimelineLabels.includes(label) ? label : EMOTE_EXPRESSIONS.neutral
    if (this.player.mainTimelineLabel !== this.state.label) {
      this.stopThinkingScan()
      this.stopEntering()
      if (this.state.label === EMOTE_EXPRESSIONS.thinking) {
        this.entering = { since: null, from: new Map(THINKING_ENTER_TRACKS.map(name => [name, this.player.getVariable(name)])) }
      }
      this.player.mainTimelineLabel = this.state.label
      this.applySnaps()
    }
  }

  /** 离散选择器在过渡中点补写，防止模型姿态尚未到位时部件过早突变。 */
  private applySnaps(): void {
    if (this.snapTimer) clearTimeout(this.snapTimer)
    const label = this.state.label
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null
      for (const [name, value] of snapWrites(this.snaps, label)) this.player.setVariable(name, value, 0)
    }, this.snapDelayMs)
  }
  private stopEntering(): void {
    if (!this.entering) return
    this.entering = null
    for (const name of THINKING_ENTER_TRACKS) this.player.setVariableDiff(THINKING_ENTER_MODULE, name, 0, 0)
  }
  /** 动态叠加插值差分，保证在引擎内置缓动曲线生效时姿态切换仍呈现平滑过渡。 */
  private updateEntering(now: number): void {
    if (!this.entering) return
    this.entering.since ??= now
    const progress = Math.min(1, (now - this.entering.since) / THINKING_SCAN.enterMs)
    if (progress >= 1) { this.stopEntering(); return }
    for (const [name, from] of this.entering.from) {
      this.player.setVariableDiff(THINKING_ENTER_MODULE, name, (1 - progress) * (from - this.player.getVariable(name)), 0)
    }
  }
  private stopThinkingScan(releaseOffsets = true): void {
    this.thinkingSince = null
    if (!releaseOffsets || !this.thinkingOffsets) return
    this.thinkingOffsets = false
    for (const name of ['head_UD', 'face_eye_LR']) this.player.setVariableDiff(THINKING_SCAN_MODULE, name, 0, THINKING_SCAN.blendMs)
  }
  private canThinkingScan(): boolean {
    return this.state.label === EMOTE_EXPRESSIONS.thinking && (this.state.activity === 'thinking' || this.state.activity === 'tool')
      && ['quiet', 'waiting'].includes(this.state.playback) && !this.waitingForSpeech
  }
  private updateThinkingScan(now: number): void {
    if (!this.canThinkingScan()) {
      this.stopThinkingScan(!this.waitingForSpeech)
      if (this.waitingForSpeech) {
        this.waitingSince ??= now
        if (now - this.waitingSince >= THINKING_HANDOFF_WAIT_MS) {
          this.waitingForSpeech = false
          this.stopThinkingScan(); this.base()
        }
      }
      return
    }
    this.thinkingSince ??= now
    // 留足入场过渡时间，避免思考动画打断前序表情的完整展示。
    const elapsed = now - this.thinkingSince - THINKING_SCAN.enterMs
    if (elapsed < 0) return
    const { head, eye } = thinkingScanAt(elapsed)
    this.thinkingOffsets = true
    // 差分基准使用未修饰的时间线底值，防止多层偏移叠加导致数值漂移。
    this.player.setVariableDiff(THINKING_SCAN_MODULE, 'head_UD', head - this.player.getVariable('head_UD'), 0)
    this.player.setVariableDiff(THINKING_SCAN_MODULE, 'face_eye_LR', eye - this.player.getVariable('face_eye_LR'), 0)
  }
  private base(): void {
    this.express(this.state.activity === 'thinking' || this.state.activity === 'tool' ? 'thinking' : 'neutral')
  }
  setMouth(value: number): void {
    this.player.setVariable('face_talk', Number.isFinite(value) ? Math.max(0, Math.min(1, value)) * 5 : 0)
  }
  dispatch(event: CharacterEvent): void {
    if (event.type === 'reset') {
      this.stopEntering()
      this.stopThinkingScan()
      this.holdUntil = 0
      this.waitingForSpeech = false
      this.state.activity = 'idle'; this.state.playback = 'quiet'
      this.setMouth(0); this.base()
    } else if (event.type === 'activity') {
      if (this.state.activity === event.activity) return
      this.state.activity = event.activity
      if (event.activity !== 'idle') {
        if (this.waitingForSpeech) this.stopThinkingScan()
        this.waitingForSpeech = false
      }
      if (this.state.playback === 'waiting') {
        if (event.activity === 'idle' && this.state.emotion === 'thinking') this.waitingForSpeech = true
        else this.base()
      } else if (this.state.playback === 'quiet' && !this.holdUntil) this.base()
    } else if (event.type === 'cue') {
      if (this.waitingForSpeech) this.stopThinkingScan()
      this.waitingForSpeech = false
      this.spokenThinkingSince = null
      this.express(event.emotion)
    } else if (event.type === 'playback') {
      const previous = this.state.playback
      this.state.playback = event.status === 'ended' ? 'quiet' : event.status
      if (['playing', 'buffering'].includes(event.status) && this.waitingForSpeech) { this.waitingForSpeech = false; this.base() }
      if (event.status !== 'playing') this.setMouth(0)
      if (event.status === 'ended') {
        this.waitingForSpeech = false
        if (previous === 'playing' || previous === 'buffering') this.holdUntil = event.now + 1000
        else if (previous === 'waiting') this.base()
      } else this.holdUntil = 0
    } else if (event.type === 'tick') {
      if (this.holdUntil && event.now >= this.holdUntil) { this.holdUntil = 0; this.base() }
      if (this.state.emotion === 'thinking' && this.state.activity !== 'thinking' && ['playing', 'buffering'].includes(this.state.playback)) {
        this.spokenThinkingSince ??= event.now
        if (event.now - this.spokenThinkingSince >= SPOKEN_THINKING_MS) { this.spokenThinkingSince = null; this.express('neutral') }
      } else this.spokenThinkingSince = null
      this.updateEntering(event.now)
      this.updateThinkingScan(event.now)
    }
    if (!this.waitingForSpeech) this.waitingSince = null
    if (!this.canThinkingScan()) this.stopThinkingScan(!this.waitingForSpeech)
  }
}

type Bounds = { x: number; y: number; width: number; height: number }
type ControlPlayer = Pick<Player, 'setVariable'> & { getVariable(label: string): number }

/** 适配早期 SDK 缺乏复合部件推导与眼睑分离计算的问题。 */
export function updateEmoteControls(player: ControlPlayer, metadata: EmoteMetadata, table: PartTable): void {
  const values = Object.fromEntries(metadata.customSelectorList.filter(control => control.enabled).map(control => [control.label, player.getVariable(control.label)]))
  // 强制选定白衣 B 姿态（抱胸立绘），复用共享资源包。
  if (Object.hasOwn(values, 'arm_type')) values.arm_type = 1
  for (const [label, value] of Object.entries(partVariablesFromTable(table, values))) player.setVariable(label, value, 0)
  for (const control of metadata.eyeControl) {
    if (!control.enabled || !control.varL || !control.varR) continue
    const value = player.getVariable(control.label)
    player.setVariable(control.varL, value); player.setVariable(control.varR, value)
  }
}

/** 承接底层 Pixi 舞台、遮罩与字幕对齐容器。 */
export function createEmoteRenderer() {
  const host = window as any
  const PIXI = host.PIXI
  const app = new PIXI.Application({ resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) })
  document.getElementById('canvas-container')!.append(app.view)
  app.view.setAttribute('aria-label', '红莉栖白衣 B 实时模型场景')
  const sprite = new PIXI.Sprite()
  sprite.visible = false
  app.stage.addChild(sprite)
  // 前景与闲置静帧采用层叠交叉淡入淡出，防止过渡过程中出现背景透光或黑屏闪烁。
  let loaded = false
  let broken = false
  let hidden = false
  let waitForIdle = false
  const syncVisibility = () => {
    const covered = !waitForIdle || host.wallpaperApp?.scene?.idleOpaque?.() === true
    sprite.visible = loaded && !broken && !(hidden && covered)
  }
  app.ticker.add(syncVisibility)
  let viewport: Bounds | null = null
  /** 微调放大比例配合 CRT 遮罩，消除底部空隙并裁切边缘溢出。 */
  const EMOTE_ZOOM = 1.1
  const layout = () => {
    if (!viewport) return
    const scale = Math.min(viewport.width / 800, viewport.height / 600) * EMOTE_ZOOM
    sprite.width = 800 * scale; sprite.height = 600 * scale
    sprite.x = viewport.x + (viewport.width - sprite.width) / 2
    // 略微压过遮罩底边，确保下边缘由 CRT 弧形遮罩决定，避免漏出画布直边。
    sprite.y = viewport.y + viewport.height - sprite.height + viewport.height * 0.01
  }
  host.renderApp = {
    getPixiApp: () => app,
    _sprite: { sprite },
    setSpriteViewportBounds(bounds: Bounds) { viewport = bounds; layout() },
    setSpriteViewportMask(mask: unknown) { sprite.mask = mask },
    /** 单独控制前景 Sprite 可见性，避免隐藏画布连同底层的静帧轮播一起清空。 */
    setForegroundVisible(visible: boolean, coveredByIdle = false) { hidden = !visible; waitForIdle = coveredByIdle; syncVisibility() },
  }
  // 监听渲染器尺寸变化，保证窗口缩放后场景布局同步对齐。
  app.renderer.on('resize', () => host.wallpaperApp?.scene?.layout())

  return async (model: string, report: (message: string) => void, assets: { psbUrl?: string; metaUrl?: string }): Promise<EmoteCharacter> => {
    if (!host.EmoteDriver_Initialized || !host.EmotePlayer) throw new Error('E-mote 运行时不可用，请运行 npm run assets:emote')
    const canvas = document.createElement('canvas')
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(800 * ratio); canvas.height = Math.round(600 * ratio)
    const Runtime = host.EmotePlayer
    Runtime.createRenderCanvas(canvas.width, canvas.height)
    const player = new Runtime(canvas)
    if (!Runtime.device.initialized) throw new Error('E-mote WebGL 初始化失败')
    // 渲染端仅加载主进程烘焙好的静态二进制与元数据，降低前端编解码开销。
    report('读取烘焙产物…')
    if (!assets.psbUrl || !assets.metaUrl) throw new Error('E-mote 烘焙产物尚未准备，请重试场景')
    const [psbResponse, metaResponse] = await Promise.all([fetch(assets.psbUrl), fetch(assets.metaUrl)])
    if (!psbResponse.ok || !metaResponse.ok) throw new Error('E-mote 烘焙产物缺失，请重试场景')
    const { metadata, parts, snaps } = await metaResponse.json() as EmoteMeta
    const bytes = new Uint8Array(await psbResponse.arrayBuffer())
    player.loadData(bytes)
    if (!player.playerId || !player.isCharaProfileAvailable) throw new Error('E-mote 无法识别白衣 A/B 模型')
    for (const variable of metadata.variableMetaInfoList) {
      if (!variable.id.startsWith('fade_')) player.setVariable(variable.id, variable.defaultValue, 0)
    }
    const bounds = player.charaBounds
    const bottom = bounds.top + (bounds.bottom - bounds.top) * 0.42
    const scale = Math.min(canvas.width / (bounds.right - bounds.left), canvas.height / (bottom - bounds.top)) * 0.94
    player.setScale(scale, 0)
    player.setCoord(-(bounds.left + bounds.right) / 2 * scale, -(bounds.top + bottom) / 2 * scale, 0)
    const character = new EmoteCharacter(player, snaps)
    player.onUpdate = () => updateEmoteControls(player, metadata, parts)
    player.onUpdate()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) throw new Error('E-mote 未绘制出角色像素')
    sprite.texture = PIXI.Texture.from(canvas)
    loaded = true; syncVisibility(); layout()
    // 每帧仅同步一次 Canvas 纹理，平衡渲染性能与资源占用。
    app.ticker.add(() => { if (sprite.visible) sprite.texture.baseTexture.update() })
    const failed = () => {
      broken = true
      sprite.visible = false
      window.dispatchEvent(new CustomEvent('amadeus:scene-failed', { detail: 'E-mote WebGL 上下文丢失，请重新加载场景' }))
    }
    Runtime.renderCanvas.addEventListener('webglcontextlost', failed)
    app.view.addEventListener('webglcontextlost', failed)
    // 依赖 iframe 卸载回收 WebGL 堆内存，规避老旧 SDK 内部内存释放接口缺陷。
    window.addEventListener('pagehide', () => { cancelAnimationFrame(Runtime.device.requestId); app.destroy(true) }, { once: true })
    host.__amadeusEmote = { model, pose: 'B', player, canvas }
    report('')
    return character
  }
}
