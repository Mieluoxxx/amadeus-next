import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, cp, symlink, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const root = await mkdtemp(path.join(os.tmpdir(), 'salieri-dev-'))
const project = path.join(root, 'project')
const assets = path.join(root, 'assets')
await mkdir(project)
await mkdir(assets)
for (const name of ['src', 'scripts', 'native', 'package.json', 'index.html', 'vite.main.config.mjs', 'vite.renderer.config.mjs', 'vite.preload.config.mjs', 'vite.scene.config.mjs']) {
  await cp(path.resolve(name), path.join(project, name), { recursive: true })
}
await symlink(path.resolve('node_modules'), path.join(project, 'node_modules'), 'dir')
await symlink(path.resolve('resources'), path.join(project, 'resources'), 'dir')
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const child = spawn(process.execPath, ['scripts/dev.mjs', '--server-only', `--port=${port}`], {
  cwd: project, env: { ...process.env, SALIERI_NEXT_PROJECT_ROOT: assets }, stdio: ['ignore', 'pipe', 'pipe'],
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
  await wait(() => events.some(event => event.type === 'custom' && event.event === 'salieri:reload' && event.data.targets.includes('scene')), 'Resource edit did not request a scene-only reload')
  assert.ok(events.filter(event => event.event === 'salieri:reload').every(event => !event.data.targets.includes('main')))
  for (const [file, before, after, target] of [
    ['src/main/pi-worker.ts', 'a warm desktop companion', 'a friendly desktop companion', 'pi-worker'],
    ['src/main/index.ts', 'width: 1100', 'width: 1101', 'main'],
    ['src/preload/index.ts', "wallpaperHost: 'macos-companion'", "wallpaperHost: 'fixture-companion'", 'preload'],
    ['src/scene/index.ts', 'mouthGain: 8', 'mouthGain: 9', 'scene'],
  ]) {
    const count = events.length
    const source = await readFile(path.join(project, file), 'utf8')
    assert.ok(source.includes(before), `Fixture replacement missing in ${file}`)
    await writeFile(path.join(project, file), source.replace(before, after))
    const event = await wait(() => events.slice(count).find(event => event.event === 'salieri:reload' && event.data.targets.includes(target)), `${file} did not rebuild`)
    assert.deepEqual(event.data.targets, [target], 'Only the changed component should reload')
  }
  const count = events.filter(event => event.event === 'salieri:reload').length
  const logStart = output.length
  await writeFile(path.join(project, 'src/main/pi-worker.ts'), 'this is invalid TypeScript !!!')
  await wait(() => /error|ERROR|Unexpected/.test(output.slice(logStart)), 'A broken build was not reported')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(events.filter(event => event.event === 'salieri:reload').length, count, 'Failed builds must not restart a working component')
  console.log('PASS: React HMR/aliases, selective Pi/main/preload/scene rebuilds, resource watching, and failed-build retention')
} finally {
  socket?.terminate()
  child.kill('SIGTERM')
  if (child.exitCode === null) await once(child, 'exit')
  clearTimeout(deadline)
  await rm(root, { recursive: true, force: true })
}
