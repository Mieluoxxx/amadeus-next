import type { Activity, CharacterEvent, Emotion } from '../shared/character.ts'

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

/** bake 出来的部件查表数据。 */
type PartTable = { label: string; defaultValue: number; options: { lower: number; upper: number; writes: Record<string, number> }[] }[]
/** 被摘掉的离散选择器轨道：时间线标签 → [[变量, 取值]…]。 */
type Snaps = Record<string, [string, number][]>
/** 切换表情时离散部件的补写延迟，约为头身线性过渡（350ms）的一半。 */
const SNAP_DELAY_MS = 175

/** 只用查表数据算部件显隐，语义与实验室的 partVariables 一致（已在实验室逐样例验过）。 */
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

/** 某个表情要补写的离散部件取值。 */
export function snapWrites(snaps: Snaps, label: string): [string, number][] {
  return snaps[label] ?? []
}

/** 两端各停两秒，过渡另算；这些幅度和速度保留在一处方便实景调校。 */
export const THINKING_SCAN = { head: 66.7, eye: 66.7, holdMs: 2000, transitionMs: 2000, eyeTravelMs: 3000, blendMs: 350, enterMs: 600 }
/** 默认等待上限，只防止无回复时无限冻结；正式表情不需要等满这段时间。 */
export const THINKING_HANDOFF_WAIT_MS = 30_000
const THINKING_SCAN_MODULE = 'thinking-scan'
const THINKING_ENTER_MODULE = 'thinking-enter'
/** 进入困る00 时线性过渡的连续轨道；引擎自带的 103/107 缓动会让姿态先冲后停。 */
const THINKING_ENTER_TRACKS = ['head_UD', 'head_LR', 'head_slant', 'body_LR', 'face_eye_LR', 'face_eye_UD', 'face_eyebrow']
/** 说话时的 thinking 只是一句“想一下”，超过这个时长回到普通表情，避免整段回复都是困惑脸。 */
export const SPOKEN_THINKING_MS = 2000

/** 头部停留后线性转动，眼球独立往返；阶段边界的姿态连续。 */
function thinkingScanAt(elapsedMs: number): { head: number; eye: number } {
  const span = THINKING_SCAN.holdMs + THINKING_SCAN.transitionMs
  const time = Math.max(0, elapsedMs) % (span * 2)
  const phase = time % span
  const direction = time < span ? 1 : -1
  const holding = phase < THINKING_SCAN.holdMs
  const progress = holding ? phase / THINKING_SCAN.holdMs : (phase - THINKING_SCAN.holdMs) / THINKING_SCAN.transitionMs
  // 眼球只按自身经过时间计算，头部停留或转动都不影响扫视。
  const eyeTime = Math.max(0, elapsedMs) % (THINKING_SCAN.eyeTravelMs * 2)
  const eyeProgress = (eyeTime % THINKING_SCAN.eyeTravelMs) / THINKING_SCAN.eyeTravelMs
  const eyeEased = eyeProgress * eyeProgress * (3 - 2 * eyeProgress)
  return {
    head: direction * THINKING_SCAN.head * (holding ? 1 : 1 - 2 * progress),
    eye: (eyeTime < THINKING_SCAN.eyeTravelMs ? 1 : -1) * THINKING_SCAN.eye * (2 * eyeEased - 1),
  }
}

/** Native timelines own animation; voice events only select expression and mouth energy. */
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

  /**
   * 这些轨道在 bake 时已被摘掉（选择器是离散量，时间线一帧就跳，头身却要线性走 350ms），
   * 所以由这里在过渡中点补写；连续切换时取消上一次未生效的写入。
   */
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
  /** 差分 = (1-p)·(旧姿态-当前底值)：底值仍按引擎缓动走，叠加后整体是 p 线性混合。 */
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
    // 先让原表情完成入场，避免把普通→困る的过渡直接拉到终点。
    const elapsed = now - this.thinkingSince - THINKING_SCAN.enterMs
    if (elapsed < 0) return
    const { head, eye } = thinkingScanAt(elapsed)
    this.thinkingOffsets = true
    // getVariable 读的是时间线底值，不含差分；偏移可超过 ±100，最终目标才受参数范围约束。
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
type Metadata = {
  variableMetaInfoList: { id: string; defaultValue: number }[]
  eyeControl: { enabled: boolean | number; label: string; varL: string; varR: string }[]
  customSelectorList: { enabled: boolean | number; label: string }[]
}
type ControlPlayer = Pick<Player, 'setVariable'> & { getVariable(label: string): number }

/** The old SDK does not derive modern part visibility or separate eyelids. */
export function updateEmoteControls(player: ControlPlayer, metadata: Metadata, table: PartTable): void {
  const values = Object.fromEntries(metadata.customSelectorList.filter(control => control.enabled).map(control => [control.label, player.getVariable(control.label)]))
  // The desk character uses B (crossed arms), while A/B share the same artwork pack.
  if (Object.hasOwn(values, 'arm_type')) values.arm_type = 1
  for (const [label, value] of Object.entries(partVariablesFromTable(table, values))) player.setVariable(label, value, 0)
  for (const control of metadata.eyeControl) {
    if (!control.enabled || !control.varL || !control.varR) continue
    const value = player.getVariable(control.label)
    player.setVariable(control.varL, value); player.setVariable(control.varR, value)
  }
}

/** Keep the existing Pixi room, polygon mask, subtitles and readiness surface. */
export function createEmoteRenderer() {
  const host = window as any
  const PIXI = host.PIXI
  const app = new PIXI.Application({ resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1) })
  document.getElementById('canvas-container')!.append(app.view)
  app.view.setAttribute('aria-label', '红莉栖白衣 B 实时模型场景')
  const sprite = new PIXI.Sprite()
  sprite.visible = false
  app.stage.addChild(sprite)
  // 前景的显隐由这几个状态合成：淡出静帧时它在静帧下面已经可见，淡入静帧时要等静帧盖严才隐藏。
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
  /** Enlargement over the fit that already bottoms the model out; the CRT polygon mask clips the overflow. */
  const EMOTE_ZOOM = 1.1
  const layout = () => {
    if (!viewport) return
    const scale = Math.min(viewport.width / 800, viewport.height / 600) * EMOTE_ZOOM
    sprite.width = 800 * scale; sprite.height = 600 * scale
    sprite.x = viewport.x + (viewport.width - sprite.width) / 2
    // 画布底边是平直的；略压到遮罩最低点之下，切线才只由遮罩弧线决定。
    sprite.y = viewport.y + viewport.height - sprite.height + viewport.height * 0.01
  }
  host.renderApp = {
    getPixiApp: () => app,
    _sprite: { sprite },
    setSpriteViewportBounds(bounds: Bounds) { viewport = bounds; layout() },
    setSpriteViewportMask(mask: unknown) { sprite.mask = mask },
    /** 仅切换 E-mote 前景；静帧轮播层与前景同处这一块画布，隐藏画布会连轮播一起藏掉。 */
    setForegroundVisible(visible: boolean, coveredByIdle = false) { hidden = !visible; waitForIdle = coveredByIdle; syncVisibility() },
  }
  // Pixi resizes on its next frame, after the wallpaper's window.resize listener.
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
    // 成品 PSB 与随附数据由主进程对应的解析器烤好，渲染端只取用，不再自己编 PSB。
    report('读取烘焙产物…')
    if (!assets.psbUrl || !assets.metaUrl) throw new Error('E-mote 烘焙产物尚未准备，请重试场景')
    const [psbResponse, metaResponse] = await Promise.all([fetch(assets.psbUrl), fetch(assets.metaUrl)])
    if (!psbResponse.ok || !metaResponse.ok) throw new Error('E-mote 烘焙产物缺失，请重试场景')
    const { metadata, parts, snaps } = await metaResponse.json() as { metadata: Metadata; parts: PartTable; snaps: Snaps }
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
    // ponytail: one canvas upload per frame; a shared WebGL renderer is only needed if profiling warrants it.
    app.ticker.add(() => { if (sprite.visible) sprite.texture.baseTexture.update() })
    const failed = () => {
      broken = true
      sprite.visible = false
      window.dispatchEvent(new CustomEvent('amadeus:scene-failed', { detail: 'E-mote WebGL 上下文丢失，请重新加载场景' }))
    }
    Runtime.renderCanvas.addEventListener('webglcontextlost', failed)
    app.view.addEventListener('webglcontextlost', failed)
    // This pinned runtime has broken destroy/releaseDevice methods; iframe disposal owns its heap.
    window.addEventListener('pagehide', () => { cancelAnimationFrame(Runtime.device.requestId); app.destroy(true) }, { once: true })
    host.__amadeusEmote = { model, pose: 'B', player, canvas }
    report('')
    return character
  }
}
