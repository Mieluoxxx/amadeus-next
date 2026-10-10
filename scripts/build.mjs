import { build } from 'vite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(root, '..')
const mainOnly = process.argv.includes('--main-only')


export async function compileSpeechHelper() {
  if (process.platform !== 'darwin') return
  const outputDir = path.join(project, 'dist/bin')
  const output = path.join(outputDir, 'AmadeusSpeechRecognizer')
  const temporary = `${output}.${process.pid}.tmp`
  await mkdir(outputDir, { recursive: true })
  try {
    await promisify(execFile)('swiftc', [
      '-O',
      '-framework', 'AVFoundation',
      '-framework', 'Speech',
      '-Xlinker', '-sectcreate',
      '-Xlinker', '__TEXT',
      '-Xlinker', '__info_plist',
      '-Xlinker', path.join(project, 'native/Info.plist'),
      path.join(project, 'native/SpeechRecognizer.swift'),
      '-o', temporary,
    ])
    await rename(temporary, output)
  } finally { await rm(temporary, { force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build({ configFile: path.join(project, 'vite/main.config.mjs') })
  await build({ configFile: path.join(project, 'vite/preload.config.mjs') })
  await build({ configFile: path.join(project, 'vite/scene.config.mjs') })
  await compileSpeechHelper()
  if (!mainOnly) await build({ configFile: path.join(project, 'vite/renderer.config.mjs') })
}
