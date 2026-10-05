import { createServer } from 'node:http'
import { readFileSync, existsSync, createReadStream, statSync, realpathSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { safeFilePath } from './pathSafety.ts'
import type { SceneInitialization } from '../shared/voice.ts'

export class SceneHost {
  private port = 0
  private initialization!: SceneInitialization
  private server = createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', this.origin)
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      response.setHeader('Cache-Control', 'no-store')
      if (url.pathname === '/next/init') {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(this.initialization))
        return
      }
      if (url.pathname === '/next/start.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end('window.dispatchEvent(new Event("amadeus:scene-ready"));')
        return
      }
      // Replace only the foreground character; background scene assets keep their existing route.
      // 烘焙产物（成品 PSB 与随附数据）由主进程写到用户目录，这里只把它挂成一个只读路由。
      const roots: [string, string][] = [
        ['/next/', this.bundle],
        ['/emote/', this.emoteRoot],
        ['/scene/stage/', path.join(this.root, 'scene/stage')],
        ['/scene/room/', path.join(this.root, 'scene/room')],
        ['/character/idle/', path.join(this.root, 'character/idle')],
        ['/ui/', path.join(this.root, 'ui')],
        ['/render/web/', existsSync(path.join(this.root, 'scene/stage')) ? path.join(this.root, 'scene/stage') : path.join(this.root, 'render/web')],
        ['/assets/idle/', existsSync(path.join(this.root, 'character/idle')) ? path.join(this.root, 'character/idle') : path.join(this.root, 'assets/idle')],
        ['/assets/images/', existsSync(path.join(this.root, 'scene/room')) ? path.join(this.root, 'scene/room') : path.join(this.root, 'assets/images')],
        ...(this.emoteCache ? [['/emote-cache/', this.emoteCache] as [string, string]] : [])
      ]
      const route = roots.find(([prefix]) => url.pathname.startsWith(prefix))
      let file = route && safeFilePath(route[1], url.pathname.slice(route[0].length))
      if (route && (!file || !existsSync(file))) {
        if (url.pathname === '/render/web/wallpaper_engine.html' && existsSync(path.join(route[1], 'index.html'))) {
          file = path.join(route[1], 'index.html')
        } else if (url.pathname === '/render/web/wallpaper_scene.js' && existsSync(path.join(route[1], 'scene.js'))) {
          file = path.join(route[1], 'scene.js')
        } else if (url.pathname === '/assets/images/amadeus_desktop_wallpaper.png' && existsSync(path.join(route[1], 'background.png'))) {
          file = path.join(route[1], 'background.png')
        } else if (url.pathname === '/assets/images/amadeus_ambient_high_blend.png' && existsSync(path.join(route[1], 'ambient_high.png'))) {
          file = path.join(route[1], 'ambient_high.png')
        } else if (url.pathname === '/assets/images/amadeus_ambient_low_blend.png' && existsSync(path.join(route[1], 'ambient_low.png'))) {
          file = path.join(route[1], 'ambient_low.png')
        } else if (url.pathname === '/assets/images/subtitle_frame_big.png' && existsSync(path.join(this.root, 'ui/subtitle_frame.png'))) {
          file = path.join(this.root, 'ui/subtitle_frame.png')
        }
      }
      if (!route || !file || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end('not found'); return }
      const real = path.relative(realpathSync(route[1]), realpathSync(file))
      if (real.startsWith('..') || path.isAbsolute(real)) { response.writeHead(403); response.end(); return }
      const mime: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' }
      response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
      const stream = createReadStream(file)
      stream.on('error', () => response.destroy())
      stream.pipe(response)
    } catch { response.writeHead(500); response.end('Scene asset unavailable') }
  })

  private root: string
  private bundle: string
  private emoteCache: string | null
  private emoteRoot: string
  private bakedUrls: { psbUrl: string; metaUrl: string } | undefined
  constructor(root: string, bundle: string, emoteCache: string | null = null) {
    this.root = root
    this.bundle = bundle
    this.emoteCache = emoteCache
    this.emoteRoot = existsSync(path.join(root, 'character/emote')) ? path.join(root, 'character/emote') : path.join(root, 'emote')
  }
  setEmoteAssets(root: string, cache: string): void {
    if (!this.emoteCache) throw new Error('Scene cache root is not configured')
    const relative = path.relative(this.emoteCache, cache)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Scene cache is outside its root')
    const prefix = '/emote-cache/' + relative.split(path.sep).map(encodeURIComponent).join('/')
    this.emoteRoot = root
    this.bakedUrls = { psbUrl: `${prefix}/kurisu_ab_white.psb`, metaUrl: `${prefix}/kurisu_ab_white.meta.json` }
    if (this.initialization) this.initialization.character = { renderer: 'emote', model: 'kurisu_ab_white', ...this.bakedUrls }
  }
  get origin(): string { return `http://127.0.0.1:${this.port}` }
  get url(): string {
    return existsSync(path.join(this.root, 'scene/stage/index.html'))
      ? `${this.origin}/scene/stage/index.html`
      : `${this.origin}/render/web/wallpaper_engine.html`
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
    this.reload()
  }
  reload(): void {
    let crtConfig: unknown = { img_size: [1672, 941], crt_corners: [[556, 629], [560, 199], [1127, 204], [1132, 630]] }
    const crtConfigPath = existsSync(path.join(this.root, 'scene/room/crt_config.json'))
      ? path.join(this.root, 'scene/room/crt_config.json')
      : path.join(this.root, 'wallpaper/crt_config.json')
    try { crtConfig = JSON.parse(readFileSync(crtConfigPath, 'utf8')) } catch (error) {
      if (this.initialization) throw error // Retain the last usable scene on an incomplete file save.
    }
    const cfg = crtConfig as { img_size?: unknown; crt_corners?: unknown } | null
    const point = (value: unknown): value is number[] => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    if (this.initialization && (!cfg || !point(cfg.img_size) || cfg.img_size.some(value => value <= 0) || !Array.isArray(cfg.crt_corners) || cfg.crt_corners.length !== 4 || !cfg.crt_corners.every(point))) {
      throw new Error('Invalid CRT geometry; keeping the previous scene')
    }
    const idleUrls = (() => {
      const hasDomainIdle = existsSync(path.join(this.root, 'character/idle'))
      const idleDir = hasDomainIdle ? path.join(this.root, 'character/idle') : path.join(this.root, 'assets/idle')
      const routePrefix = hasDomainIdle ? 'character/idle' : 'assets/idle'
      try {
        return readdirSync(idleDir).filter(name => name.endsWith('.png')).sort()
          .map(name => `${this.origin}/${routePrefix}/${name}`)
      } catch { return [] }
    })()
    const backgroundUrl = existsSync(path.join(this.root, 'scene/room/background.png'))
      ? `${this.origin}/scene/room/background.png`
      : `${this.origin}/assets/images/amadeus_desktop_wallpaper.png`
    const ambientUrl = existsSync(path.join(this.root, 'scene/room/ambient_high.png'))
      ? `${this.origin}/scene/room/ambient_high.png`
      : `${this.origin}/assets/images/amadeus_ambient_high_blend.png`
    const ambientLowUrl = existsSync(path.join(this.root, 'scene/room/ambient_low.png'))
      ? `${this.origin}/scene/room/ambient_low.png`
      : `${this.origin}/assets/images/amadeus_ambient_low_blend.png`
    const subtitleFrameUrl = existsSync(path.join(this.root, 'ui/subtitle_frame.png'))
      ? `${this.origin}/ui/subtitle_frame.png`
      : `${this.origin}/assets/images/subtitle_frame_big.png`

    this.initialization = {
      character: { renderer: 'emote', model: 'kurisu_ab_white', ...this.bakedUrls },
      scene: {
        backgroundUrl,
        ambientUrl,
        ambientLowUrl,
        subtitleFrameUrl,
        idleUrls,
        crtConfig,
      },
    }
  }
  close(): void { this.server.closeAllConnections(); this.server.close() }
}
