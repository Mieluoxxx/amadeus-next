import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScriptSplitter, plainText } from '../src/main/voice/splitter.ts'
import { VoiceDirector } from '../src/main/voice/director.ts'
import { parseDirection } from '../src/shared/direction.ts'
import { normalizeRequest } from '../src/main/durable/voice.ts'
import { legacyScript } from '../src/shared/presentation.ts'

const split = (chunks, final = true) => {
  const splitter = new ScriptSplitter()
  const out = []
  chunks.forEach((chunk, index) => out.push(...splitter.push(chunk, final && index === chunks.length - 1)))
  return out
}
const spoken = segments => segments.filter(segment => segment.speak).map(segment => segment.text)

test('sentences end at Chinese and Western terminators, keeping trailing quotes and repeated marks', () => {
  assert.deepEqual(spoken(split(['你又熬夜了？！真是的。她说：「好啊。」然后走了'])), ['你又熬夜了？！', '真是的。', '她说：「好啊。」', '然后走了'])
})

test('a sentence split across chunks is cut only once it is complete', () => {
  const splitter = new ScriptSplitter()
  assert.deepEqual(splitter.push('今天天'), [])
  assert.deepEqual(splitter.push('气不错'), [])
  // 句号之后要看下一个字符才知道后面有没有引号。
  assert.deepEqual(splitter.push('。'), [])
  assert.deepEqual(spoken(splitter.push('明')), ['今天天气不错。'])
  assert.deepEqual(spoken(splitter.push('', true)), ['明'])
})

test('the first sentence is sent early at a comma, later ones wait for the full stop', () => {
  assert.deepEqual(spoken(split(['这个问题其实比你想象的要复杂得多，我们慢慢说，先从定义开始。'])), ['这个问题其实比你想象的要复杂得多，', '我们慢慢说，先从定义开始。'])
  assert.deepEqual(spoken(split(['好的，我知道了。'])), ['好的，我知道了。'], 'a short opening is not cut at its comma')
})

test('long text without a full stop is cut at a comma, and hard-cut when there is none', () => {
  const long = `${'甲'.repeat(70)}，${'乙'.repeat(10)}。`
  const [first] = spoken(split(['开头。', long]))
  assert.equal(first, '开头。')
  assert.deepEqual(spoken(split(['开头。', long])).slice(1), [`${'甲'.repeat(70)}，`, `${'乙'.repeat(10)}。`])
  assert.equal(spoken(split(['开头。', '丙'.repeat(200)]))[1].length, 160)
})

test('code fences and tables are shown but never voiced, even when the fence arrives in pieces', () => {
  const segments = split(['看这里：\n``', '`ts\nconst a = 1。\n', '```\n| a | b |\n|---|---|\n改好了。'])
  assert.deepEqual(spoken(segments), ['看这里：', '改好了。'])
  const shown = segments.filter(segment => !segment.speak).map(segment => segment.text)
  assert.deepEqual(shown, ['```ts\nconst a = 1。\n```\n', '| a | b |\n', '|---|---|\n'])
  assert.deepEqual(spoken(split(['```\n没闭合。'])), [], 'an unclosed fence stays unvoiced to the end')
})

test('flush hands over the half sentence before a tool call', () => {
  const splitter = new ScriptSplitter()
  assert.deepEqual(splitter.push('我去查一下'), [])
  assert.deepEqual(spoken(splitter.flush()), ['我去查一下'])
  assert.deepEqual(spoken(splitter.push('查到了。', true)), ['查到了。'])
})

test('markdown markers are dropped from subtitles, blank segments are not voiced', () => {
  assert.equal(plainText('- **重点**：看 `config.ts` 和 [文档](https://x.y)'), '重点：看 config.ts 和 文档')
  assert.equal(plainText('## 标题'), '标题')
  assert.deepEqual(spoken(split(['\n\n  \n- \n好。'])), ['好。'])
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

function director(options = {}) {
  const requests = [], released = [], errors = []
  let drained = 0
  const voice = new VoiceDirector({
    direct: request => { const pending = deferred(); requests.push({ request, ...pending }); return pending.promise },
    release: lines => released.push(...lines),
    drained: () => { drained++ },
    report: error => errors.push(error),
    ...options,
  })
  return { voice, requests, released, errors, drained: () => drained }
}
const answer = request => request.lines.map(line => ({ id: line.id, jp: `JP:${line.zh}`, emotion: 'smile' }))

test('the first line goes alone; lines written meanwhile are batched and released in order', async () => {
  const { voice, requests, released, drained } = director({ heard: '你好' })
  voice.push('一。')
  voice.push('二。')
  voice.push('三。')
  assert.equal(requests.length, 1, 'with one request running, two lines are not enough for a batch')
  assert.deepEqual(requests[0].request, { lines: [{ id: 1, zh: '一。' }], context: [], heard: '你好' })
  voice.push('四。')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].request.lines.map(line => line.zh), ['二。', '三。', '四。'])
  assert.deepEqual(requests[1].request.context, [{ zh: '一。' }])
  requests[1].resolve(answer(requests[1].request))
  await flush()
  assert.deepEqual(released, [], 'a later batch waits for the earlier one')
  requests[0].resolve(answer(requests[0].request))
  await flush()
  assert.deepEqual(released.map(line => line.jp), ['JP:一。', 'JP:二。', 'JP:三。', 'JP:四。'])
  assert.equal(drained(), 0, 'not drained before the main model finishes')
  voice.finish()
  assert.equal(drained(), 1)
})

test('pause and finish send whatever is queued without waiting for a full batch', async () => {
  const { voice, requests } = director()
  voice.push('一。')
  voice.push('二。')
  assert.equal(requests.length, 1)
  voice.pause()
  assert.equal(requests.length, 2)
  voice.push('三。')
  voice.finish()
  assert.equal(requests.length, 2, 'two requests already run; the third waits for a slot')
  requests[0].resolve([])
  await flush()
  assert.equal(requests.length, 3)
})

test('a failed or partial direction leaves those lines without Japanese and is reported once per turn', async () => {
  const { voice, requests, released, errors, drained } = director()
  voice.push('一。')
  voice.push('二。')
  voice.finish()
  requests[0].reject(new Error('down'))
  requests[1].resolve([])
  await flush()
  assert.deepEqual(released, [{ zh: '一。' }, { zh: '二。' }])
  assert.equal(errors.length, 1)
  assert.equal(drained(), 1)
})

test('an aborted director releases nothing and never drains', async () => {
  const { voice, requests, released, drained } = director()
  voice.push('一。')
  voice.abort()
  voice.push('二。')
  voice.finish()
  requests[0].resolve(answer(requests[0].request))
  await flush()
  assert.deepEqual([requests.length, released.length, drained()], [1, 0, 0])
})

test('the director reply is parsed defensively', () => {
  const reply = '```json\n{"lines":[{"id":1,"jp":"[sigh]ほんと、**しょうがない**わね。","emotion":"sad","voice":"sigh"},{"id":1,"jp":"重复"},{"id":2,"jp":"  ","emotion":"smile"},{"id":3,"jp":"了解","emotion":"ecstatic","voice":"scream"},{"id":9,"jp":"多出来的"}]}\n```'
  assert.deepEqual(parseDirection(reply, [1, 2, 3]), [
    { id: 1, jp: 'ほんと、しょうがないわね。', emotion: 'sad', voice: 'sigh' },
    { id: 3, jp: '了解' },
  ])
  assert.deepEqual(parseDirection('not json', [1]), [])
  assert.deepEqual(parseDirection('{"lines":"x"}', [1]), [])
})

test('requests from the main process are clipped before they reach the model', () => {
  const request = normalizeRequest({
    lines: [{ id: 1, zh: ' 好 ' }, { id: 'x', zh: '坏' }, { id: 2, zh: '' }, ...Array.from({ length: 10 }, (_, index) => ({ id: index + 10, zh: '多' }))],
    context: [{ zh: '前', jp: '前' }, { zh: '' }],
    heard: 42,
  })
  assert.deepEqual(request.lines[0], { id: 1, zh: '好' })
  assert.equal(request.lines.length, 8)
  assert.deepEqual(request.context, [{ zh: '前', jp: '前' }])
  assert.equal('heard' in request, false)
})

test('replies written in the old bilingual-tag format are read back as their Chinese', () => {
  assert.equal(legacyScript('[EMO preset=smile]<zh>你好。</zh><jp>こんにちは。</jp><zh>再见</zh><jp>[sigh]またね</jp>'), '你好。再见')
  assert.equal(legacyScript('<jp>只有日语</jp>'), '只有日语')
  assert.equal(legacyScript('- [x] 普通的 Markdown [note]'), '- [x] 普通的 Markdown [note]', 'new replies pass through untouched')
})
