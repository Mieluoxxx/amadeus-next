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
  const full = new PresentationText().push(input, true)
  const whole = { text: full.text, cues: full.cues }
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

const bilingual = '<zh>都说了，不要加「蒂娜」！</zh><jp>[EMO preset=shy]だから、ティーナって呼ばないでって言ってるでしょ！</jp>\n<zh>……我在，找我什么事？</zh><jp>……いるわよ。何の用？</jp>'

test('zh/jp pairs split the subtitle from the spoken line at every streaming boundary', () => {
  const expectation = {
    text: 'だから、ティーナって呼ばないでって言ってるでしょ！\n……いるわよ。何の用？',
    speech: '[embarrassed]だから、ティーナって呼ばないでって言ってるでしょ！\n……いるわよ。何の用？',
    display: '都说了，不要加「蒂娜」！\n……我在，找我什么事？',
    cues: [{ offset: 0, emotion: 'shy' }],
    subtitles: [{ offset: 0, text: '都说了，不要加「蒂娜」！' }, { offset: 26, text: '……我在，找我什么事？' }],
  }
  const whole = new PresentationText().push(bilingual, true)
  assert.equal(whole.text.length, 26 + '……いるわよ。何の用？'.length)
  assert.deepEqual(whole, expectation)
  for (let at = 0; at <= bilingual.length; at++) {
    const parser = new PresentationText()
    const parts = [parser.push(bilingual.slice(0, at)), parser.push(bilingual.slice(at)), parser.finish()]
    assert.deepEqual({
      text: parts.map(p => p.text).join(''), speech: parts.map(p => p.speech).join(''), display: parts.map(p => p.display).join(''),
      cues: parts.flatMap(p => p.cues), subtitles: parts.flatMap(p => p.subtitles),
    }, expectation, `split ${at}`)
  }
})

test('a reply without blocks is unchanged, and blocks fall back gracefully', () => {
  const plain = new PresentationText().push('Hello [EMO preset=smile]world', true)
  assert.deepEqual(plain, { text: 'Hello world', speech: 'Hello [happy]world', display: 'Hello world', cues: [{ offset: 6, emotion: 'smile' }], subtitles: [] })
  // A spoken line with no subtitle of its own is its own subtitle.
  const bare = new PresentationText().push('<jp>こんにちは</jp>', true)
  assert.deepEqual({ text: bare.text, display: bare.display, subtitles: bare.subtitles }, { text: 'こんにちは', display: 'こんにちは', subtitles: [{ offset: 0, text: 'こんにちは' }] })
  // Unclosed blocks are flushed, and tags in code stay literal.
  const open = new PresentationText().push('<zh>字幕<jp>音声', true)
  assert.deepEqual({ text: open.text, display: open.display }, { text: '音声', display: '字幕' })
  const code = new PresentationText().push('`<zh>x</zh>`', true)
  assert.equal(code.text, '`<zh>x</zh>`')
  assert.deepEqual(code.subtitles, [])
  // A zh-only block (code, paths) is shown but never spoken.
  const silent = new PresentationText().push('<zh>运行 `npm test`</zh>', true)
  assert.equal(silent.text, '')
  assert.equal(silent.display, '运行 `npm test`')
})

test('the subtitle follows the utterance being spoken, not the whole reply', () => {
  const timeline = new AlignmentTimeline()
  const parsed = new PresentationText().push('<zh>一</zh><jp>Hello </jp><zh>二</zh><jp>world</jp>', true)
  timeline.append(parsed.text, parsed.cues, parsed.subtitles)
  assert.equal(timeline.subtitleAt(0), null)
  timeline.update({ chunk_seq: 0, content: 'Hello world', chunk_audio_offset_sec: 0, alignment: { segments: [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'world', start: 0.6, end: 1 }] } })
  assert.equal(timeline.subtitleAt(0.2), '一')
  assert.equal(timeline.subtitleAt(0.7), '二')
})

const voiced = '<zh>哼。</zh><jp>[EMO preset=shy][sigh]ふん、[emphasis]バカね。</jp><zh>好吧。</zh><jp>[EMO preset=normal]いいわ。</jp><zh>嗯？</zh><jp>[EMO preset=surprised] 本当？</jp>'

test('voice cues reach speech only, and an expression without one gets a matching tone', () => {
  const expectation = {
    text: 'ふん、バカね。いいわ。 本当？',
    speech: '[sigh]ふん、[emphasis]バカね。いいわ。 [surprised]本当？',
    display: '哼。好吧。嗯？',
    cues: [{ offset: 0, emotion: 'shy' }, { offset: 7, emotion: 'neutral' }, { offset: 11, emotion: 'surprise' }],
  }
  for (let at = 0; at <= voiced.length; at++) {
    const parser = new PresentationText()
    const parts = [parser.push(voiced.slice(0, at)), parser.push(voiced.slice(at)), parser.finish()]
    assert.deepEqual({
      text: parts.map(p => p.text).join(''), speech: parts.map(p => p.speech).join(''),
      display: parts.map(p => p.display).join(''), cues: parts.flatMap(p => p.cues),
    }, expectation, `split ${at}`)
  }
  // A cue written before the expression still suppresses the fallback tone.
  assert.equal(new PresentationText().push('<jp>[whisper][EMO preset=sad]ごめん</jp>', true).speech, '[whisper]ごめん')
  // Japanese brackets, Markdown links and code stay literal.
  const literal = new PresentationText().push('[注意] see [docs](x) `[sigh]`', true)
  assert.equal(literal.text, '[注意] see [docs](x) `[sigh]`')
  assert.equal(literal.speech, literal.text)
  // A spoken line without a subtitle never shows its cues.
  assert.equal(new PresentationText().push('<jp>[laugh]ふふ</jp>', true).display, 'ふふ')
})

test('alignment matches whether the service echoes voice cues or drops them', () => {
  for (const content of ['[sigh]ふん、[emphasis]バカね。', 'ふん、バカね。']) {
    const timeline = new AlignmentTimeline()
    timeline.append('ふん、バカね。', [{ offset: 3, emotion: 'smile' }])
    const tagged = content.startsWith('[')
    timeline.update({ chunk_seq: 0, content, chunk_audio_offset_sec: 0, alignment: { segments: [
      { text: tagged ? '[sigh]ふん、' : 'ふん、', start: 0, end: 0.4 }, { text: tagged ? '[emphasis]バカね。' : 'バカね。', start: 0.5, end: 1 },
    ] } })
    assert.equal(timeline.take(0.45), null, content)
    assert.equal(timeline.take(0.6), 'smile', content)
  }
})
