import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, lstat, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EmoteCharacter, EMOTE_EXPRESSIONS, partVariablesFromTable, snapWrites, updateEmoteControls, THINKING_SCAN, THINKING_HANDOFF_WAIT_MS, SPOKEN_THINKING_MS } from '../src/scene/emote.ts'
import { ensureBakedModel, importEmoteAssets, verifyEmoteRuntime } from '../src/main/emoteBake.ts'
import { SceneHost } from '../src/main/sceneHost.ts'

const assetRoot = existsSync(path.resolve(import.meta.dirname, '../resources/character/emote'))
  ? path.resolve(import.meta.dirname, '../resources/character/emote')
  : path.resolve(import.meta.dirname, '../resources/emote')
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
  const player = { mainTimelineLabel: EMOTE_EXPRESSIONS.neutral, mainTimelineLabels: Object.values(EMOTE_EXPRESSIONS), getVariable: label => written.get(label) ?? 0, setVariable: (label, value) => written.set(label, value), setVariableDiff() {} }
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
  const player = { mainTimelineLabel: '', mainTimelineLabels: Object.values(EMOTE_EXPRESSIONS), getVariable: name => values.get(name) ?? 0, setVariable: (name, value) => values.set(name, value), setVariableDiff() {} }
  const character = new EmoteCharacter(player)
  const send = event => character.dispatch(event)
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
  send({ type: 'activity', activity: 'thinking' })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.thinking)
  for (const [emotion, label] of Object.entries(EMOTE_EXPRESSIONS)) {
    send({ type: 'cue', emotion })
    assert.equal(player.mainTimelineLabel, label)
  }
  send({ type: 'playback', status: 'playing', now: 0 })
  send({ type: 'cue', emotion: 'smile' })
  send({ type: 'activity', activity: 'idle' })
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
  send({ type: 'tick', now: 1099 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.smile)
  send({ type: 'tick', now: 1100 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
  send({ type: 'reset' })
  assert.equal(character.state.playback, 'quiet')
  assert.equal(values.get('face_talk'), 0)
  player.mainTimelineLabels = [EMOTE_EXPRESSIONS.neutral]
  send({ type: 'cue', emotion: 'angry' })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
})

test('thinking expression stays through speech wait but yields to playback or a spoken cue', () => {
  const player = { mainTimelineLabel: '', mainTimelineLabels: Object.values(EMOTE_EXPRESSIONS), getVariable() { return 0 }, setVariable() {}, setVariableDiff() {} }
  const character = new EmoteCharacter(player)
  const wait = () => {
    character.dispatch({ type: 'reset' })
    character.dispatch({ type: 'playback', status: 'waiting', now: 0 })
    character.dispatch({ type: 'activity', activity: 'thinking' })
    character.dispatch({ type: 'activity', activity: 'idle' })
    assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.thinking)
  }
  wait()
  character.dispatch({ type: 'playback', status: 'playing', now: 1 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
  wait()
  character.dispatch({ type: 'cue', emotion: 'smile' })
  character.dispatch({ type: 'playback', status: 'playing', now: 1 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.smile)
  wait()
  character.dispatch({ type: 'playback', status: 'ended', now: 1 })
  assert.equal(player.mainTimelineLabel, EMOTE_EXPRESSIONS.neutral)
})

function scanHarness() {
  const base = new Map([['head_UD', 66.6666641], ['face_eye_LR', -100]])
  const diffs = new Map(), writes = []
  const player = {
    mainTimelineLabel: '', mainTimelineLabels: Object.values(EMOTE_EXPRESSIONS),
    getVariable: name => base.get(name) ?? 0,
    setVariable() {},
    setVariableDiff(module, name, value, ms) {
      if (module === 'thinking-scan') { diffs.set(name, value); writes.push({ module, name, value, ms }) }
    },
  }
  const character = new EmoteCharacter(player, {}, 0)
  const send = event => character.dispatch({ now: 0, ...event })
  const tick = now => send({ type: 'tick', now })
  return { character, diffs, writes, send, tick, base }
}

test('思考浏览只在困る00 且模型思考时运行，离开或 reset 后清除差分', () => {
  const { character, diffs, writes, send, tick, base } = scanHarness()
  send({ type: 'cue', emotion: 'thinking' }); tick(10_000); tick(20_000)
  assert.equal(writes.length, 0, '活动为 idle 时不扫描')
  send({ type: 'activity', activity: 'thinking' })
  tick(0); tick(THINKING_SCAN.enterMs - 1)
  assert.equal(writes.length, 0, '入场过渡期间不覆盖姿态')
  tick(THINKING_SCAN.enterMs)
  assert.ok(Math.abs(base.get('head_UD') + diffs.get('head_UD') - THINKING_SCAN.head) < 1e-6)
  assert.deepEqual([...new Set(writes.map(w => w.name))].sort(), ['face_eye_LR', 'head_UD'])
  send({ type: 'cue', emotion: 'smile' })
  assert.equal(diffs.get('head_UD'), 0); assert.equal(diffs.get('face_eye_LR'), 0)
  const stopped = writes.length
  tick(30_000)
  assert.equal(writes.length, stopped, '离开困る00 后不再写入')
  send({ type: 'cue', emotion: 'thinking' }); tick(40_000); tick(50_000)
  send({ type: 'reset' })
  assert.equal(diffs.get('head_UD'), 0); assert.equal(diffs.get('face_eye_LR'), 0)
  assert.equal(character.state.activity, 'idle')
})

test('退出思考后等待语音时冻结姿态，正式表情到来或取消时再释放', () => {
  const wait = () => {
    const h = scanHarness()
    h.send({ type: 'playback', status: 'waiting' })
    h.send({ type: 'activity', activity: 'thinking' })
    h.tick(0); h.tick(20_000)
    h.send({ type: 'activity', activity: 'idle' })
    const frozen = [...h.diffs], count = h.writes.length
    h.tick(21_000); h.tick(22_000)
    assert.deepEqual([...h.diffs], frozen, '等待时不继续扫视也不回落')
    assert.equal(h.writes.length, count)
    assert.equal(h.character.state.label, EMOTE_EXPRESSIONS.thinking)
    return h
  }
  const released = h => { assert.equal(h.diffs.get('head_UD'), 0); assert.equal(h.diffs.get('face_eye_LR'), 0) }
  for (const emotion of ['smile', 'thinking']) {
    const h = wait()
    h.send({ type: 'cue', emotion })
    assert.equal(h.character.state.label, EMOTE_EXPRESSIONS[emotion])
    if (emotion === 'smile') released(h)
  }
  for (const status of ['playing', 'buffering']) {
    const h = wait()
    h.send({ type: 'playback', status })
    assert.equal(h.character.state.label, EMOTE_EXPRESSIONS.neutral)
    released(h)
  }
  for (const event of [{ type: 'reset' }, { type: 'activity', activity: 'tool' }, { type: 'playback', status: 'ended' }]) {
    const h = wait(); h.send(event); released(h)
  }
  const h = wait()
  h.tick(22_000 + THINKING_HANDOFF_WAIT_MS)
  assert.equal(h.character.state.label, EMOTE_EXPRESSIONS.neutral, '等待超时回到普通表情')
  released(h)
})

test('说话时的 thinking 表情只保持一小段，之后回到普通表情', () => {
  const { character, send, tick } = scanHarness()
  send({ type: 'playback', status: 'playing' })
  send({ type: 'cue', emotion: 'thinking' })
  tick(0); tick(SPOKEN_THINKING_MS - 1)
  assert.equal(character.state.label, EMOTE_EXPRESSIONS.thinking)
  tick(SPOKEN_THINKING_MS)
  assert.equal(character.state.label, EMOTE_EXPRESSIONS.neutral)
  send({ type: 'cue', emotion: 'thinking' })
  tick(SPOKEN_THINKING_MS + 1); tick(SPOKEN_THINKING_MS * 2)
  assert.equal(character.state.label, EMOTE_EXPRESSIONS.thinking, '新的 cue 重新计时')
  send({ type: 'cue', emotion: 'smile' }); tick(SPOKEN_THINKING_MS * 4)
  assert.equal(character.state.label, EMOTE_EXPRESSIONS.smile, '其他表情不受影响')
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
    await writeFile(path.join(root, 'assets/spriteforge/frame.png'), 'legacy')
    await symlink(path.join(root, 'secret.txt'), path.join(root, 'emote/escaped.txt'))
    await host.start()
    const init = await (await fetch(host.origin + '/next/init')).json()
    assert.deepEqual(init.character, { renderer: 'emote', model: 'kurisu_ab_white' })
    assert.equal('definition' in init, false)
    const module = await fetch(host.origin + '/emote/psb.mjs')
    assert.equal(module.headers.get('content-type'), 'text/javascript')
    assert.equal(await module.text(), 'export const fixture = true')
    const background = await fetch(host.origin + '/assets/spriteforge/frame.png')
    assert.equal(background.status, 200)
    assert.equal(background.headers.get('content-type'), 'image/png')
    for (const url of ['/character/frame.png', '/emote/%2e%2e%2fsecret.txt', '/emote/missing.png']) {
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
