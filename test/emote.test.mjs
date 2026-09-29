import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, lstat, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EmoteCharacter, EMOTE_EXPRESSIONS, partVariablesFromTable, snapWrites, updateEmoteControls } from '../src/scene/emote.ts'
import { ensureBakedModel, importEmoteAssets, verifyEmoteRuntime } from '../src/main/emoteBake.ts'
import { SceneHost } from '../src/main/sceneHost.ts'

const assetRoot = path.resolve(import.meta.dirname, '../resources/emote')
const loaderBinary = path.resolve(import.meta.dirname, '../dist/bin/AmadeusEmoteLoader')
const modelPack = path.join(assetRoot, 'models/kurisu_ab_white')

test('独立应用副本可导入、离线烘焙并服务模型；损坏的导入不覆盖旧资源', { skip: !existsSync(loaderBinary) || !existsSync(modelPack) }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-independent-'))
  const source = path.join(root, 'source'), imported = path.join(root, 'user/emote'), cacheDir = path.join(root, 'cache')
  const host = new SceneHost(root, root, cacheDir)
  const moduleDir = path.join(root, 'app/main')
  try {
    await mkdir(path.join(root, 'app/bin'), { recursive: true })
    await cp(loaderBinary, path.join(root, 'app/bin/AmadeusEmoteLoader'))
    await mkdir(path.join(source, 'models'), { recursive: true })
    for (const name of ['FreeMoteDriver.js', 'emoteplayer.js']) await cp(path.join(assetRoot, name), path.join(source, name))
    await cp(modelPack, path.join(source, 'models/kurisu_ab_white'), { recursive: true })
    const baked = await importEmoteAssets(source, imported, { moduleDir, cacheDir })
    await rm(source, { recursive: true })
    await verifyEmoteRuntime(imported)
    assert.equal((await lstat(imported)).isSymbolicLink(), false)
    assert.deepEqual(await ensureBakedModel('kurisu_ab_white', { moduleDir, cacheDir, modelRoot: path.join(imported, 'models') }), baked)
    await host.start()
    host.setEmoteAssets(imported, path.dirname(baked.psb))
    const { character } = await (await fetch(host.origin + '/next/init')).json()
    assert.match(character.metaUrl, /\/emote-cache\/kurisu_ab_white\/[a-f0-9]{64}\/kurisu_ab_white.meta.json$/)
    assert.equal((await fetch(host.origin + character.metaUrl)).status, 200)
    assert.equal((await fetch(host.origin + '/emote/emoteplayer.js')).status, 200)
    await mkdir(source)
    await writeFile(path.join(source, 'FreeMoteDriver.js'), 'not the pinned driver')
    await assert.rejects(importEmoteAssets(source, imported, { moduleDir, cacheDir }), /校验失败/)
    await verifyEmoteRuntime(imported)
    assert.equal((await fetch(host.origin + character.metaUrl)).status, 200)
  } finally { host.close(); await rm(root, { recursive: true, force: true }) }
})

// 解析器（独立仓库编译出来的原生工具）负责烘焙；这里的验收点：产物齐备、结构可用、查表数据自洽。
test('烘焙产物齐备且可被场景消费', { skip: !existsSync(loaderBinary) || !existsSync(modelPack) }, async () => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'amadeus-bake-'))
  try {
    const baked = await ensureBakedModel('kurisu_ab_white', { moduleDir: path.dirname(loaderBinary), modelRoot: path.join(assetRoot, 'models'), cacheDir: cache })
    const psb = await readFile(baked.psb)
    assert.ok(psb.length > 100 * 1024 * 1024, `成品 PSB 体积异常：${psb.length}`)
    assert.equal(psb.subarray(0, 4).toString('latin1'), 'PSB\0', '必须是 PSB v4 容器')
    const meta = JSON.parse(await readFile(baked.meta, 'utf8'))
    assert.ok(Array.isArray(meta.metadata.variableMetaInfoList) && meta.metadata.variableMetaInfoList.length > 0, 'metadata 必须带上参数表')
    assert.ok(Array.isArray(meta.metadata.eyeControl), 'metadata 必须带上眼球控制')
    assert.ok(meta.parts.length > 0, '查表数据不能为空')
    assert.ok(Object.keys(meta.snaps).length > 0, '表情的离散轨道必须导出')
    // 手臂显隐是这套查表最容易写错的地方：A/B 两档必须互斥。
    const arm = meta.parts.find((selector) => selector.label === 'arm_type')
    assert.ok(arm, '必须导出 arm_type')
    const writes = arm.options.map((option) => option.writes)
    assert.ok(writes.some((entry) => entry.arm_type_a === 100 && entry.arm_type_b === 0), 'A 档写 100/0')
    assert.ok(writes.some((entry) => entry.arm_type_a === 0 && entry.arm_type_b === 100), 'B 档写 0/100')
  } finally { await rm(cache, { recursive: true, force: true }) }
})

test('查表数据在 scene 侧得到与适配器一致的部件显隐', () => {
  const table = [
    { label: 'arm_type', defaultValue: 0, options: [
      { lower: 0, upper: 0, writes: { arm_type_a: 100, arm_type_b: 0 } },
      { lower: 1, upper: 1, writes: { arm_type_a: 0, arm_type_b: 100 } },
    ] },
    { label: 'head_type', defaultValue: 0, options: [
      { lower: 0, upper: 0, writes: { fade_head_a: 100 } },
      { lower: 1, upper: 1, writes: { fade_head_a: 0 } },
    ] },
  ]
  assert.deepEqual(partVariablesFromTable(table, { arm_type: 1 }), { arm_type_a: 0, arm_type_b: 100, arm_type: 1, fade_head_a: 100, head_type: 0 })
  assert.throws(() => partVariablesFromTable(table, { arm_type: 2 }), /error\.partControlRange/)
  assert.throws(() => partVariablesFromTable(table, { 没有这个: 0 }), /error\.partControlUnsupported/)

  const metadata = {
    customSelectorList: table.map((selector) => ({ enabled: 1, label: selector.label })),
    eyeControl: [{ enabled: 1, label: 'face_eye_LR', varL: 'eye_l', varR: 'eye_r' }],
  }
  const written = new Map([['arm_type', 1]])
  const player = { setVariable: (label, value) => written.set(label, value), getVariable: (label) => written.get(label) ?? 0 }
  updateEmoteControls(player, metadata, table)
  assert.equal(written.get('arm_type_a'), 0)
  assert.equal(written.get('arm_type_b'), 100)
  assert.equal(written.get('eye_l'), 0, '眼球参数要镜像到左右两只')
})

test('表情切换在过渡中点补写被摘掉的离散轨道', async () => {
  const snaps = { [EMOTE_EXPRESSIONS.shy]: [['face_mouth', 2], ['face_cheek', 1]] }
  const written = new Map()
  const player = { mainTimelineLabel: EMOTE_EXPRESSIONS.neutral, mainTimelineLabels: Object.values(EMOTE_EXPRESSIONS), setVariable: (label, value) => written.set(label, value) }
  const character = new EmoteCharacter(player, snaps, 0)
  assert.deepEqual(snapWrites(snaps, EMOTE_EXPRESSIONS.shy), [['face_mouth', 2], ['face_cheek', 1]])
  character.dispatch({ type: 'cue', emotion: 'shy' })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.shy)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(written.get('face_mouth'), 2, '嘴型必须在过渡中点补写，否则脸会先跳')
  assert.equal(written.get('face_cheek'), 1)
})

test('native expressions, real mouth energy, buffering, drain and reset need no frame graph', () => {
  const values = new Map()
  const player = { mainTimelineLabel: '', mainTimelineLabels: Object.values(EMOTE_EXPRESSIONS), setVariable: (name, value) => values.set(name, value) }
  const character = new EmoteCharacter(player)
  const send = event => character.dispatch(event)
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
  send({ type: 'activity', activity: 'thinking', random: 0 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.thinking)
  for (const [emotion, label] of Object.entries(EMOTE_EXPRESSIONS)) {
    send({ type: 'cue', emotion, random: 0 })
    assert.equal(player.mainTimelineLabel, label)
  }
  send({ type: 'playback', status: 'playing', now: 0 })
  send({ type: 'cue', emotion: 'smile', random: 0 })
  send({ type: 'activity', activity: 'idle', random: 0 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.smile, 'Pi completion cannot interrupt audible speech')
  character.setMouth(0.6)
  assert.equal(values.get('face_talk'), 3)
  for (const [input, expected] of [[-1, 0], [2, 5], [NaN, 0], [Infinity, 0]]) {
    character.setMouth(input); assert.equal(values.get('face_talk'), expected)
  }
  send({ type: 'playback', status: 'buffering', now: 1 })
  assert.equal(values.get('face_talk'), 0)
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.smile)
  send({ type: 'playback', status: 'ended', now: 100 })
  send({ type: 'tick', now: 1099, random: 0 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.smile)
  send({ type: 'tick', now: 1100, random: 0 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
  send({ type: 'reset' })
  assert.equal(character.state.playback, 'quiet')
  assert.equal(values.get('face_talk'), 0)
  player.mainTimelineLabels = [EMOTE_EXPRESSIONS.neutral]
  send({ type: 'cue', emotion: 'angry', random: 0 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
})

test('scene serves local E-mote modules, preserves background assets, and rejects escaped assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-emote-'))
  const cache = path.join(root, 'emote-cache')
  await mkdir(cache, { recursive: true })
  await writeFile(path.join(cache, 'kurisu_ab_white.meta.json'), '{"metadata":{}}')
  const host = new SceneHost(root, root, cache)
  try {
    await mkdir(path.join(root, 'emote'))
    await mkdir(path.join(root, 'assets/spriteforge'), { recursive: true })
    await writeFile(path.join(root, 'emote/psb.mjs'), 'export const fixture = true')
    await writeFile(path.join(root, 'secret.txt'), 'not a scene asset')
    await writeFile(path.join(root, 'assets/spriteforge/frame.ktx2'), 'legacy')
    await symlink(path.join(root, 'secret.txt'), path.join(root, 'emote/escaped.txt'))
    await host.start()
    const init = await (await fetch(host.origin + '/next/init')).json()
    assert.deepEqual(init.character, { renderer: 'emote', model: 'kurisu_ab_white' })
    assert.equal('definition' in init, false)
    const module = await fetch(host.origin + '/emote/psb.mjs')
    assert.equal(module.headers.get('content-type'), 'text/javascript')
    assert.equal(await module.text(), 'export const fixture = true')
    const background = await fetch(host.origin + '/assets/spriteforge/frame.ktx2')
    assert.equal(background.status, 200)
    assert.equal(background.headers.get('content-type'), 'image/ktx2')
    for (const url of ['/character/frame.ktx2', '/emote/%2e%2e%2fsecret.txt', '/emote/missing.png']) {
      assert.equal((await fetch(host.origin + url)).status, 404, url)
    }
    assert.equal((await fetch(host.origin + '/emote/escaped.txt')).status, 403)
    const baked = await fetch(host.origin + '/emote-cache/kurisu_ab_white.meta.json')
    assert.equal(baked.status, 200, '烘焙产物必须能通过只读路由取到')
    assert.equal(baked.headers.get('content-type'), 'application/json')
    const escaped = await fetch(host.origin + '/emote-cache/%2e%2e%2fsecret.txt')
    assert.notEqual(escaped.status, 200, '缓存路由同样不许越界')
    assert.notEqual(await escaped.text(), 'not a scene asset')
  } finally { host.close(); await rm(root, { recursive: true, force: true }) }
})
