/**
 * PSB v4 写出器。值编码与区段顺序沿用 emote-psb（原 Rust 烘焙器所用）：
 * 运行时只验证过这一种布局，贴图数据又放在最后，便于调用方逐张流式写出。
 */
import { Double, isObject, type Tree } from './value.ts'

const utf8 = new TextEncoder()
const RESOURCE = /^#resource([#@])(\+?\d+)$/

/** `#resource#N` 是贴图、`#resource@N` 是附加资源；序号超出 u32 时仍按普通字符串处理。 */
function resourceRef(text: string): { texture: boolean; index: number } | null {
  const match = RESOURCE.exec(text)
  if (!match) return null
  const index = Number(match[2])
  return index > 0xffffffff ? null : { texture: match[1] === '#', index }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) if (a[index] !== b[index]) return a[index] - b[index]
  return a.length - b.length
}

/** 能装下 `value` 的最少字节数（1..8）。 */
function minBytes(value: bigint): number {
  let bytes = 1
  while (bytes < 8 && value >= 1n << BigInt(8 * bytes)) bytes++
  return bytes
}

function littleEndian(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  for (let index = 0; index < bytes; index++) out[index] = Number((value >> BigInt(8 * index)) & 0xffn)
  return out
}

/** 子项相对首个子项的起始偏移。 */
function offsetsOf(parts: Uint8Array[]): number[] {
  let offset = 0
  return parts.map(part => { const start = offset; offset += part.length; return start })
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

/** 无符号整数数组：计数与元素各自取最小宽度，空数组即 `0D 00 0D`。 */
export function uintArray(values: number[]): Uint8Array {
  const count = BigInt(values.length)
  const countBytes = minBytes(count)
  const itemBytes = minBytes(BigInt(values.reduce((max, value) => Math.max(max, value), 0)))
  const out = new Uint8Array(2 + countBytes + itemBytes * values.length)
  out[0] = 0x0c + countBytes
  out.set(littleEndian(count, countBytes), 1)
  out[1 + countBytes] = 0x0c + itemBytes
  let offset = 2 + countBytes
  for (const value of values) {
    let rest = value
    for (let index = 0; index < itemBytes; index++, rest = Math.floor(rest / 256)) out[offset + index] = rest & 0xff
    offset += itemBytes
  }
  return out
}

/** 带前缀长度的索引引用（字符串 0x14、贴图 0x18、附加资源 0x21）。 */
function reference(base: number, index: number): Uint8Array {
  const bytes = minBytes(BigInt(index))
  const out = new Uint8Array(1 + bytes)
  out[0] = base + bytes
  out.set(littleEndian(BigInt(index), bytes), 1)
  return out
}

function integer(value: number): Uint8Array {
  if (value === 0) return Uint8Array.of(0x04)
  const big = BigInt(value)
  // 负数按 u64 左移一位后取宽度，结果总是 8 字节；与 emote-psb 保持一致。
  const bytes = big < 0n ? 8 : minBytes(big << 1n)
  const out = new Uint8Array(1 + bytes)
  out[0] = 0x04 + bytes
  out.set(littleEndian(BigInt.asUintN(64, big), bytes), 1)
  return out
}

function double(value: number): Uint8Array {
  const out = new Uint8Array(9)
  out[0] = 0x1f
  new DataView(out.buffer).setFloat64(1, value, true)
  return out
}

/** 名字 trie（双数组）：线性找空槽即可，名字只有几百个。 */
export function nameTable(names: Uint8Array[]): [number[], number[], number[]] {
  type Node = { children: Map<number, Node>; id: number; index: number }
  if (!names.length) return [[1], [0], []]
  const root: Node = { children: new Map(), id: 0, index: -1 }
  names.forEach((name, index) => {
    let node = root
    for (const byte of [...name, 0]) {
      let child = node.children.get(byte)
      if (!child) { child = { children: new Map(), id: 0, index: -1 }; node.children.set(byte, child) }
      node = child
    }
    node.index = index
  })
  const offsets: number[] = [1], tree: number[] = [0], indexes: number[] = []
  const used = new Set([0])
  const visit = (node: Node) => {
    if (!node.children.size) { offsets[node.id] = node.index; indexes[node.index] = node.id; return }
    const codes = [...node.children.keys()]
    let base = 1
    while (codes.some(code => used.has(base + code))) base++
    offsets[node.id] = base
    for (const [code, child] of node.children) {
      child.id = base + code
      tree[child.id] = node.id
      used.add(child.id)
    }
    for (const child of node.children.values()) visit(child)
  }
  visit(root)
  return [Array.from(offsets, value => value ?? 0), Array.from(tree, value => value ?? 0), indexes]
}

/**
 * 编码模型树与附加资源，返回贴图数据之前的全部字节；贴图只给长度，由调用方随后按序追加原始数据。
 * 资源引用越界在这里就报错：运行时遇到悬空引用不会报错，只会画错。
 */
export function layoutPsb(model: Tree, extras: Uint8Array[], textureLengths: number[]): Uint8Array[] {
  const keys = new Map<string, Uint8Array>(), strings = new Map<string, Uint8Array>()
  const collect = (value: Tree) => {
    if (Array.isArray(value)) value.forEach(collect)
    else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (!keys.has(key)) {
          if (key.includes('\0')) throw new Error(`字段名含 NUL：${JSON.stringify(key)}`)
          keys.set(key, utf8.encode(key))
        }
        collect(child)
      }
    } else if (typeof value === 'string' && !strings.has(value) && !resourceRef(value)) {
      if (value.includes('\0')) throw new Error(`字符串含 NUL：${JSON.stringify(value)}`)
      strings.set(value, utf8.encode(value))
    }
  }
  collect(model)
  // 按 UTF-8 字节排序（即码点序），而不是 JS 默认的 UTF-16 码元序。
  const sorted = (table: Map<string, Uint8Array>) => [...table].sort((a, b) => compareBytes(a[1], b[1]))
  const names = sorted(keys), stringList = sorted(strings)
  const nameIds = new Map(names.map(([key], index) => [key, index]))
  const stringIds = new Map(stringList.map(([text], index) => [text, index]))

  const encode = (value: Tree): Uint8Array => {
    if (value === null) return Uint8Array.of(0x01)
    if (typeof value === 'boolean') return Uint8Array.of(value ? 0x03 : 0x02)
    if (value instanceof Double) return double(value.value)
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`无法编码非有限数值：${value}`)
      return Number.isInteger(value) && Math.abs(value) < 2 ** 63 ? integer(value) : double(value)
    }
    if (typeof value === 'string') {
      const ref = resourceRef(value)
      if (!ref) return reference(0x14, stringIds.get(value)!)
      if (ref.index >= (ref.texture ? textureLengths.length : extras.length)) throw new Error(`模型引用了不存在的资源：${value}`)
      return reference(ref.texture ? 0x18 : 0x21, ref.index)
    }
    if (Array.isArray(value)) {
      const parts = value.map(encode)
      return join([Uint8Array.of(0x20), uintArray(offsetsOf(parts)), ...parts])
    }
    const ordered = Object.keys(value).sort((a, b) => nameIds.get(a)! - nameIds.get(b)!)
    const parts = ordered.map(key => encode(value[key]))
    return join([Uint8Array.of(0x21), uintArray(ordered.map(key => nameIds.get(key)!)), uintArray(offsetsOf(parts)), ...parts])
  }

  const header = new Uint8Array(56), view = new DataView(header.buffer)
  header.set([0x50, 0x53, 0x42, 0x00, 0x04, 0x00, 0x00, 0x00])
  view.setUint32(8, 56, true)
  const head: Uint8Array[] = [header]
  let position = header.length
  const section = (field: number | null, bytes: Uint8Array) => {
    if (field !== null) view.setUint32(field, position, true)
    head.push(bytes)
    position += bytes.length
  }
  section(12, join(nameTable(names.map(([, bytes]) => bytes)).map(uintArray)))
  section(36, encode(model))
  let stringOffset = 0
  const stringData = stringList.map(([, bytes]) => join([bytes, Uint8Array.of(0)]))
  section(16, uintArray(stringData.map(bytes => { const start = stringOffset; stringOffset += bytes.length; return start })))
  section(20, join(stringData))
  const pool = (lengths: number[], field: number) => {
    let total = 0
    section(field, uintArray(lengths.map(length => { const start = total; total += length; return start })))
    section(field + 4, uintArray(lengths))
    view.setUint32(field + 8, position, true)
  }
  pool(extras.map(bytes => bytes.length), 44)
  for (const bytes of extras) section(null, bytes)
  pool(textureLengths, 24)

  let a = 1, b = 0
  for (const byte of [...header.subarray(8, 40), ...header.subarray(44, 56)]) { a = (a + byte) % 65521; b = (b + a) % 65521 }
  view.setUint32(40, ((b << 16) | a) >>> 0, true)
  return head
}
