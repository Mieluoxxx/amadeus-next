import { createServer } from 'node:http'
import { readFileSync, existsSync, createReadStream, statSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { safeFilePath } from './pathSafety.ts'
import { loadCharacter } from './characterPack.ts'
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
        response.end('window.dispatchEvent(new Event("salieri:scene-ready"));')
        return
      }
      const roots: [string, string][] = [['/next/', this.bundle], ['/character/', this.characterRoot], ['/render/web/', path.join(this.root, 'render/web')], ['/assets/', path.join(this.root, 'assets')]]
      const route = roots.find(([prefix]) => url.pathname.startsWith(prefix))
      const file = route && safeFilePath(route[1], url.pathname.slice(route[0].length))
      if (!route || !file || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end('not found'); return }
      const real = path.relative(realpathSync(route[1]), realpathSync(file))
      if (real.startsWith('..') || path.isAbsolute(real)) { response.writeHead(403); response.end(); return }
      const mime: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }
      response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
      const stream = createReadStream(file)
      stream.on('error', () => response.destroy())
      stream.pipe(response)
    } catch { response.writeHead(500); response.end('Scene asset unavailable') }
  })

  private root: string
  private bundle: string
  private characterRoot: string
  constructor(root: string, bundle: string) {
    this.root = root
    this.bundle = bundle
    this.characterRoot = process.env.SALIERI_NEXT_CHARACTER_ROOT || path.join(root, 'assets/spriteforge/runtime/kurisu')
  }
  get origin(): string { return `http://127.0.0.1:${this.port}` }
  get url(): string { return `${this.origin}/render/web/wallpaper_engine.html` }
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
    try { crtConfig = JSON.parse(readFileSync(path.join(this.root, 'wallpaper/crt_config.json'), 'utf8')) } catch (error) {
      if (this.initialization) throw error // Retain the last usable scene on an incomplete file save.
    }
    const cfg = crtConfig as { img_size?: unknown; crt_corners?: unknown } | null
    const point = (value: unknown): value is number[] => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    if (this.initialization && (!cfg || !point(cfg.img_size) || cfg.img_size.some(value => value <= 0) || !Array.isArray(cfg.crt_corners) || cfg.crt_corners.length !== 4 || !cfg.crt_corners.every(point))) {
      throw new Error('Invalid CRT geometry; keeping the previous scene')
    }
    const definition = loadCharacter(this.characterRoot, `${this.origin}/character/`)
    if (this.initialization?.definition.nodes[this.initialization.definition.root] && !definition.nodes[definition.root]) {
      throw new Error('Character reload rejected: no usable idle clip; keeping the previous scene')
    }
    this.initialization = {
      definition,
      scene: {
        backgroundUrl: `${this.origin}/assets/images/amadeus_desktop_wallpaper.png`,
        ambientUrl: `${this.origin}/assets/images/amadeus_ambient_high_blend.png`,
        ambientLowUrl: `${this.origin}/assets/images/amadeus_ambient_low_blend.png`,
        subtitleFrameUrl: `${this.origin}/assets/images/subtitle_frame_big.png`,
        crtConfig,
      },
    }
  }
  close(): void { this.server.closeAllConnections(); this.server.close() }
}
