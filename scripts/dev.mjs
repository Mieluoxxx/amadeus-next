import { build, createServer } from 'vite'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { compileSpeechHelper } from './build.mjs'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || 5199)
// macOS 原生文件事件不可用时，Rolldown 可能在首次构建写入前静默结束。
const polling = process.env.CHOKIDAR_USEPOLLING?.toLowerCase()
const watchOptions = { usePolling: polling === undefined ? process.platform === 'darwin' : ['1', 'true'].includes(polling), interval: 100 }
const server = await createServer({ configFile: path.join(project, 'vite/renderer.config.mjs'), server: { host: '127.0.0.1', port, strictPort: true, watch: watchOptions } })
const watchers = []
const pending = new Set()
let timer, nativeTimer, child, closing = false, nativeBuild = Promise.resolve()

function changed(target) {
  pending.add(target)
  clearTimeout(timer)
  timer = setTimeout(() => {
    const targets = [...pending]
    pending.clear()
    server.ws.send({ type: 'custom', event: 'amadeus:reload', data: { targets } })
    console.info(`[amadeus-next] built; requesting safe reload: ${targets.join(', ')}`)
  }, 150)
}

async function watchBuild(configFile, outputs) {
  const hashes = new Map()
  let resolve, reject, initialized = false
  const ready = new Promise((yes, no) => { resolve = yes; reject = no })
  const watcher = await build({
    configFile: path.join(project, configFile),
    // Vite 8 的构建监听走原生 watcher，不会自动读取 Chokidar 的环境开关。
    build: { watch: { chokidar: watchOptions }, emptyOutDir: false },
    plugins: [{
      name: 'amadeus-safe-reload',
      async writeBundle() {
        for (const [file, target] of outputs) {
          const hash = createHash('sha256').update(await readFile(path.join(project, file))).digest('hex')
          if (hashes.has(file) && hashes.get(file) !== hash) changed(target)
          hashes.set(file, hash)
        }
        initialized = true
        resolve()
      },
    }],
  })
  watchers.push(watcher)
  watcher.on('event', event => {
    if (event.code === 'END' && !initialized) reject(new Error('初始监听构建没有产物；文件事件不可用时请使用 CHOKIDAR_USEPOLLING=1 npm run dev'))
    if (event.code !== 'ERROR') return
    console.error(event.error)
    if (!initialized) reject(event.error)
  })
  await ready
}

async function close(code = 0) {
  if (closing) return
  closing = true
  clearTimeout(timer)
  clearTimeout(nativeTimer)
  child?.kill()
  await Promise.allSettled([...watchers.map(watcher => watcher.close()), server.close(), nativeBuild])
  process.exitCode = code
}

function launch() {
  const env = { ...process.env, AMADEUS_NEXT_DEV: '1', AMADEUS_NEXT_DEV_URL: `http://127.0.0.1:${port}` }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, ['.'], { cwd: project, env, stdio: 'inherit' })
  child.once('error', error => { console.error(error); void close(1) })
  child.once('exit', (code, signal) => {
    child = null
    if (closing) return
    if (code === 75) launch()
    else { if (signal) console.error(`Electron exited with ${signal}`); void close(code ?? (signal ? 1 : 0)) }
  })
}

process.once('SIGINT', () => { void close() })
process.once('SIGTERM', () => { void close() })

try {
  await Promise.all([
    watchBuild('vite/main.config.mjs', [['dist/main/index.js', 'main'], ['dist/main/pi-worker.js', 'pi-worker']]),
    // runner 的哈希在 worker 启动时计算，所以它变了要重载 worker。
    watchBuild('vite/runner.config.mjs', [['dist/runner/amadeus-runner.mjs', 'pi-worker']]),
    watchBuild('vite/preload.config.mjs', [['dist/preload/index.cjs', 'preload']]),
    watchBuild('vite/scene.config.mjs', [['dist/scene/scene.js', 'scene'], ['dist/scene/audio-worklet.js', 'scene']]),
    compileSpeechHelper(),
  ])
  const resourceRoots = [path.join(project, 'resources'), process.env.AMADEUS_NEXT_PROJECT_ROOT].filter(Boolean).map(root => path.resolve(root))
  server.watcher.add([...resourceRoots, path.join(project, 'native')])
  server.watcher.on('all', (event, file) => {
    if (closing || !['add', 'change', 'unlink'].includes(event)) return
    if (resourceRoots.some(root => file.startsWith(root + path.sep))) changed('scene')
    if (file === path.join(project, 'native/SpeechRecognizer.swift') || file === path.join(project, 'native/Info.plist')) {
      clearTimeout(nativeTimer)
      nativeTimer = setTimeout(() => {
        nativeBuild = nativeBuild.then(compileSpeechHelper).then(() => { if (!closing) changed('speech') }).catch(console.error)
      }, 150)
    }
  })
  await server.listen()
  server.printUrls()
  if (!process.argv.includes('--server-only')) launch()
} catch (error) {
  console.error(error)
  await close(1)
}
