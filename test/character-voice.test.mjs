import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import { loadCharacter } from '../src/main/characterPack.ts'
import { initialCharacterState, transition } from '../src/shared/character.ts'
import { PresentationText, AlignmentTimeline } from '../src/shared/presentation.ts'

const root = path.resolve(import.meta.dirname, '../resources/assets/spriteforge/runtime/kurisu')
const definition = loadCharacter(root, '/character/')

test('the installed graph has every frame set, authored timing and speaking mouth profile', () => {
  assert.equal(definition.diagnostics.length, 0)
  assert.equal(Object.keys(definition.clips).length, 39)
  for (const node of Object.values(definition.nodes)) {
    assert.ok(definition.clips[node.label]?.frames.length, node.label)
    if (node.kind === 'speech') assert.ok(definition.mouths[node.label], node.label)
  }
  assert.equal(definition.clips.idle.frameIntervalMs, 21)
  assert.equal(definition.clips.thinking_trans.loopMode, 'once_then_hold')
})

test('an incomplete external pack preserves idle, rejects escaped resources, and excludes missing states', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'salieri-pack-'))
  try {
    writeFileSync(path.join(dir, 'idle.ktx2'), '')
    symlinkSync('/etc/hosts', path.join(dir, 'escape.ktx2'))
    writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ nodes: [{ id: 'idle', label: 'idle', isRoot: true }, { id: 'absent', label: 'absent' }], edges: [] }))
    writeFileSync(path.join(dir, 'mouth.json'), JSON.stringify({ profiles: {}, expressions: {} }))
    writeFileSync(path.join(dir, 'runtime_manifest.json'), JSON.stringify({ format: 'amadeus.spriteforge.character-pack.v1', textureFormat: 'ktx2', graph: 'graph.json', mouthConfig: 'mouth.json', clips: {
      idle: { frames: ['idle.ktx2'], frameIntervalMs: 21, loopMode: 'loop' },
      absent: { frames: ['missing.ktx2'], frameIntervalMs: 21, loopMode: 'loop' },
      escaped: { frames: ['escape.ktx2'], frameIntervalMs: 21, loopMode: 'loop' },
    } }))
    const pack = loadCharacter(dir, '/character/')
    assert.equal(pack.nodes[pack.root].label, 'idle')
    assert.equal(pack.nodes.absent, undefined)
    assert.equal(pack.clips.escaped, undefined)
    assert.ok(pack.diagnostics.some(message => message.includes('escapes')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('thinking enters the graph, waits for playback, and normal completion holds once', () => {
  let state = initialCharacterState(definition)
  const step = event => { state = transition(state, event, definition).state; return state }
  step({ type: 'activity', activity: 'thinking', random: 0.9 })
  assert.equal(definition.nodes[state.node].label, 'thinking_trans')
  step({ type: 'cycle', node: state.node, random: 0 })
  assert.equal(state.phase, 'waiting')
  step({ type: 'playback', status: 'playing', now: 0, random: 0.9 })
  assert.equal(definition.nodes[state.node].kind, 'speech')
  step({ type: 'activity', activity: 'idle', random: 0 })
  step({ type: 'playback', status: 'ended', now: 100 })
  const deadline = state.holdUntil
  step({ type: 'playback', status: 'ended', now: 800 })
  assert.equal(state.holdUntil, deadline)
  step({ type: 'tick', now: 1100, random: 0 })
  assert.equal(state.node, definition.root)
})

test('all emotions reach speaking; smile/sad exit through their post-speech assets', () => {
  for (const emotion of ['smile', 'sad', 'shy', 'surprise', 'angry', 'serious']) {
    let state = initialCharacterState(definition)
    const step = event => { state = transition(state, event, definition).state }
    step({ type: 'cue', emotion, random: 0 })
    step({ type: 'playback', status: 'playing', now: 0, random: 0.9 })
    for (let i = 0; i < 8 && definition.nodes[state.node].kind !== 'speech'; i++) step({ type: 'cycle', node: state.node, random: 0 })
    assert.equal(definition.nodes[state.node].kind, 'speech', emotion)
    step({ type: 'playback', status: 'ended', now: 0 })
    step({ type: 'tick', now: 1000, random: 0 })
    if (['smile', 'sad'].includes(emotion)) {
      assert.equal(definition.nodes[state.node].label, emotion)
      step({ type: 'cycle', node: state.node, random: 0 })
    }
    assert.equal(state.node, definition.root, emotion)
  }
})

test('buffer starvation does not release speech; reset ignores an old cycle', () => {
  let state = transition(initialCharacterState(definition), { type: 'playback', status: 'playing', now: 0, random: 0.9 }, definition).state
  const speakingNode = state.node
  state = transition(state, { type: 'playback', status: 'buffering', now: 50 }, definition).state
  assert.notEqual(state.node, definition.root)
  state = transition(state, { type: 'reset' }, definition).state
  assert.equal(transition(state, { type: 'cycle', node: speakingNode, random: 0 }, definition).state.node, definition.root)
})

test('Pi completion while awaiting first audio preserves the preparation pose without claiming speech', () => {
  let state = initialCharacterState(definition)
  const step = event => { state = transition(state, event, definition).state }
  step({ type: 'playback', status: 'waiting', now: 0 })
  step({ type: 'activity', activity: 'thinking', random: 0.9 })
  step({ type: 'cycle', node: state.node, random: 0 })
  step({ type: 'activity', activity: 'idle', random: 0 })
  assert.equal(state.playback, 'waiting')
  assert.equal(definition.nodes[state.node].label, 'thinking_trans')
  step({ type: 'playback', status: 'playing', now: 500, random: 0 })
  assert.equal(state.playback, 'playing')
  assert.equal(definition.nodes[state.node].kind, 'speech')
})

test('streamed EMO tags become cues while literal Markdown stays literal', () => {
  const parser = new PresentationText()
  const parts = ['Hello [EM', 'O preset=happy dur=2s]', ' world. `', '[EMO preset=sad]', '`\n```text\n[EMO preset=angry]\n```']
  const outputs = parts.map(part => parser.push(part))
  outputs.push(parser.finish())
  assert.equal(outputs.map(p => p.text).join(''), 'Hello  world. `[EMO preset=sad]`\n```text\n[EMO preset=angry]\n```')
  assert.deepEqual(outputs.flatMap(p => p.cues), [{ offset: 6, emotion: 'smile' }])
})

test('every streaming split preserves escaped/code literals and strips only valid emotion cues', () => {
  const input = 'Hi \\[EMO preset=sad] `code [EMO preset=angry]`\n~~~text\n[EMO preset=smile]\n~~~\n[EMO preset=shy]End'
  const whole = new PresentationText().push(input, true)
  for (let at = 0; at <= input.length; at++) {
    const parser = new PresentationText()
    const parts = [parser.push(input.slice(0, at)), parser.push(input.slice(at)), parser.finish()]
    assert.deepEqual({ text: parts.map(p => p.text).join(''), cues: parts.flatMap(p => p.cues) }, whole, `split ${at}`)
  }
  assert.equal(whole.cues.length, 1)
  assert.equal(whole.cues[0].emotion, 'shy')
})

test('alignment corrections replace snapshots; stale cues never run backwards', () => {
  const timeline = new AlignmentTimeline()
  timeline.append('Hello world', [{ offset: 6, emotion: 'smile' }])
  timeline.update({ chunk_seq: 0, content: 'Hello world', chunk_audio_offset_sec: 1, alignment: { segments: [{ text: 'Hello', start: 0, end: 0.3 }, { text: 'world', start: 0.5, end: 0.9 }] } })
  assert.equal(timeline.take(1.4), null)
  assert.equal(timeline.take(1.6), 'smile')
  timeline.update({ chunk_seq: 0, content: 'Hello world', chunk_audio_offset_sec: 1, alignment: { segments: [{ text: 'world', start: 0.1, end: 0.4 }] } })
  assert.equal(timeline.take(2), null)
  timeline.update({ chunk_seq: 0, content: 'Hello world', chunk_audio_offset_sec: 1, alignment: null })
  assert.equal(timeline.take(2), null)
})
