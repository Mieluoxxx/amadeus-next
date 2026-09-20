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
const server = await createServer({ configFile: path.join(project, 'vite.renderer.config.mjs'), server: { host: '127.0.0.1', port, strictPort: true } })
const watchers = []
const pending = new Set()
let timer, nativeTimer, child, closing = false, nativeBuild = Promise.resolve()

function changed(target) {
  pending.add(target)
  clearTimeout(timer)
  timer = setTimeout(() => {
    const targets = [...pending]
    pending.clear()
    server.ws.send({ type: 'custom', event: 'salieri:reload', data: { targets } })
    console.info(`[salieri-next] built; requesting safe reload: ${targets.join(', ')}`)
  }, 150)
}

async function watchBuild(configFile, outputs) {
  const hashes = new Map()
  let resolve, reject, initialized = false
  const ready = new Promise((yes, no) => { resolve = yes; reject = no })
  const watcher = await build({
    configFile: path.join(project, configFile),
    build: { watch: {}, emptyOutDir: false },
    plugins: [{
      name: 'salieri-safe-reload',
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
  const env = { ...process.env, SALIERI_NEXT_DEV: '1', SALIERI_NEXT_DEV_URL: `http://127.0.0.1:${port}` }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, ['.'], { cwd: project, env, stdio: 'inherit' })
  child.once('error', error => { console.error(error); void close(1) })
  child.once('exit', code => {
    child = null
    if (closing) return
    if (code === 75) launch()
    else void close(code || 0)
  })
}

process.once('SIGINT', () => { void close() })
process.once('SIGTERM', () => { void close() })

try {
  await Promise.all([
    watchBuild('vite.main.config.mjs', [['dist/main/index.js', 'main'], ['dist/main/pi-worker.js', 'pi-worker']]),
    watchBuild('vite.preload.config.mjs', [['dist/preload/index.cjs', 'preload']]),
    watchBuild('vite.scene.config.mjs', [['dist/scene/scene.js', 'scene'], ['dist/scene/audio-worklet.js', 'scene']]),
    compileSpeechHelper(),
  ])
  const resourceRoots = [path.join(project, 'resources'), process.env.SALIERI_NEXT_PROJECT_ROOT, process.env.SALIERI_NEXT_CHARACTER_ROOT].filter(Boolean).map(root => path.resolve(root))
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
