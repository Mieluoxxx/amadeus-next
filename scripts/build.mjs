import { build } from 'vite'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(root, '..')
const mainOnly = process.argv.includes('--main-only')


async function compileSpeechHelper() {
  if (process.platform !== 'darwin') return
  const outputDir = path.join(project, 'dist/bin')
  const output = path.join(outputDir, 'SalieriSpeechRecognizer')
  await mkdir(outputDir, { recursive: true })
  await new Promise((resolve, reject) => {
    execFile('swiftc', [
      '-O',
      '-framework', 'AVFoundation',
      '-framework', 'Speech',
      '-Xlinker', '-sectcreate',
      '-Xlinker', '__TEXT',
      '-Xlinker', '__info_plist',
      '-Xlinker', path.join(project, 'native/Info.plist'),
      path.join(project, 'native/SpeechRecognizer.swift'),
      '-o', output,
    ], (error, _stdout, stderr) => {
      if (error) {
        console.warn(`[salieri-next] Apple Speech helper was not built: ${stderr || error.message}`)
        resolve()
        return
      }
      resolve()
    })
  })
}

await build({ configFile: path.join(project, 'vite.main.config.mjs') })
await build({ configFile: path.join(project, 'vite.preload.config.mjs') })
await build({ configFile: path.join(project, 'vite.scene.config.mjs') })
await compileSpeechHelper()
if (!mainOnly) await build({ configFile: path.join(project, 'vite.renderer.config.mjs') })
