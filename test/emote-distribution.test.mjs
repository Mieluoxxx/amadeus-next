import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { beforePack, prepareEmoteLoader } from '../scripts/emote-loader.mjs'
import { ensureBakedModel, importEmoteAssets } from '../src/main/emoteBake.ts'

test('explicit asset provisioning is repeatable and a failed import preserves the previous copy', { skip: !existsSync(new URL('../resources/emote/FreeMoteDriver.js', import.meta.url)) }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-provision-'))
  const source = path.join(root, 'source'), target = path.join(root, 'resources/emote')
  const run = promisify(execFile)
  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true })
    await cp(new URL('../scripts/provision-emote.mjs', import.meta.url), path.join(root, 'scripts/provision-emote.mjs'))
    await mkdir(target, { recursive: true })
    for (const file of ['FreeMoteDriver.js', 'emoteplayer.js']) await cp(new URL(`../resources/emote/${file}`, import.meta.url), path.join(target, file))
    await mkdir(path.join(source, '红莉栖E-mote模型'), { recursive: true })
    await writeFile(path.join(source, 'README.md'), 'source notice')
    await writeFile(path.join(source, '红莉栖E-mote模型/README.md'), 'asset notice')
    for (const name of ['牧瀬紅莉栖ab', '牧瀬紅莉栖ab_白衣', '牧瀬紅莉栖c', '牧瀬紅莉栖c_白衣']) {
      const folder = path.join(source, '红莉栖E-mote模型', name)
      await mkdir(path.join(folder, `${name}.psb`), { recursive: true })
      await writeFile(path.join(folder, `${name}.psb/texture.png`), 'fixture texture')
      await writeFile(path.join(folder, `${name}.psb.m.resx.json`), JSON.stringify({ Resources: { 0: `${name}.psb/texture.png` } }))
    }
    for (let i = 0; i < 2; i++) await run(process.execPath, ['scripts/provision-emote.mjs', source], { cwd: root })
    const index = path.join(target, 'models/kurisu_ab_white/kurisu_ab_white.psb.m.resx.json')
    assert.equal(JSON.parse(await readFile(index, 'utf8')).Resources[0], 'kurisu_ab_white.psb/texture.png')
    await rm(source, { recursive: true })
    await assert.rejects(run(process.execPath, ['scripts/provision-emote.mjs', source], { cwd: root }))
    assert.equal((await lstat(index)).isFile(), true)
    await assert.rejects(run(process.execPath, ['scripts/provision-emote.mjs'], { cwd: root }), /素材来源目录/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('build copies a verified local artifact without Rust or a sibling checkout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-artifact-'))
  const name = process.platform === 'win32' ? 'AmadeusEmoteLoader.exe' : 'AmadeusEmoteLoader'
  const source = path.join(root, 'vendor/emote-loader', `${process.platform}-${process.arch}`)
  const output = path.join(root, 'dist/bin', name)
  try {
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, name), 'fixture binary')
    const manifest = { schema: 1, revision: '1'.repeat(40), platform: process.platform, arch: process.arch, sha256: createHash('sha256').update('fixture binary').digest('hex') }
    await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(path.join(source, 'LICENSE'), 'fixture license')
    await writeFile(path.join(source, 'THIRD_PARTY_NOTICES.txt'), 'fixture dependency licenses')
    await prepareEmoteLoader(root)
    assert.equal(await readFile(output, 'utf8'), 'fixture binary')
    assert.equal((await lstat(output)).isSymbolicLink(), false)
    assert.equal(JSON.parse(await readFile(path.join(root, 'dist/bin/AmadeusEmoteLoader.json'), 'utf8')).revision, manifest.revision)
    const { Arch } = await import('builder-util')
    const context = { packager: { projectDir: root }, electronPlatformName: process.platform, arch: Arch[process.arch] }
    await beforePack(context)
    await assert.rejects(beforePack({ ...context, arch: Arch[process.arch === 'arm64' ? 'x64' : 'arm64'] }), /目标系统/)
    await writeFile(path.join(source, name), 'tampered')
    await assert.rejects(prepareEmoteLoader(root), /SHA-256/)
    await assert.rejects(stat(output), { code: 'ENOENT' })
    await rm(source, { recursive: true })
    await prepareEmoteLoader(root)
    await assert.rejects(prepareEmoteLoader(root, true), /emote:loader/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cache fingerprints all inputs, publishes complete generations, and retries failed bakes', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-cache-'))
  const model = 'kurisu_ab_white'
  const pack = path.join(root, 'models', model)
  const binary = path.join(root, 'bin/AmadeusEmoteLoader')
  const index = path.join(pack, `${model}.psb.m.resx.json`)
  const texture = path.join(pack, 'texture.png')
  const options = { moduleDir: path.join(root, 'main'), modelRoot: path.join(root, 'models'), cacheDir: path.join(root, 'cache') }
  try {
    await mkdir(pack, { recursive: true })
    await mkdir(path.dirname(binary))
    await writeFile(path.join(pack, `${model}.psb.m.json`), '{}')
    await writeFile(index, JSON.stringify({ Resources: { 0: 'texture.png' }, ExtraResources: {} }))
    await writeFile(texture, 'one')
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), out = args[args.indexOf('--out') + 1], pack = args[args.indexOf('--model') + 1];
const count = path.join(__dirname, 'calls'); fs.appendFileSync(count, 'bake\\n');
fs.writeFileSync(out, Buffer.concat([Buffer.from('PSB\\0'), Buffer.alloc(60)]));
if (JSON.parse(fs.readFileSync(path.join(pack, path.basename(pack) + '.psb.m.resx.json'))).fail) process.exit(1);
fs.writeFileSync(out.replace(/\\.psb$/, '.meta.json'), JSON.stringify({metadata:{variableMetaInfoList:[],eyeControl:[],customSelectorList:[]},parts:[],snaps:{}}));
`)
    await chmod(binary, 0o755)
    const [first, concurrent] = await Promise.all([ensureBakedModel(model, options), ensureBakedModel(model, options)])
    assert.deepEqual(concurrent, first)
    assert.equal((await readFile(path.join(root, 'bin/calls'), 'utf8')).trim(), 'bake')
    assert.deepEqual(await ensureBakedModel(model, options), first)
    const timestamp = await stat(texture)
    await writeFile(texture, 'two')
    await utimes(texture, timestamp.atime, timestamp.mtime)
    const second = await ensureBakedModel(model, options)
    assert.notEqual(second.psb, first.psb, 'same-size texture edits with preserved mtime must invalidate the cache')
    await writeFile(binary, (await readFile(binary, 'utf8')) + '\n// new loader revision\n')
    const third = await ensureBakedModel(model, options)
    assert.notEqual(third.psb, second.psb)
    await writeFile(third.psb, 'PSB\0')
    await ensureBakedModel(model, options)
    assert.equal((await stat(third.psb)).size, 64, 'truncated cache must be rebuilt')
    await writeFile(index, JSON.stringify({ Resources: { 0: 'texture.png' }, ExtraResources: {}, fail: true }))
    await assert.rejects(ensureBakedModel(model, options))
    assert.equal((await stat(second.psb)).size, 64, 'a failed bake must preserve previous generations')
    await writeFile(index, JSON.stringify({ Resources: { 0: '../outside.png' }, ExtraResources: {} }))
    await assert.rejects(ensureBakedModel(model, options), /越界/)
    await assert.rejects(ensureBakedModel('../escape', options), /模型名/)
    await assert.rejects(importEmoteAssets(pack, path.join(root, 'imported'), options), /资源|运行时/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
