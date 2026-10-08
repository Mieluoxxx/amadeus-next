/**
 * 烘焙：FreeMote 解包目录（`<model>.psb.m.json` + `.resx.json` + PNG + extra）→ 运行时可直接 `loadData` 的 PSB + 随附 meta。
 * 平台无关：读文件、解压、写出都由调用方注入，Node 与浏览器共用同一份语义。
 */
import { detachSnapTracks, prepareModel } from './normalize.ts'
import { partTable, type PartTable } from './parts.ts'
import { decodePng, readPng, type Inflate, type PngImage } from './png.ts'
import { layoutPsb } from './psb.ts'
import { member, parseModelJson, plainJson } from './value.ts'

/** 烘焙语义或产物格式变化时递增；宿主把它计入缓存指纹，旧缓存随之失效。 */
export const BAKER_VERSION = 'ts-1'

export type EmoteMetadata = {
  variableMetaInfoList: { id: string; defaultValue: number }[]
  eyeControl: { enabled: boolean | number; label: string; varL: string; varR: string }[]
  customSelectorList: { enabled: boolean | number; label: string }[]
  [key: string]: unknown
}
/** 表情时间线 → 需在过渡中点补写的离散轨道。 */
export type Snaps = Record<string, [string, number][]>
export type EmoteMeta = { metadata: EmoteMetadata; snaps: Snaps; parts: PartTable }

export type BakeInput = {
  model: string
  /** 读取模型目录内的相对路径。 */
  read: (path: string) => Promise<Uint8Array>
  inflate: Inflate
  /** 顺序写出 PSB；参数缓冲可能被复用，Promise 结束前必须写完或拷走。 */
  write: (bytes: Uint8Array) => Promise<void>
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** 资源索引键形如 `0` 或 `@3`；解析不了的键与上游一样直接忽略。 */
function indexed(group: unknown): [number, unknown][] {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return []
  const entries: [number, unknown][] = []
  for (const [key, value] of Object.entries(group)) {
    const digits = key.replace(/^@+/, '')
    if (/^\+?\d+$/.test(digits)) entries.push([Number(digits), value])
  }
  return entries.sort((a, b) => a[0] - b[0])
}

function requireDense(indices: number[], what: string): void {
  indices.forEach((index, position) => {
    if (index !== position) throw new Error(`${what} 索引不连续：期望 ${position}，实际 ${index}`)
  })
}

async function extraResources(resx: Record<string, unknown>, read: BakeInput['read']): Promise<Uint8Array[]> {
  const merged = new Map<number, Uint8Array>()
  for (const [index, values] of indexed(resx.ExtraFlattenArrays)) {
    if (!Array.isArray(values)) throw new Error('ExtraFlattenArrays 的值必须是数组')
    const bytes = new Uint8Array(values.length * 4), view = new DataView(bytes.buffer)
    values.forEach((value, position) => {
      if (typeof value !== 'number') throw new Error('扁平数组里出现非数值')
      view.setFloat32(position * 4, value, true)
    })
    merged.set(index, bytes)
  }
  // 同一序号以实体文件为准。
  for (const [index, file] of indexed(resx.ExtraResources)) {
    if (typeof file !== 'string') throw new Error('ExtraResources 的值必须是路径')
    merged.set(index, await read(file))
  }
  const order = [...merged.keys()].sort((a, b) => a - b)
  requireDense(order, '附加资源')
  return order.map(index => merged.get(index)!)
}

export async function bakeModel(input: BakeInput): Promise<EmoteMeta> {
  const text = async (path: string) => decoder.decode(await input.read(path))
  const resx = JSON.parse(await text(`${input.model}.psb.m.resx.json`)) as Record<string, unknown>
  if (resx.PsbVersion !== 4) throw new Error('只支持 PSB v4 资源索引')
  const model = parseModelJson(await text(`${input.model}.psb.m.json`))

  const extras = await extraResources(resx, input.read)
  const textures = indexed(resx.Resources)
  requireDense(textures.map(([index]) => index), 'Resources')
  const images: PngImage[] = []
  for (const [, file] of textures) {
    if (typeof file !== 'string') throw new Error('Resources 的值必须是路径')
    try { images.push(readPng(await input.read(file))) } catch (error) {
      throw new Error(`${file}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  prepareModel(model)
  const snaps = detachSnapTracks(model)
  for (const bytes of layoutPsb(model, extras, images.map(image => image.width * image.height * 4))) await input.write(bytes)
  for (const [position, image] of images.entries()) {
    try { await decodePng(image, input.inflate, input.write) } catch (error) {
      throw new Error(`${textures[position][1]}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const metadata = member(model, 'metadata')
  return {
    metadata: plainJson(metadata) as EmoteMetadata,
    snaps: Object.fromEntries(snaps),
    parts: partTable(metadata),
  }
}
