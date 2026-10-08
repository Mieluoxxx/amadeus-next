import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, cp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import path from 'node:path'
import WebSocket from 'ws'

// 位于仓库内即可按 Node 规则解析祖先 node_modules；资源和加载器仍是独立副本。
await mkdir('temp', { recursive: true })
const root = await mkdtemp(path.resolve('temp/amadeus-dev-'))
const project = path.join(root, 'project')
const assets = path.join(root, 'assets')
await mkdir(project)
await mkdir(assets)
for (const name of ['src', 'scripts', 'native', 'resources', 'package.json', 'index.html', 'vite.main.config.mjs', 'vite.renderer.config.mjs', 'vite.preload.config.mjs', 'vite.scene.config.mjs']) {
  await cp(path.resolve(name), path.join(project, name), { recursive: true })
}
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const child = spawn(process.execPath, ['scripts/dev.mjs', '--server-only', `--port=${port}`], {
  cwd: project, env: { ...process.env, AMADEUS_NEXT_PROJECT_ROOT: assets }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = '', socket
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { output += chunk })
const wait = async (probe, label) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`Dev process exited: ${output}`)
    const result = await probe()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${label}\n${output}`)
}
const deadline = setTimeout(() => { child.kill('SIGKILL'); process.exitCode = 1 }, 60000)
try {
  await wait(() => output.includes(`127.0.0.1:${port}`), 'Vite did not start')
  for (const file of ['main/index.js', 'main/pi-worker.js', 'main/emote-bake-worker.js', 'preload/index.cjs', 'scene/scene.js', 'scene/audio-worklet.js']) {
    assert.ok((await readFile(path.join(project, 'dist', file))).length > 0, `dev must write ${file} before serving`)
  }
  const origin = `http://127.0.0.1:${port}`
  const client = await (await fetch(`${origin}/@vite/client`)).text()
  const token = /const wsToken = "([^"]+)"/.exec(client)?.[1]
  assert.ok(token, 'Vite client must expose its local HMR token')
  const settings = await (await fetch(`${origin}/src/renderer/components/SettingsPage.tsx`)).text()
  assert.match(settings, /\$RefreshReg\$|register.*Refresh|react-refresh/)
  assert.doesNotMatch(settings, /Failed to resolve import/)
  socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, 'vite-hmr')
  const events = []
  socket.on('message', data => events.push(JSON.parse(data.toString())))
  await once(socket, 'open')
  const file = path.join(assets, 'crt_config.json')
  await writeFile(file, '{"fixture":1}')
  await wait(() => events.some(event => event.type === 'custom' && event.event === 'amadeus:reload' && event.data.targets.includes('scene')), 'Resource edit did not request a scene-only reload')
  assert.ok(events.filter(event => event.event === 'amadeus:reload').every(event => !event.data.targets.includes('main')))
  for (const [file, before, after, target] of [
    ['src/main/pi-worker.ts', 'Explain tool results in the user-facing reply', 'Explain tool results clearly in the user-facing reply', 'pi-worker'],
    ['src/main/index.ts', 'width: 1100', 'width: 1101', 'main'],
    ['src/preload/index.ts', 'platform: process.platform', 'platform: String(process.platform)', 'preload'],
    ['src/scene/index.ts', 'mouthGain: 8', 'mouthGain: 9', 'scene'],
  ]) {
    const count = events.length
    const source = await readFile(path.join(project, file), 'utf8')
    assert.ok(source.includes(before), `Fixture replacement missing in ${file}`)
    await writeFile(path.join(project, file), source.replace(before, after))
    const event = await wait(() => events.slice(count).find(event => event.event === 'amadeus:reload' && event.data.targets.includes(target)), `${file} did not rebuild`)
    assert.deepEqual(event.data.targets, [target], 'Only the changed component should reload')
  }
  const count = events.filter(event => event.event === 'amadeus:reload').length
  const logStart = output.length
  await writeFile(path.join(project, 'src/main/pi-worker.ts'), 'this is invalid TypeScript !!!')
  await wait(() => /error|ERROR|Unexpected/.test(output.slice(logStart)), 'A broken build was not reported')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(events.filter(event => event.event === 'amadeus:reload').length, count, 'Failed builds must not restart a working component')
  console.log('PASS: React HMR/aliases, selective Pi/main/preload/scene rebuilds, resource watching, and failed-build retention')
} finally {
  socket?.terminate()
  child.kill('SIGTERM')
  if (child.exitCode === null) await once(child, 'exit')
  clearTimeout(deadline)
  await rm(root, { recursive: true, force: true })
}
