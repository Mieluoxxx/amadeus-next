import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractEmoteZip } from '../src/main/emoteZip.ts'
import { buildZip } from './zip-fixture.mjs'

async function fixture(t, bytes, overrides) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-zip-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const zip = path.join(root, 'emote.zip')
  await writeFile(zip, bytes ?? Buffer.from(buildZip([], overrides)))
  return { root, zip, into: () => path.join(root, 'out') }
}

test('store 与 deflate 条目都能解开，目录结构还原', async t => {
  const { zip, into } = await fixture(t, Buffer.from(buildZip([
    { name: 'models/kurisu_ab_white/', mode: 0o040755 },
    { name: 'models/kurisu_ab_white/model.psb.m.json', data: Buffer.from('{"a":1}') },
    { name: 'FreeMoteDriver.js', data: Buffer.from('driver'.repeat(500)), method: 8 },
    { name: 'empty.txt' },
  ])))
  await extractEmoteZip(zip, into())
  assert.equal(await readFile(path.join(into(), 'models/kurisu_ab_white/model.psb.m.json'), 'utf8'), '{"a":1}')
  assert.equal(await readFile(path.join(into(), 'FreeMoteDriver.js'), 'utf8'), 'driver'.repeat(500))
  assert.equal(await readFile(path.join(into(), 'empty.txt'), 'utf8'), '')
})

test('越界与不安全的条目名一律拒绝，且不写出目标目录之外', async t => {
  const cases = ['../escape.txt', '/tmp/absolute.txt', 'a/../../escape.txt', 'windows\\path.txt', 'C:/drive.txt', './dot.txt']
  for (const name of cases) {
    const { root, zip, into } = await fixture(t, Buffer.from(buildZip([{ name, data: Buffer.from('x') }])))
    await assert.rejects(extractEmoteZip(zip, into()), /越界|不安全/, `${name} 必须被拒绝`)
    assert.equal(existsSync(path.join(root, 'escape.txt')), false, `${name} 不得写到目标目录之外`)
  }
})

test('符号链接与设备文件条目被拒绝', async t => {
  for (const mode of [0o120777, 0o020666, 0o010644]) {
    const { zip, into } = await fixture(t, Buffer.from(buildZip([{ name: 'link', data: Buffer.from('/etc'), mode }])))
    await assert.rejects(extractEmoteZip(zip, into()), /非普通文件/)
  }
})

test('条目数、单条目大小、压缩比与总量超限都被拒绝', async t => {
  const many = await fixture(t, Buffer.from(buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })))))
  await assert.rejects(extractEmoteZip(many.zip, many.into(), { entries: 4 }), /条目过多/)

  const big = await fixture(t, Buffer.from(buildZip([{ name: 'big', data: Buffer.alloc(2048) }])))
  await assert.rejects(extractEmoteZip(big.zip, big.into(), { entryBytes: 1024 }), /条目过大/)

  // 1 MiB 的零压成约 1 KiB，压缩比远超上限，且不应等写完磁盘才发现。
  const bomb = await fixture(t, Buffer.from(buildZip([{ name: 'bomb', data: Buffer.alloc(1024 * 1024), method: 8 }])))
  await assert.rejects(extractEmoteZip(bomb.zip, bomb.into()), /解压炸弹/)

  const total = await fixture(t, Buffer.from(buildZip([
    { name: 'a', data: Buffer.alloc(1024) }, { name: 'b', data: Buffer.alloc(1024) },
  ])))
  await assert.rejects(extractEmoteZip(total.zip, total.into(), { totalBytes: 1500 }), /总量过大/)
})

test('加密条目、不支持的压缩方法、zip64 与损坏的包都被拒绝', async t => {
  const encrypted = await fixture(t, Buffer.from(buildZip([{ name: 'a', data: Buffer.from('x'), flags: 0x1 }])))
  await assert.rejects(extractEmoteZip(encrypted.zip, encrypted.into()), /加密/)

  const bzip = await fixture(t, Buffer.from(buildZip([{ name: 'a', data: Buffer.from('x'), method: 12 }])))
  await assert.rejects(extractEmoteZip(bzip.zip, bzip.into()), /压缩方法/)

  const zip64 = await fixture(t, Buffer.from(buildZip([], { count: 0xffff })))
  await assert.rejects(extractEmoteZip(zip64.zip, zip64.into()), /zip64/)

  const badCrc = await fixture(t, Buffer.from(buildZip([{ name: 'a', data: Buffer.from('x'), crc: 123 }])))
  await assert.rejects(extractEmoteZip(badCrc.zip, badCrc.into()), /校验失败/)

  const truncated = await fixture(t, Buffer.from(buildZip([{ name: 'a', data: Buffer.from('hello') }])).subarray(0, 40))
  await assert.rejects(extractEmoteZip(truncated.zip, truncated.into()))

  const notZip = await fixture(t, Buffer.from('这是一个普通文件，不是压缩包'))
  await assert.rejects(extractEmoteZip(notZip.zip, notZip.into()), /不是有效的 zip/)
})

test('中央目录条目越界或签名不对时不会读出文件之外', async t => {
  const bytes = buildZip([{ name: 'a', data: Buffer.from('hello') }])
  const lying = await fixture(t, Buffer.from(buildZip([{ name: 'a', data: Buffer.from('hello') }], {
    directoryAt: bytes.length - 22 + 4,
    directoryBytes: 4096,
  })))
  await assert.rejects(extractEmoteZip(lying.zip, lying.into()))

  const junk = await fixture(t, Buffer.from(buildZip([{ name: 'a', data: Buffer.from('hello') }])))
  // 把中央目录签名的第一个字节改掉，模拟损坏的包。
  const damaged = await readFile(junk.zip)
  const at = damaged.length - 22 - 46 - 1
  damaged[at] = 0x00
  await writeFile(junk.zip, damaged)
  await assert.rejects(extractEmoteZip(junk.zip, junk.into()), /签名/)
})

test('解压失败时不做清理，由调用方删临时目录', async t => {
  const { zip, into } = await fixture(t, Buffer.from(buildZip([
    { name: 'good.txt', data: Buffer.from('good') },
    { name: '../escape.txt', data: Buffer.from('bad') },
  ])))
  await mkdir(into(), { recursive: true })
  await assert.rejects(extractEmoteZip(zip, into()))
  assert.equal(await readFile(path.join(into(), 'good.txt'), 'utf8'), 'good', '先解出的条目留在原处，交给调用方处置')
})
