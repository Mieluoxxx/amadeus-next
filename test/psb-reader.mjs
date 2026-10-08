// 仅供测试的 PSB v4 读取器：验证写出器的产物能按格式读回，不参与产品链路。
import { Double } from '../src/shared/emote/value.ts'

export function readPsb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = at => view.getUint32(at, true)
  const uint = (at, size) => { let value = 0n; for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]); return value }
  const uintArray = at => {
    const countSize = bytes[at] - 0x0c, count = Number(uint(at + 1, countSize))
    const itemSize = bytes[at + 1 + countSize] - 0x0c, start = at + 2 + countSize
    return { values: Array.from({ length: count }, (_, i) => Number(uint(start + i * itemSize, itemSize))), end: start + count * itemSize }
  }
  const header = Object.fromEntries([['names', 12], ['strings', 16], ['stringData', 20], ['resourceOffsets', 24], ['resourceLengths', 28], ['resourceData', 32], ['entry', 36], ['checksum', 40], ['extraOffsets', 44], ['extraLengths', 48], ['extraData', 52]].map(([key, at]) => [key, u32(at)]))

  const offsets = uintArray(header.names), tree = uintArray(offsets.end), indexes = uintArray(tree.end)
  const decoder = new TextDecoder()
  const names = indexes.values.map(terminal => {
    const chars = []
    for (let id = tree.values[terminal]; id !== 0;) { const parent = tree.values[id]; chars.push(id - offsets.values[parent]); id = parent }
    return decoder.decode(Uint8Array.from(chars.reverse()))
  })
  const stringOffsets = uintArray(header.strings).values
  const strings = stringOffsets.map(offset => {
    const start = header.stringData + offset
    return decoder.decode(bytes.subarray(start, bytes.indexOf(0, start)))
  })

  const value = at => {
    const tag = bytes[at]
    if (tag === 0x01) return null
    if (tag === 0x02 || tag === 0x03) return tag === 0x03
    if (tag >= 0x04 && tag <= 0x0c) return Number(BigInt.asIntN((tag - 0x04) * 8 || 8, uint(at + 1, tag - 0x04)))
    if (tag === 0x1f) { const number = view.getFloat64(at + 1, true); return Number.isInteger(number) ? new Double(number) : number }
    if (tag >= 0x15 && tag <= 0x18) return strings[Number(uint(at + 1, tag - 0x14))]
    if (tag >= 0x19 && tag <= 0x1c) return `#resource#${uint(at + 1, tag - 0x18)}`
    if (tag >= 0x22 && tag <= 0x25) return `#resource@${uint(at + 1, tag - 0x21)}`
    if (tag === 0x20) {
      const children = uintArray(at + 1)
      return children.values.map(offset => value(children.end + offset))
    }
    if (tag === 0x21) {
      const keys = uintArray(at + 1), children = uintArray(keys.end)
      return Object.fromEntries(keys.values.map((key, i) => [names[key], value(children.end + children.values[i])]))
    }
    throw new Error(`unknown PSB tag 0x${tag.toString(16)} at ${at}`)
  }
  const pool = (offsetsAt, lengthsAt, dataAt) => {
    const starts = uintArray(offsetsAt).values, lengths = uintArray(lengthsAt).values
    return starts.map((start, i) => bytes.subarray(dataAt + start, dataAt + start + lengths[i]))
  }
  return {
    header, names, strings,
    tree: value(header.entry),
    resources: pool(header.resourceOffsets, header.resourceLengths, header.resourceData),
    extras: pool(header.extraOffsets, header.extraLengths, header.extraData),
  }
}
