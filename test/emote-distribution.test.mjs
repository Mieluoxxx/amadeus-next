import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { beforePack } from '../scripts/before-pack.mjs'
import { ensureBakedModel, importEmoteAssets, importEmoteZip } from '../src/main/emoteBake.ts'
import { workerBaker } from '../src/main/emoteBakeHost.ts'
import { buildZip } from './zip-fixture.mjs'

const emoteRelDir = existsSync(new URL('../resources/character/emote/FreeMoteDriver.js', import.meta.url))
  ? 'resources/character/emote'
  : 'resources/emote'
const emoteDriverUrl = new URL(`../${emoteRelDir}/FreeMoteDriver.js`, import.meta.url)

test('explicit asset provisioning is repeatable and a failed import preserves the previous copy', { skip: !existsSync(emoteDriverUrl) }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-provision-'))
  const source = path.join(root, 'source'), target = path.join(root, emoteRelDir)
  const run = promisify(execFile)
  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true })
    await cp(new URL('../scripts/provision-emote.mjs', import.meta.url), path.join(root, 'scripts/provision-emote.mjs'))
    await mkdir(target, { recursive: true })
    for (const file of ['FreeMoteDriver.js', 'emoteplayer.js']) await cp(new URL(`../${emoteRelDir}/${file}`, import.meta.url), path.join(target, file))
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

test('cache fingerprints all inputs, publishes complete generations, and retries failed bakes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-cache-'))
  const model = 'kurisu_ab_white'
  const pack = path.join(root, 'models', model)
  const index = path.join(pack, `${model}.psb.m.resx.json`)
  const texture = path.join(pack, 'texture.png')
  let calls = 0
  const baker = {
    version: 'fixture-1',
    async bake(job) {
      calls++
      await writeFile(job.psb, Buffer.concat([Buffer.from('PSB\0'), Buffer.alloc(60)]))
      if (JSON.parse(await readFile(path.join(job.folder, `${job.model}.psb.m.resx.json`), 'utf8')).fail) throw new Error('fixture bake failed')
      await writeFile(job.meta, JSON.stringify({ metadata: { variableMetaInfoList: [], eyeControl: [], customSelectorList: [] }, parts: [], snaps: {} }))
    },
  }
  const options = { baker, modelRoot: path.join(root, 'models'), cacheDir: path.join(root, 'cache') }
  try {
    await mkdir(pack, { recursive: true })
    await writeFile(path.join(pack, `${model}.psb.m.json`), '{}')
    await writeFile(index, JSON.stringify({ Resources: { 0: 'texture.png' }, ExtraResources: {} }))
    await writeFile(texture, 'one')
    const [first, concurrent] = await Promise.all([ensureBakedModel(model, options), ensureBakedModel(model, options)])
    assert.deepEqual(concurrent, first)
    assert.equal(calls, 1, 'concurrent requests must share one bake')
    assert.deepEqual(await ensureBakedModel(model, options), first)
    await writeFile(path.join(pack, '.DS_Store'), 'finder state')
    assert.deepEqual(await ensureBakedModel(model, options), first, 'system junk files must not invalidate the cache')
    const timestamp = await stat(texture)
    await writeFile(texture, 'two')
    await utimes(texture, timestamp.atime, timestamp.mtime)
    const second = await ensureBakedModel(model, options)
    assert.notEqual(second.psb, first.psb, 'same-size texture edits with preserved mtime must invalidate the cache')
    const third = await ensureBakedModel(model, { ...options, baker: { ...baker, version: 'fixture-2' } })
    assert.notEqual(third.psb, second.psb, 'a new baker version must invalidate the cache')
    await writeFile(third.psb, 'PSB\0')
    await ensureBakedModel(model, { ...options, baker: { ...baker, version: 'fixture-2' } })
    assert.equal((await stat(third.psb)).size, 64, 'truncated cache must be rebuilt')
    await writeFile(index, JSON.stringify({ Resources: { 0: 'texture.png' }, ExtraResources: {}, fail: true }))
    await assert.rejects(ensureBakedModel(model, options), /fixture bake failed/)
    assert.equal((await stat(second.psb)).size, 64, 'a failed bake must preserve previous generations')
    await writeFile(index, JSON.stringify({ Resources: { 0: '../outside.png' }, ExtraResources: {} }))
    await assert.rejects(ensureBakedModel(model, options), /越界/)
    await assert.rejects(ensureBakedModel('../escape', options), /模型名/)
    await assert.rejects(importEmoteAssets(pack, path.join(root, 'imported'), { baker, cacheDir: options.cacheDir }), /资源|运行时/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an unzipped folder imports as-is: wrapper directories and macOS archive junk are tolerated', { skip: !existsSync(emoteDriverUrl) }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-unzipped-'))
  const unzipped = path.join(root, 'download'), emote = path.join(unzipped, 'emote'), pack = path.join(emote, 'models/kurisu_ab_white')
  const baked = []
  const baker = {
    version: 'fixture-1',
    async bake(job) {
      baked.push(job.folder)
      await writeFile(job.psb, Buffer.concat([Buffer.from('PSB\0'), Buffer.alloc(60)]))
      await writeFile(job.meta, JSON.stringify({ metadata: { variableMetaInfoList: [], eyeControl: [], customSelectorList: [] }, parts: [], snaps: {} }))
    },
  }
  try {
    await mkdir(pack, { recursive: true })
    for (const file of ['FreeMoteDriver.js', 'emoteplayer.js']) await cp(new URL(`../${emoteRelDir}/${file}`, import.meta.url), path.join(emote, file))
    await writeFile(path.join(pack, 'kurisu_ab_white.psb.m.json'), '{}')
    await writeFile(path.join(pack, 'kurisu_ab_white.psb.m.resx.json'), JSON.stringify({ Resources: {}, ExtraResources: {} }))
    await mkdir(path.join(unzipped, '__MACOSX/emote'), { recursive: true })
    await writeFile(path.join(unzipped, '__MACOSX/emote/._FreeMoteDriver.js'), 'apple double')
    await writeFile(path.join(pack, '._kurisu_ab_white.psb.m.json'), 'apple double')
    await writeFile(path.join(unzipped, '.DS_Store'), 'finder state')
    const destination = path.join(root, 'user/emote')
    await importEmoteAssets(unzipped, destination, { baker, cacheDir: path.join(root, 'cache') })
    assert.equal(existsSync(path.join(destination, 'FreeMoteDriver.js')), true, 'the wrapper directory must be descended into')
    assert.equal(existsSync(path.join(destination, 'models/kurisu_ab_white/._kurisu_ab_white.psb.m.json')), false, 'archive junk must not be copied')
    assert.equal(baked.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a zip installs through the same checks as a directory, and the unzip staging is cleaned up', { skip: !existsSync(emoteDriverUrl) }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-zip-install-'))
  const driver = await readFile(new URL(`../${emoteRelDir}/FreeMoteDriver.js`, import.meta.url))
  const player = await readFile(new URL(`../${emoteRelDir}/emoteplayer.js`, import.meta.url))
  const baker = {
    version: 'fixture-1',
    async bake(job) {
      await writeFile(job.psb, Buffer.concat([Buffer.from('PSB\0'), Buffer.alloc(60)]))
      await writeFile(job.meta, JSON.stringify({ metadata: { variableMetaInfoList: [], eyeControl: [], customSelectorList: [] }, parts: [], snaps: {} }))
    },
  }
  try {
    const zip = path.join(root, 'emote.zip')
    await writeFile(zip, Buffer.from(buildZip([
      { name: '__MACOSX/', mode: 0o040755 },
      { name: '__MACOSX/emote/._FreeMoteDriver.js', data: Buffer.from('apple double') },
      // 从 resources 里压出来的包会带上三层前缀，导入要能一路钻到底。
      { name: 'resources/', mode: 0o040755 },
      { name: 'resources/character/', mode: 0o040755 },
      { name: 'resources/character/emote/', mode: 0o040755 },
      { name: 'resources/character/emote/FreeMoteDriver.js', data: driver, method: 8 },
      { name: 'resources/character/emote/emoteplayer.js', data: player, method: 8 },
      { name: 'resources/character/emote/models/kurisu_ab_white/', mode: 0o040755 },
      { name: 'resources/character/emote/models/kurisu_ab_white/kurisu_ab_white.psb.m.json', data: Buffer.from('{}') },
      { name: 'resources/character/emote/models/kurisu_ab_white/kurisu_ab_white.psb.m.resx.json', data: Buffer.from(JSON.stringify({ Resources: {}, ExtraResources: {} })) },
      { name: 'resources/character/emote/models/kurisu_ab_white/._junk', data: Buffer.from('junk') },
    ])))

    const base = path.join(root, 'user'), destination = path.join(base, 'emote')
    await importEmoteZip(zip, destination, { baker, cacheDir: path.join(root, 'cache') })
    assert.equal(existsSync(path.join(destination, 'FreeMoteDriver.js')), true, '三层目录必须被下钻到')
    assert.equal(existsSync(path.join(destination, 'models/kurisu_ab_white/._junk')), false, '归档垃圾不得留下')
    assert.deepEqual((await readdir(base)).filter(name => name.startsWith('.emote-')), [], '解压的临时目录必须被清掉')
  } finally { await rm(root, { recursive: true, force: true }) }
})

class BakeChild extends EventEmitter {
  sent = []
  killed = false
  postMessage(message) { this.sent.push(message) }
  kill() { this.killed = true; return true }
}

test('worker baker forks one process per job and always tears it down', async () => {
  const job = { folder: '/m', model: 'kurisu_ab_white', psb: '/o.psb', meta: '/o.meta.json' }
  const spawn = () => { const child = new BakeChild(); children.push(child); return child }
  const children = []
  const baker = workerBaker(spawn, 50)
  const done = baker.bake(job)
  children[0].emit('message', { type: 'ready' })
  assert.deepEqual(children[0].sent, [job], 'the job is sent only after the worker is ready')
  children[0].emit('message', { type: 'done' })
  await done
  assert.equal(children[0].killed, true)

  const failed = baker.bake(job)
  children[1].emit('message', { type: 'error', error: 'error.cwColor：暂不支持非中性 cw 颜色权重' })
  await assert.rejects(failed, /error\.cwColor/)
  assert.equal(children[1].killed, true)

  const crashed = baker.bake(job)
  children[2].emit('exit', 9)
  await assert.rejects(crashed, /意外退出（9）/)

  const stuck = baker.bake(job)
  await assert.rejects(stuck, /超时/)
  assert.equal(children[3].killed, true)
})

test('packaging is refused for a foreign architecture because the speech helper is host-built', async () => {
  const { Arch } = await import('builder-util')
  const context = { electronPlatformName: process.platform, arch: Arch[process.arch] }
  await beforePack(context)
  await assert.rejects(beforePack({ ...context, arch: Arch[process.arch === 'arm64' ? 'x64' : 'arm64'] }), /目标系统/)
})
