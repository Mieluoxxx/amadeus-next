import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync, inflateSync } from 'node:zlib'
import { bakeModel } from '../src/shared/emote/bake.ts'
import { detachSnapTracks, prepareModel } from '../src/shared/emote/normalize.ts'
import { partTable } from '../src/shared/emote/parts.ts'
import { decodePng, readPng } from '../src/shared/emote/png.ts'
import { layoutPsb, uintArray } from '../src/shared/emote/psb.ts'
import { Double, parseModelJson } from '../src/shared/emote/value.ts'
import { partVariablesFromTable } from '../src/scene/emote.ts'
import { readPsb } from './psb-reader.mjs'

async function* inflate(chunks) { yield inflateSync(Buffer.concat(chunks)) }
const concat = parts => Buffer.concat(parts.map(part => Buffer.from(part)))

// —— 规范化：一份手写小模型覆盖 5 条规则与 3 个错误分支（与原 Rust 单测逐条对应） ——
const sampleJson = () => ({
  spec: 'win',
  source: { 'tex#000': { texture: { type: 'png' } } },
  metadata: {
    selectorControl: [{ enabled: 1, label: 'face_mouth', optionList: [
      { label: 'fade_mouth_0', lower: 0, upper: 9, onValue: 0, offValue: 1 },
      { label: 'fade_mouth_1', lower: 10, upper: 19, onValue: 0, offValue: 1 },
    ] }],
    mouthControl: [{ enabled: 1, label: 'face_mouth', talkLabel: 'face_talk' }, { enabled: 1, label: 'keep_me' }],
    timelineControl: [{ label: '表情_笑', variableList: [
      { label: 'face_mouth', frameList: [{ time: 0, type: 2, content: { easing: 0, value: 10 } }, { time: 11, type: 0, content: null }] },
      { label: 'head_LR', frameList: [{ time: 0, type: 2, content: { easing: 0, value: 100 } }] },
    ] }],
  },
  object: { all_parts: { motion: { 全体構造: { layer: [{
    frameList: [{ content: { mask: 0x80000000, cw: 0x80808000 } }],
    children: [{ frameList: [{ content: { opacity: 1, mask: 0x80000000, cw: 0x7f7f7f00 } }] }],
  }] } } } },
})
const sample = () => parseModelJson(JSON.stringify(sampleJson()))
const normalized = () => { const model = sample(); prepareModel(model); return model }

test('selector values become option indices and ranges are stripped', () => {
  const model = normalized()
  const option = model.metadata.selectorControl[0].optionList
  assert.equal('lower' in option[0] || 'upper' in option[1], false)
  const tracks = model.metadata.timelineControl[0].variableList
  assert.equal(tracks[0].frameList[0].content.value, 1, '10 falls in the second range')
  assert.equal(tracks[1].frameList[0].content.value, 100, 'non-selector tracks are untouched')
  assert.equal(tracks[0].frameList[1].content, null)
})

test('the legacy merged mouth control is dropped, others are kept', () => {
  assert.deepEqual(normalized().metadata.mouthControl.map(control => control.label), ['keep_me'])
})

test('neutral cw weights become opa and the hidden flag becomes 0x400', () => {
  const layer = normalized().object.all_parts.motion['全体構造'].layer[0]
  assert.deepEqual(layer.frameList[0].content, { mask: 1024, opa: 0 })
  assert.deepEqual(layer.children[0].frameList[0].content, { opacity: 1, mask: 1024, opa: 0 })
  const half = parseModelJson('{"mask":2147483650,"cw":2139062144,"opa":128}')
  const model = sample()
  model.object.all_parts.motion['全体構造'].layer[0].frameList[0].content = half
  prepareModel(model)
  assert.deepEqual(half, { mask: 0x402, opa: 64 })
})

test('normalization errors carry i18n keys', () => {
  const colored = sample()
  colored.object.all_parts.motion['全体構造'].layer[0].frameList[0].content.cw = 0x11223300
  assert.throws(() => prepareModel(colored), error => error.key === 'error.cwColor')
  const outOfRange = sample()
  outOfRange.metadata.timelineControl[0].variableList[0].frameList[0].content.value = 99
  assert.throws(() => prepareModel(outOfRange), error => error.key === 'error.selectorRange' && error.detail.value === 99)
  const missing = sample()
  missing.object = { all_parts: { motion: {} } }
  assert.throws(() => prepareModel(missing), error => error.key === 'error.missingEntry')
})

test('spec, texture format and base entry are rewritten', () => {
  const model = normalized()
  assert.equal(model.spec, 'ems')
  assert.equal(model.source['tex#000'].texture.type, 'RGBA8')
  assert.deepEqual(model.metadata.base, { chara: 'all_parts', motion: '全体構造' })
})

test('without ranged selectors nothing is dropped or converted', () => {
  const model = sample()
  model.metadata.selectorControl = []
  prepareModel(model)
  assert.equal(model.metadata.mouthControl.length, 2)
  assert.equal(model.metadata.timelineControl[0].variableList[0].frameList[0].content.value, 10)
})

test('single-key selector tracks at frame 0 are detached from expression timelines', () => {
  const model = normalized()
  assert.deepEqual(detachSnapTracks(model), [['表情_笑', [['face_mouth', 1]]]], 'null-content frames do not count as keys')
  assert.deepEqual(model.metadata.timelineControl[0].variableList.map(track => track.label), ['head_LR'])
  const keyed = normalized()
  keyed.metadata.timelineControl[0].variableList[0].frameList[1].content = { easing: 0, value: 0 }
  assert.deepEqual(detachSnapTracks(keyed), [['表情_笑', []]], 'a selector track with two keys stays in place')
  assert.equal(keyed.metadata.timelineControl[0].variableList.length, 2)
})

// —— 部件查表：区间命中、on/off、默认值、两类错误 ——
const partMetadata = () => parseModelJson(JSON.stringify({
  customSelectorList: [
    { enabled: 1, label: 'arm_type', optionList: [
      { label: 'arm_type_a', lower: 0, upper: 0, onValue: 100, offValue: 0 },
      { label: 'arm_type_b', lower: 1, upper: 1, onValue: 100, offValue: 0 },
    ] },
    { enabled: 1, label: 'head_type', optionList: [
      { label: 'fade_head_a', lower: 0, upper: 0, onValue: 100, offValue: 0 },
      { label: '', lower: 1, upper: 1, onValue: 0, offValue: 0 },
      { label: 'never', onValue: 1, offValue: 0 },
    ] },
    { enabled: 0, label: 'disabled_type', optionList: [{ label: 'x', lower: 0, upper: 0, onValue: 1, offValue: 0 }] },
  ],
  variableMetaInfoList: [{ id: 'arm_type', defaultValue: 1 }, { id: 'head_type', defaultValue: 0 }],
}))

test('part table writes onValue for the hit option and offValue for the rest', () => {
  const table = partTable(partMetadata())
  assert.deepEqual(table.map(selector => selector.label), ['arm_type', 'head_type'], 'only enabled selectors are exported')
  assert.equal(table[0].defaultValue, 1)
  assert.deepEqual(table[0].options[1].writes, { arm_type_a: 0, arm_type_b: 100 })
  assert.equal(table[1].options.length, 2, 'options without a numeric range are dropped')
  const b = partVariablesFromTable(table, { arm_type: 1 })
  assert.deepEqual([b.arm_type, b.arm_type_a, b.arm_type_b, b.fade_head_a], [1, 0, 100, 100])
  const a = partVariablesFromTable(table, { arm_type: 0 })
  assert.deepEqual([a.arm_type_a, a.arm_type_b], [100, 0])
  const head = partVariablesFromTable(table, { head_type: 1 })
  assert.equal('' in head, false, 'empty option labels are never written')
  assert.equal(head.fade_head_a, 0)
  assert.equal(partVariablesFromTable(table, {}).arm_type, 1, 'missing values fall back to defaults')
  assert.throws(() => partVariablesFromTable(table, { disabled_type: 0 }), /partControlUnsupported/)
  assert.throws(() => partVariablesFromTable(table, { unknown: 0 }), /partControlUnsupported/)
  assert.throws(() => partVariablesFromTable(table, { arm_type: 2 }), /partControlRange/)
})

// —— PNG ——
// 3x2：(255,0,0,255) (0,255,0,128) (0,0,255,0) / (10,20,30,255) (40,50,60,7) (255,255,255,255)
const tinyPng = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0, 157, 116, 102, 26, 0, 0, 0, 29, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 8, 27, 64, 20, 3, 151, 136, 220, 127, 13, 35, 27, 246, 255, 64, 0, 0, 116, 94, 10, 81, 39, 65, 95, 166, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])

async function decodeAll(bytes, batchBytes) {
  const parts = []
  await decodePng(readPng(bytes), inflate, async rgba => { parts.push(Buffer.from(rgba)) }, batchBytes)
  return { bytes: Buffer.concat(parts), batches: parts.length }
}

function pngOf(width, height, rows, { depth = 8, color = 6, interlace = 0 } = {}) {
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); out.write(type, 4, 'latin1'); data.copy(out, 8); return out }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]))
}

/** 按规范对每行施加指定滤波，用来验证解码器的五种反滤波。 */
function filtered(pixels, width, height) {
  const stride = width * 4, out = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const filter = y % 5, row = y * stride, target = y * (stride + 1)
    out[target] = filter
    for (let x = 0; x < stride; x++) {
      const raw = pixels[row + x], a = x >= 4 ? pixels[row + x - 4] : 0, b = y ? pixels[row - stride + x] : 0, c = x >= 4 && y ? pixels[row - stride + x - 4] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]
      out[target + 1 + x] = (raw - predictor) & 0xff
    }
  }
  return out
}

test('PNG decodes to tight straight-alpha RGBA, keeping RGB under alpha 0', async () => {
  const { bytes } = await decodeAll(tinyPng)
  assert.deepEqual([...bytes], [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 40, 50, 60, 7, 255, 255, 255, 255])
  assert.throws(() => readPng(new TextEncoder().encode('not a png')), /不是 PNG/)
})

test('all five PNG row filters are reversed, also across small batches', async () => {
  const width = 7, height = 11, pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + (i >> 3) * 11) & 0xff
  const png = pngOf(width, height, filtered(pixels, width, height))
  const whole = await decodeAll(png)
  assert.deepEqual(whole.bytes, pixels)
  const batched = await decodeAll(png, width * 4 * 3)
  assert.deepEqual(batched.bytes, pixels)
  assert.equal(batched.batches, 4)
})

test('unsupported PNG layouts are rejected instead of guessed', () => {
  const rows = Buffer.alloc(2 * 4)
  assert.throws(() => readPng(pngOf(1, 2, rows, { color: 2 })), /颜色类型 2/)
  assert.throws(() => readPng(pngOf(1, 2, rows, { depth: 16 })), /位深 16/)
  assert.throws(() => readPng(pngOf(1, 2, rows, { interlace: 1 })), /隔行/)
})

// —— PSB 编码 ——
/** 单键对象的子值字节：根对象头是 21 + 键数组 0D 01 0D 00 + 偏移数组 0D 01 0D 00。 */
function encodedValue(value) {
  const bytes = concat(layoutPsb({ k: value }, [Uint8Array.of(0)], [4]))
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  return [...bytes.subarray(view.getUint32(36, true) + 9, view.getUint32(16, true))]
}

test('values use the emote-psb encoding widths', () => {
  assert.deepEqual(encodedValue(0), [0x04])
  assert.deepEqual(encodedValue(127), [0x05, 0x7f])
  assert.deepEqual(encodedValue(128), [0x06, 0x80, 0x00])
  assert.deepEqual(encodedValue(-1), [0x0c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 'negative integers always take 8 bytes')
  assert.deepEqual(encodedValue(new Double(1)), [0x1f, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f], '1.0 stays a double')
  assert.deepEqual(encodedValue(null), [0x01])
  assert.deepEqual(encodedValue(true), [0x03])
  assert.deepEqual(encodedValue('x'), [0x15, 0x00])
  assert.deepEqual(encodedValue('#resource#0'), [0x19, 0x00])
  assert.deepEqual(encodedValue('#resource@0'), [0x22, 0x00])
  assert.deepEqual(encodedValue([]), [0x20, 0x0d, 0x00, 0x0d])
  assert.deepEqual([...uintArray([])], [0x0d, 0x00, 0x0d])
  assert.deepEqual([...uintArray([1, 300])], [0x0d, 0x02, 0x0e, 0x01, 0x00, 0x2c, 0x01])
})

test('number kinds follow the JSON text, not the value', () => {
  const tree = parseModelJson('{"a":1,"b":1.0,"c":-0,"d":0.5,"e":1e2}')
  assert.equal(tree.a, 1)
  assert.ok(tree.b instanceof Double && tree.b.value === 1)
  assert.ok(tree.c instanceof Double && Object.is(tree.c.value, -0))
  assert.equal(tree.d, 0.5)
  assert.ok(tree.e instanceof Double && tree.e.value === 100)
  assert.equal(JSON.stringify(tree), '{"a":1,"b":1,"c":0,"d":0.5,"e":100}')
})

test('a PSB round-trips through an independent reader with sections in emote-psb order', () => {
  const model = parseModelJson(JSON.stringify({
    id: 'motion', list: [1, -2, 3.5, null, false, '#resource#1', '#resource@0'], nested: { 'é': '～', z: '😀' },
    big: 4294967296, notRef: '#resource#99999999999',
  }))
  const extras = [Uint8Array.of(9, 8, 7)], textures = [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6, 7, 8)]
  const bytes = concat([...layoutPsb(model, extras, textures.map(texture => texture.length)), ...textures])
  const psb = readPsb(bytes)
  assert.deepEqual(psb.tree, model)
  assert.deepEqual(psb.extras.map(extra => [...extra]), [[9, 8, 7]])
  assert.deepEqual(psb.resources.map(resource => [...resource]), [[1, 2, 3, 4], [5, 6, 7, 8]])
  assert.deepEqual(psb.strings.slice(-2), ['～', '😀'], 'strings are ordered by UTF-8 bytes (code points), not UTF-16 units')
  const { header } = psb
  const order = [header.names, header.entry, header.strings, header.stringData, header.extraOffsets, header.extraLengths, header.extraData, header.resourceOffsets, header.resourceLengths, header.resourceData]
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.equal(header.resourceData, bytes.length - 8, 'texture data comes last, unpadded')
  let a = 1, b = 0
  for (const byte of [...bytes.subarray(8, 40), ...bytes.subarray(44, 56)]) { a = (a + byte) % 65521; b = (b + a) % 65521 }
  assert.equal(header.checksum, ((b << 16) | a) >>> 0)
  assert.throws(() => layoutPsb({ ref: '#resource#2' }, [], [4, 4]), /不存在的资源/)
})

test('bakeModel turns an unpacked folder into PSB bytes plus the scene sidecar', async () => {
  const width = 2, height = 2, pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 0, 9, 10, 11, 12, 13, 14, 15, 16])
  const model = { ...sampleJson(), source: { 'tex#000': { texture: { type: 'png', pixel: '#resource#0' } } } }
  model.metadata.customSelectorList = []
  model.metadata.variableMetaInfoList = [{ id: 'face_mouth', defaultValue: 0.0 }]
  model.metadata.eyeControl = []
  model.blob = '#resource@1'
  const files = {
    'm.psb.m.json': Buffer.from(JSON.stringify(model).replace('"defaultValue":0', '"defaultValue":0.0')),
    'm.psb.m.resx.json': Buffer.from(JSON.stringify({ PsbVersion: 4, Resources: { 0: 't.png' }, ExtraResources: { '@1': 'extra/@1.bin' }, ExtraFlattenArrays: { '@0': [0.5, -1] } })),
    't.png': Buffer.from(pngOf(width, height, filtered(pixels, width, height))),
    'extra/@1.bin': Buffer.from([7, 7]),
  }
  const written = []
  const meta = await bakeModel({ model: 'm', read: async file => files[file], inflate, write: async bytes => { written.push(Buffer.from(bytes)) } })
  const psb = readPsb(Buffer.concat(written))
  assert.equal(psb.tree.spec, 'ems')
  assert.equal(psb.tree.source['tex#000'].texture.type, 'RGBA8')
  assert.ok(psb.tree.metadata.variableMetaInfoList[0].defaultValue instanceof Double, '0.0 is written as a double')
  assert.deepEqual([...psb.resources[0]], [...pixels])
  assert.deepEqual([...psb.extras[0]], [...new Uint8Array(new Float32Array([0.5, -1]).buffer)])
  assert.deepEqual([...psb.extras[1]], [7, 7])
  assert.deepEqual(meta.snaps, { '表情_笑': [['face_mouth', 1]] })
  assert.deepEqual(meta.parts, [])
  assert.deepEqual(meta.metadata.base, { chara: 'all_parts', motion: '全体構造' })
  assert.equal(JSON.stringify(meta.metadata.variableMetaInfoList), '[{"defaultValue":0,"id":"face_mouth"}]')
  await assert.rejects(bakeModel({ model: 'm', read: async file => file.endsWith('resx.json') ? Buffer.from('{"PsbVersion":3}') : files[file], inflate, write: async () => {} }), /PSB v4/)
  await assert.rejects(bakeModel({ model: 'm', read: async file => file.endsWith('resx.json') ? Buffer.from('{"PsbVersion":4,"Resources":{"1":"t.png"}}') : files[file], inflate, write: async () => {} }), /索引不连续/)
})
