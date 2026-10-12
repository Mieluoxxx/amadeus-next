import { crc32, deflateRawSync } from 'node:zlib'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const EOCD = 0x06054b50

/**
 * 最小 zip 写出器，只给测试用：能造出正常包，也能造出越界路径、符号链接条目、
 * 加密标记、坏校验和这类解压器必须拒绝的包。
 */
export function buildZip(entries, overrides = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? 0
    const body = method === 8 ? deflateRawSync(data) : data
    const crc = entry.crc ?? crc32(data)
    const flags = entry.flags ?? 0
    const mode = entry.mode ?? 0o100644
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD, 0)
  end.writeUInt16LE(overrides.onDisk ?? entries.length, 8)
  end.writeUInt16LE(overrides.count ?? entries.length, 10)
  end.writeUInt32LE(overrides.directoryBytes ?? centralPart.length, 12)
  end.writeUInt32LE(overrides.directoryAt ?? localPart.length, 16)
  return Buffer.concat([localPart, centralPart, end])
}
