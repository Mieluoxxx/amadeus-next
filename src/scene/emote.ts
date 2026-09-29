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

/** Native timelines own animation; voice events only select expression and mouth energy. */
export class EmoteCharacter {
  state = { activity: 'idle' as Activity, emotion: 'neutral' as Emotion, playback: 'quiet', label: EMOTE_EXPRESSIONS.neutral }
  private holdUntil = 0
  constructor(privatePlayer: Player) { this.player = privatePlayer; this.dispatch({ type: 'reset' }) }
  private player: Player

  private express(emotion: Emotion): void {
    const label = EMOTE_EXPRESSIONS[emotion]
    this.state.emotion = emotion
    this.state.label = this.player.mainTimelineLabels.includes(label) ? label : EMOTE_EXPRESSIONS.neutral
    if (this.player.mainTimelineLabel !== this.state.label) this.player.mainTimelineLabel = this.state.label
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
type PartMapper = (metadata: Metadata, values: Record<string, number>) => Record<string, number>

/** The old SDK does not derive modern part visibility or separate eyelids. */
export function updateEmoteControls(player: ControlPlayer, metadata: Metadata, partVariables: PartMapper): void {
  const values = Object.fromEntries(metadata.customSelectorList.filter(control => control.enabled).map(control => [control.label, player.getVariable(control.label)]))
  // The desk character uses B (crossed arms), while A/B share the same artwork pack.
  if (Object.hasOwn(values, 'arm_type')) values.arm_type = 1
  for (const [label, value] of Object.entries(partVariables(metadata, values))) player.setVariable(label, value, 0)
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
    setForegroundVisible(visible: boolean) { sprite.visible = visible },
  }
  // Pixi resizes on its next frame, after the wallpaper's window.resize listener.
  app.renderer.on('resize', () => host.wallpaperApp?.scene?.layout())

  return async (model: string, report: (message: string) => void): Promise<EmoteCharacter> => {
    if (!host.EmoteDriver_Initialized || !host.EmotePlayer) throw new Error('E-mote 运行时不可用，请运行 npm run assets:emote')
    const canvas = document.createElement('canvas')
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(800 * ratio); canvas.height = Math.round(600 * ratio)
    const Runtime = host.EmotePlayer
    Runtime.createRenderCanvas(canvas.width, canvas.height)
    const player = new Runtime(canvas)
    if (!Runtime.device.initialized) throw new Error('E-mote WebGL 初始化失败')
    const moduleUrl = '/emote/psb.mjs'
    const { loadModel, partVariables } = await import(/* @vite-ignore */ moduleUrl)
    if (typeof partVariables !== 'function') throw new Error('E-mote 显隐适配器已过期，请重新运行 npm run assets:emote')
    const { bytes, metadata }: { bytes: Uint8Array; metadata: Metadata } = await loadModel(model, report)
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
    const character = new EmoteCharacter(player)
    player.onUpdate = () => updateEmoteControls(player, metadata, partVariables)
    player.onUpdate()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) throw new Error('E-mote 未绘制出角色像素')
    sprite.texture = PIXI.Texture.from(canvas)
    sprite.visible = true; layout()
    // ponytail: one canvas upload per frame; a shared WebGL renderer is only needed if profiling warrants it.
    app.ticker.add(() => { if (sprite.visible) sprite.texture.baseTexture.update() })
    const failed = () => {
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
