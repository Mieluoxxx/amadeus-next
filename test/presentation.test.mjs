import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PresentationText, AlignmentTimeline } from '../src/shared/presentation.ts'

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
