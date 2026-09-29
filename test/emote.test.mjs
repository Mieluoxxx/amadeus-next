import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EmoteCharacter, EMOTE_EXPRESSIONS, updateEmoteControls } from '../src/scene/emote.ts'
import { SceneHost } from '../src/main/sceneHost.ts'

const assetRoot = path.resolve(import.meta.dirname, '../resources/emote')
test('local model copies retain layers and translate hidden cw keyframes for the legacy runtime', { skip: !existsSync(path.join(assetRoot, 'psb.mjs')) }, async () => {
  const adapter = await import('../resources/emote/psb.mjs')
  assert.equal(typeof adapter.partVariables, 'function', 'the verified visibility adapter must be provisioned')
  const adapterSource = await readFile(path.join(assetRoot, 'psb.mjs'), 'utf8')
  assert.match(adapterSource, /const folder = `\.\/models\/\$\{name\}\/`/, 'the adapter must resolve the packed models through its ASCII base path')
  assert.equal(adapterSource.split('./models/').length, 2)
  for (const name of ['kurisu_ab', 'kurisu_ab_white', 'kurisu_c', 'kurisu_c_white']) {
    const folder = path.join(assetRoot, 'models', name)
    const original = JSON.parse(await readFile(path.join(folder, `${name}.psb.m.json`), 'utf8'))
    const resx = JSON.parse(await readFile(path.join(folder, `${name}.psb.m.resx.json`), 'utf8'))
    for (const resource of [...Object.values(resx.Resources), ...Object.values(resx.ExtraResources)]) assert.ok(existsSync(path.join(folder, resource)), resource)
    const prepared = adapter.prepareModel(structuredClone(original))
    let converted = 0
    const compareLayers = (before, after) => {
      assert.equal(after.length, before.length, 'visibility fixes must not delete layers')
      before.forEach((layer, index) => {
        const actual = after[index]
        assert.equal(actual.label, layer.label, 'layer ordering must be preserved')
        layer.frameList?.forEach(({ content }, frame) => {
          if (!content || content.cw === undefined || !(content.mask & 0x80000000)) return
          const replacement = actual.frameList[frame].content
          assert.equal(replacement.opa, Math.round((content.opa ?? 255) * (content.cw & 255) / 255))
          assert.equal(replacement.mask, ((content.mask & 0x7fffffff) | 0x400) >>> 0)
          assert.equal(replacement.cw, undefined)
          converted++
        })
        compareLayers(layer.children ?? [], actual.children ?? [])
      })
    }
    for (const [objectName, object] of Object.entries(original.object)) {
      for (const [motionName, motion] of Object.entries(object.motion)) compareLayers(motion.layer ?? [], prepared.object[objectName].motion[motionName].layer ?? [])
    }
    assert.ok(converted > 0, `${name}: transparent keyframes were not adapted`)
    const hasArms = name.includes('ab')
    const values = adapter.partVariables(prepared.metadata, hasArms ? { arm_type: 1 } : {})
    assert.equal(values.fade_head_a, 100)
    assert.equal(values.fade_body_a, 100)
    if (hasArms) { assert.equal(values.arm_type_a, 100); assert.equal(values.arm_type_b, 0) }
    const live = new Map([['face_eye_open', 20], ['face_talk', 3]])
    const player = { getVariable: label => live.get(label) ?? 0, setVariable: (label, value) => live.set(label, value) }
    for (let frame = 0; frame < 2; frame++) {
      // Recreate the bad defaults a reset/old runtime can leave behind.
      for (const label of ['fade_head_a', 'fade_body_a', 'arm_type_a', 'arm_type_b']) live.set(label, 0)
      updateEmoteControls(player, prepared.metadata, adapter.partVariables)
      assert.equal(live.get('fade_head_a'), 100)
      assert.equal(live.get('fade_body_a'), 100)
      if (hasArms) { assert.equal(live.get('arm_type_a'), 100); assert.equal(live.get('arm_type_b'), 0) }
      assert.equal(live.get('face_eye_open_l'), 20)
      assert.equal(live.get('face_eye_open_r'), 20)
      assert.equal(live.get('face_talk'), 3, 'visibility updates must not overwrite audio mouth energy')
    }
  }
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
  const host = new SceneHost(root, root)
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
  } finally { host.close(); await rm(root, { recursive: true, force: true }) }
})
