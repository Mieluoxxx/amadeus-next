/**
 * emote.zip 的解压。只认 store 与 deflate 两种压缩方法——够用，而且安全边界能自己拿捏。
 *
 * 为什么不用系统的 unzip / ditto：它们照着压缩包建符号链接，对路径逃逸与解压炸弹不作保证。
 * 这里一律以中央目录为准（本地头的大小字段在带数据描述符时可能是 0），逐条目拒绝四类东西：
 * 逃出目标目录的路径（zip-slip）、符号链接与设备/管道等非普通文件条目、加密条目、zip64。
 * 调用方负责给一个空目录，并在失败时删掉它。
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, stat, writeFile, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createInflateRaw } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_BYTES = 22
const CENTRAL_BYTES = 46
const LOCAL_BYTES = 30
const MAX_COMMENT = 0xffff
const ZIP64 = 0xffffffff

export type ZipLimits = {
  /** 条目数上限。 */
  entries: number
  /** 单条目解压后字节上限。 */
  entryBytes: number
  /** 全部条目解压后字节上限。 */
  totalBytes: number
  /** 单条目压缩比上限，超过即当作解压炸弹。 */
  ratio: number
  /** 整个解压的超时。 */
  timeoutMs: number
}

/** 实际的分发包是 125 MB / 36 个条目，这里留了两个数量级的余量。 */
const DEFAULT_LIMITS: ZipLimits = {
  entries: 2000,
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  ratio: 200,
  timeoutMs: 60_000,
}

/** 只接受普通文件与目录。0 是 Windows 制造的包（外部属性里没有 UNIX 模式）。 */
const FILE_TYPES = new Set([0, 0o100000, 0o040000])

/** 条目名映射到目标路径；越界、绝对路径、反斜杠分隔、`.`/`..` 段一律拒绝。 */
function targetOf(destination: string, name: string): string | undefined {
  if (!name || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return undefined
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name
  if (!trimmed) return undefined
  const parts = trimmed.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  const target = path.join(destination, ...parts)
  const relative = path.relative(destination, target)
  return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : target
}

/** FileHandle.read 不保证一次读满。 */
async function readExactly(handle: FileHandle, bytes: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes)
  let done = 0
  while (done < bytes) {
    const { bytesRead } = await handle.read(buffer, done, bytes - done, position + done)
    if (bytesRead === 0) throw new Error('不是有效的 zip：文件被截断')
    done += bytesRead
  }
  return buffer
}

/** 边解压边计数与算校验和，越限立刻中断，不等整条条目写完磁盘。 */
async function writeEntry(
  zipPath: string, dataAt: number, compressed: number, raw: number, method: number,
  declaredCrc: number, name: string, target: string, limits: ZipLimits, signal: AbortSignal,
): Promise<void> {
  if (compressed === 0) {
    await writeFile(target, Buffer.alloc(0))
    if (raw !== 0) throw new Error(`压缩包条目损坏：${name}`)
    return
  }
  let written = 0
  let checksum = 0
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length
      if (written > limits.entryBytes) return callback(new Error(`压缩包条目过大：${name}`))
      checksum = crc32(chunk, checksum)
      callback(null, chunk)
    },
  })
  const source = createReadStream(zipPath, { start: dataAt, end: dataAt + compressed - 1, signal })
  const stream = method === 8 ? source.pipe(createInflateRaw()) : source
  await pipeline(stream, guard, createWriteStream(target), { signal })
  if (written !== raw) throw new Error(`压缩包条目大小不符（${name}：声明 ${raw}，实际 ${written}）`)
  if (checksum !== declaredCrc) throw new Error(`压缩包条目校验失败，文件可能已损坏：${name}`)
}

/**
 * 把 emote.zip 解到 destination。destination 必须是空的：这里不做任何覆盖保护，
 * 冲突与回滚由调用方按「临时目录 → 校验 → 原子替换」的方式处理。
 */
export async function extractEmoteZip(zipPath: string, destination: string, overrides: Partial<ZipLimits> = {}): Promise<void> {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const signal = AbortSignal.timeout(limits.timeoutMs)
  const size = (await stat(zipPath)).size
  if (size < EOCD_BYTES) throw new Error('不是有效的 zip：文件太短')
  const handle = await open(zipPath, 'r')
  try {
    // 结尾记录在文件尾部，注释最长 64 KiB，从后往前找签名。
    const tailBytes = Math.min(size, EOCD_BYTES + MAX_COMMENT)
    const tail = await readExactly(handle, tailBytes, size - tailBytes)
    let end = -1
    for (let at = tailBytes - EOCD_BYTES; at >= 0; at--) if (tail.readUInt32LE(at) === EOCD_SIGNATURE) { end = at; break }
    if (end < 0) throw new Error('不是有效的 zip：找不到中央目录结尾')
    const count = tail.readUInt16LE(end + 10)
    const directoryBytes = tail.readUInt32LE(end + 12)
    const directoryAt = tail.readUInt32LE(end + 16)
    if (count === 0xffff || directoryBytes === ZIP64 || directoryAt === ZIP64) throw new Error('不支持 zip64 格式的压缩包')
    if (count > limits.entries) throw new Error(`压缩包条目过多（${count}，上限 ${limits.entries}）`)
    if (directoryAt + directoryBytes > size) throw new Error('不是有效的 zip：中央目录越界')
    const directory = await readExactly(handle, directoryBytes, directoryAt)

    let cursor = 0
    let total = 0
    for (let index = 0; index < count; index++) {
      if (cursor + CENTRAL_BYTES > directoryBytes) throw new Error('不是有效的 zip：中央目录条目不完整')
      if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('不是有效的 zip：中央目录条目签名不对')
      const flags = directory.readUInt16LE(cursor + 8)
      const method = directory.readUInt16LE(cursor + 10)
      const declaredCrc = directory.readUInt32LE(cursor + 16)
      const compressed = directory.readUInt32LE(cursor + 20)
      const raw = directory.readUInt32LE(cursor + 24)
      const nameBytes = directory.readUInt16LE(cursor + 28)
      const extraBytes = directory.readUInt16LE(cursor + 30)
      const commentBytes = directory.readUInt16LE(cursor + 32)
      const external = directory.readUInt32LE(cursor + 38)
      const localAt = directory.readUInt32LE(cursor + 42)
      if (cursor + CENTRAL_BYTES + nameBytes + extraBytes + commentBytes > directoryBytes) throw new Error('不是有效的 zip：条目长度越界')
      const name = directory.subarray(cursor + CENTRAL_BYTES, cursor + CENTRAL_BYTES + nameBytes).toString('utf8')
      cursor += CENTRAL_BYTES + nameBytes + extraBytes + commentBytes

      if (compressed === ZIP64 || raw === ZIP64 || localAt === ZIP64) throw new Error('不支持 zip64 格式的压缩包')
      if (flags & 0x1) throw new Error(`压缩包里有加密条目：${name}`)
      if (method !== 0 && method !== 8) throw new Error(`压缩包用了不支持的压缩方法（${method}）：${name}`)
      const target = targetOf(destination, name)
      if (!target) throw new Error(`压缩包里有越界或不安全的路径：${name}`)
      const kind = (external >>> 16) & 0xf000
      if (!FILE_TYPES.has(kind)) throw new Error(`压缩包里有非普通文件条目（符号链接或设备文件）：${name}`)
      if (kind === 0o040000 || name.endsWith('/')) { await mkdir(target, { recursive: true }); continue }
      if (raw > limits.entryBytes) throw new Error(`压缩包条目过大：${name}`)
      if (compressed > 0 && raw / compressed > limits.ratio) throw new Error(`压缩比过高，疑似解压炸弹：${name}`)
      total += raw
      if (total > limits.totalBytes) throw new Error(`解压后总量过大（上限 ${limits.totalBytes} 字节）`)

      const local = await readExactly(handle, LOCAL_BYTES, localAt)
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`压缩包条目损坏：${name}`)
      const dataAt = localAt + LOCAL_BYTES + local.readUInt16LE(26) + local.readUInt16LE(28)
      if (dataAt + compressed > size) throw new Error(`压缩包条目越界：${name}`)
      await mkdir(path.dirname(target), { recursive: true })
      await writeEntry(zipPath, dataAt, compressed, raw, method, declaredCrc, name, target, limits, signal)
    }
  } catch (error) {
    if (signal.aborted) throw new Error(`解压超时（超过 ${limits.timeoutMs} 毫秒）`)
    throw error
  } finally {
    await handle.close()
  }
}
