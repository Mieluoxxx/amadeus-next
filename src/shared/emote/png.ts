/**
 * PNG → 紧密 RGBA8，不经过 canvas：浏览器 canvas 会预乘 alpha，alpha=0 像素的 RGB 被抹成 0、低 alpha 色阶丢失，
 * 而运行时需要原样的直通 alpha。解压由调用方注入（Node 用 zlib，浏览器用 DecompressionStream）。
 */

export type Inflate = (chunks: Uint8Array[]) => AsyncIterable<Uint8Array>
export type PngImage = { width: number; height: number; idat: Uint8Array[] }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 只解析结构，不解压；FreeMote 解出的图集都是 8 位 RGBA 非隔行，其余格式明确拒绝而不是猜。 */
export function readPng(bytes: Uint8Array): PngImage {
  if (bytes.length < 33 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) throw new Error('不是 PNG 文件')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (type(12) !== 'IHDR') throw new Error('PNG 缺少 IHDR')
  const width = view.getUint32(16), height = view.getUint32(20)
  const [depth, color, compression, filter, interlace] = bytes.subarray(24, 29)
  if (!width || !height) throw new Error('PNG 尺寸无效')
  if (depth !== 8 || color !== 6) throw new Error(`不支持的贴图格式：位深 ${depth} / 颜色类型 ${color}（只支持 8 位 RGBA）`)
  if (compression !== 0 || filter !== 0) throw new Error('PNG 压缩或滤波方法无效')
  if (interlace !== 0) throw new Error('不支持的贴图格式：隔行 PNG')
  const idat: Uint8Array[] = []
  for (let offset = 8; ;) {
    if (offset + 12 > bytes.length) throw new Error('PNG 数据截断')
    const length = view.getUint32(offset), chunk = type(offset + 4)
    if (offset + 12 + length > bytes.length) throw new Error('PNG 数据截断')
    if (chunk === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    if (chunk === 'IEND') break
    offset += 12 + length
  }
  if (!idat.length) throw new Error('PNG 缺少图像数据')
  return { width, height, idat }
}

/**
 * 逐行反滤波，攒满一批就交给 `emit`；内存只与行宽有关，4096 宽的图集解码时只占几 MB。
 * 批缓冲会被复用：`emit` 返回的 Promise 结束前必须用完或拷走数据。
 */
export async function decodePng(image: PngImage, inflate: Inflate, emit: (rgba: Uint8Array) => Promise<void>, batchBytes = 4 << 20): Promise<void> {
  const stride = image.width * 4, rowLength = stride + 1
  const batchRows = Math.max(1, Math.floor(batchBytes / stride))
  const batch = new Uint8Array(batchRows * stride)
  let previous = new Uint8Array(stride), current = new Uint8Array(stride)
  const pending = new Uint8Array(rowLength)
  let filled = 0, rows = 0, inBatch = 0

  const finishRow = () => {
    const filter = pending[0], raw = pending.subarray(1)
    if (filter === 0) current.set(raw)
    else if (filter === 1) {
      for (let x = 0; x < 4; x++) current[x] = raw[x]
      for (let x = 4; x < stride; x++) current[x] = raw[x] + current[x - 4]
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++) current[x] = raw[x] + previous[x]
    } else if (filter === 3) {
      for (let x = 0; x < 4; x++) current[x] = raw[x] + (previous[x] >> 1)
      for (let x = 4; x < stride; x++) current[x] = raw[x] + ((current[x - 4] + previous[x]) >> 1)
    } else if (filter === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? current[x - 4] : 0, b = previous[x], c = x >= 4 ? previous[x - 4] : 0
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        current[x] = raw[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
    } else throw new Error(`PNG 滤波类型无效：${filter}`)
    batch.set(current, inBatch * stride)
    inBatch++; rows++
    ;[previous, current] = [current, previous]
  }

  for await (const chunk of inflate(image.idat)) {
    for (let index = 0; index < chunk.length;) {
      if (rows === image.height) throw new Error('PNG 图像数据多于声明尺寸')
      const take = Math.min(rowLength - filled, chunk.length - index)
      pending.set(chunk.subarray(index, index + take), filled)
      filled += take; index += take
      if (filled < rowLength) continue
      filled = 0
      finishRow()
      if (inBatch === batchRows || rows === image.height) { await emit(batch.subarray(0, inBatch * stride)); inBatch = 0 }
    }
  }
  if (rows !== image.height || filled) throw new Error('PNG 图像数据少于声明尺寸')
}
