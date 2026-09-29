import type { Activity, CharacterEvent, Emotion } from '../shared/character.ts'

export const EMOTE_EXPRESSIONS: Record<Emotion, string> = {
  neutral: '表情_普通', thinking: '表情_困る00', serious: '表情_睨む',
  smile: '表情_笑う', sad: '表情_哀しい00', shy: '表情_照れる',
  surprise: '表情_驚き00', angry: '表情_怒る',
}

type Player = {
  mainTimelineLabel: string
  mainTimelineLabels: string[]
  setVariable(label: string, value: number, ms?: number): void
}

/** bake 出来的部件查表数据。 */
export type PartTable = { label: string; defaultValue: number; options: { lower: number; upper: number; writes: Record<string, number> }[] }[]
/** 被摘掉的离散选择器轨道：时间线标签 → [[变量, 取值]…]。 */
export type Snaps = Record<string, [string, number][]>
/** 切换表情时离散部件的补写延迟，约为头身线性过渡（350ms）的一半。 */
export const SNAP_DELAY_MS = 175

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

/** Native timelines own animation; voice events only select expression and mouth energy. */
export class EmoteCharacter {
  state = { activity: 'idle' as Activity, emotion: 'neutral' as Emotion, playback: 'quiet', label: EMOTE_EXPRESSIONS.neutral }
  private holdUntil = 0
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
  private base(): void {
    this.express(this.state.activity === 'thinking' || this.state.activity === 'tool' ? 'thinking' : 'neutral')
  }
  setMouth(value: number): void {
    this.player.setVariable('face_talk', Number.isFinite(value) ? Math.max(0, Math.min(1, value)) * 5 : 0)
  }
  dispatch(event: CharacterEvent): void {
    if (event.type === 'reset') {
      this.holdUntil = 0
      this.state.activity = 'idle'; this.state.playback = 'quiet'
      this.setMouth(0); this.base()
    } else if (event.type === 'activity') {
      if (this.state.activity === event.activity) return
      this.state.activity = event.activity
      if (['quiet', 'waiting'].includes(this.state.playback) && !this.holdUntil) this.base()
    } else if (event.type === 'cue') {
      this.express(event.emotion)
    } else if (event.type === 'playback') {
      const previous = this.state.playback
      this.state.playback = event.status === 'ended' ? 'quiet' : event.status
      if (event.status !== 'playing') this.setMouth(0)
      if (event.status === 'ended') {
        if (previous === 'playing' || previous === 'buffering') this.holdUntil = event.now + 1000
        else if (previous === 'waiting') this.base()
      } else this.holdUntil = 0
    } else if (event.type === 'tick' && this.holdUntil && event.now >= this.holdUntil) {
      this.holdUntil = 0; this.base()
    }
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
