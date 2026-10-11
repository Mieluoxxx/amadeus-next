import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runs = Number(process.argv[2] || 5)
// 三者都到齐才算启动完成：场景握手、角色画面可见，且会话可用。
const FINAL = ['scene-handshake', 'character-ready', 'runtime-ready']
const TIMEOUT_MS = 60_000

// 用独立的用户目录，既不碰主人的真实会话，又让烘焙缓存在预热后保持热态。
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'amadeus-boot-'))
const home = path.join(sandbox, 'home')
const credentials = path.join(sandbox, 'pi-agent')
mkdirSync(credentials, { recursive: true })

function once() {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [project, `--user-data-dir=${path.join(sandbox, 'user-data')}`], {
      env: { ...process.env, AMADEUS_BOOT_PROFILE: '1', AMADEUS_HOME: home, AMADEUS_PI_CREDENTIALS_DIR: credentials, PI_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const marks = {}
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Boot did not finish: ${JSON.stringify(marks)}`)) }, TIMEOUT_MS)
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        const match = line.match(/__AMADEUS_BOOT__ (.*)$/)
        if (!match) continue
        const { mark, ms } = JSON.parse(match[1])
        marks[mark] = ms
        if (FINAL.every(name => name in marks)) { clearTimeout(timer); child.kill() }
      }
    })
    // 等进程退干净再进入下一轮，否则上一轮还在写缓存目录。
    child.on('exit', () => { clearTimeout(timer); FINAL.every(name => name in marks) ? resolve(marks) : reject(new Error(`Electron exited early: ${JSON.stringify(marks)}`)) })
  })
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }

try {
  await once()
  const samples = []
  for (let index = 0; index < runs; index++) samples.push(await once())
  const names = [...new Set(samples.flatMap(Object.keys))].sort((a, b) => median(samples.map(s => s[a] ?? Infinity)) - median(samples.map(s => s[b] ?? Infinity)))
  for (const name of names) console.log(`${name.padEnd(18)} ${String(median(samples.map(s => s[name]).filter(v => v !== undefined))).padStart(6)} ms`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
