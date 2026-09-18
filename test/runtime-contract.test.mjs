import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeFilePath } from '../src/main/pathSafety.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the next runtime is TypeScript-first and keeps the selected remote speech contracts', async () => {
  const main = await readFile(path.join(root, 'src/main/index.ts'), 'utf8')
  const worker = await readFile(path.join(root, 'src/main/pi-worker.ts'), 'utf8')
  const fish = await readFile(path.join(root, 'src/main/fishTts.ts'), 'utf8')
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'dist/main/index.js')
  assert.match(worker, /@earendil-works\/pi-coding-agent/)
  assert.match(main, /utilityProcess\.fork/)
  assert.match(fish, /format: 'pcm'/)
  assert.match(fish, /sample_rate: 24000/)
  assert.doesNotMatch(main, /python -m server\.app/)
})

test('the Apple Speech helper is part of the build input', async () => {
  const swift = await readFile(path.join(root, 'native/SpeechRecognizer.swift'), 'utf8')
  const plist = await readFile(path.join(root, 'native/Info.plist'), 'utf8')
  assert.match(swift, /import Speech/)
  assert.match(swift, /SFSpeechRecognizer/)
  assert.match(plist, /NSMicrophoneUsageDescription/)
  assert.match(plist, /NSSpeechRecognitionUsageDescription/)
})

test('scene asset requests cannot escape the selected root', () => {
  assert.equal(safeFilePath('/tmp/assets', 'images/wallpaper.png'), '/tmp/assets/images/wallpaper.png')
  assert.equal(safeFilePath('/tmp/assets', '../secrets.txt'), null)
  assert.equal(safeFilePath('/tmp/assets', '%2e%2e/%2e%2e/secrets.txt'), null)
  assert.equal(safeFilePath('/tmp/assets', '%ZZ'), null)
})
