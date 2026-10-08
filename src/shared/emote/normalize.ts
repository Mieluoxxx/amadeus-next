/**
 * 兼容规范化：上游数据是 E-mote 3.03，运行时是 FreeMote WebGL 3.9，按以下顺序逐条补偿（顺序不可调换）：
 * 1. 3.9 不认选择器的 `lower`/`upper` 区间，只按选项序号取值；
 * 2. 被选择器接管的遗留合并口控会覆盖 `face_mouth`，要丢掉；
 * 3. 3.9 不认打包色权 `cw`，中性 RGB 换算成旧版 `opa`，非中性直接报错而不是猜颜色混合；
 * 4. 运行时只认 `ems` 规格与 `RGBA8` 贴图；
 * 5. 顶层合成入口在 3.9 上渲染成黑色剪影，改用模型自己的 `all_parts / 全体構造`。
 */
import { isObject, listOf, member, numberOf, stringOf, truthy, type Tree, type TreeObject } from './value.ts'

export const ENTRY_LABEL = '全体構造'

/** `key` 与界面 i18n 词条一一对应，宿主据此翻译，不解析 message。 */
export class EmoteDataError extends Error {
  readonly key: string
  readonly detail: Record<string, unknown>
  constructor(key: string, message: string, detail: Record<string, unknown> = {}) {
    super(`${key}：${message}`)
    this.key = key
    this.detail = detail
  }
}

type RangedSelector = { label: string; ranges: ([number, number] | null)[] }

function rangedSelectors(metadata: Tree | undefined): RangedSelector[] {
  const selectors: RangedSelector[] = []
  for (const control of listOf(member(metadata, 'selectorControl'))) {
    if (!truthy(member(control, 'enabled'))) continue
    const label = stringOf(member(control, 'label'))
    if (label === undefined) continue
    const options = listOf(member(control, 'optionList'))
    if (!options.some(option => isObject(option) && Object.hasOwn(option, 'lower'))) continue
    // 缺区间的选项必须占位：序号是在完整选项表上数的，漏一项就整体错位。
    const ranges = options.map(option => {
      const lower = numberOf(member(option, 'lower')), upper = numberOf(member(option, 'upper'))
      return lower === undefined || upper === undefined ? null : [lower, upper] as [number, number]
    })
    selectors.push({ label, ranges })
  }
  return selectors
}

function dropLegacyMouthControl(metadata: TreeObject, labels: Set<string>): void {
  const controls = metadata.mouthControl
  if (!Array.isArray(controls)) return
  metadata.mouthControl = controls.filter(control => {
    const label = stringOf(member(control, 'label'))
    return label === undefined || !labels.has(label)
  })
}

function convertSelectorValues(metadata: TreeObject, selectors: RangedSelector[]): void {
  const timelines = listOf(metadata.timelineControl)
  for (const selector of selectors) {
    for (const timeline of timelines) {
      for (const track of listOf(member(timeline, 'variableList'))) {
        if (stringOf(member(track, 'label')) !== selector.label) continue
        for (const frame of listOf(member(track, 'frameList'))) {
          const content = member(frame, 'content')
          if (!isObject(content)) continue
          const value = numberOf(content.value)
          if (value === undefined) continue
          const index = selector.ranges.findIndex(range => range !== null && value >= range[0] && value <= range[1])
          if (index < 0) throw new EmoteDataError('error.selectorRange', `${selector.label}=${value} 超出选择器区间`, { label: selector.label, value })
          content.value = index
        }
      }
    }
  }
  // 按标签而非按对象删区间：同名的未启用副本也必须去掉，否则 3.9 仍会读到区间。
  const labels = new Set(selectors.map(selector => selector.label))
  for (const control of listOf(metadata.selectorControl)) {
    const label = stringOf(member(control, 'label'))
    if (label === undefined || !labels.has(label)) continue
    for (const option of listOf(member(control, 'optionList'))) {
      if (!isObject(option)) continue
      delete option.lower
      delete option.upper
    }
  }
}

/** 与 Rust `f64::round` 一致：半数远离零，`Math.round` 对负半数会朝正无穷取整。 */
const roundHalfAway = (value: number) => Math.sign(value) * Math.round(Math.abs(value))

function convertLayers(layers: Tree[]): void {
  for (const layer of layers) {
    for (const frame of listOf(member(layer, 'frameList'))) {
      const content = member(frame, 'content')
      if (!isObject(content)) continue
      const cw = numberOf(content.cw)
      if (cw === undefined) continue
      const mask = numberOf(content.mask) ?? 0
      // 位运算按 32 位截断，与数据作者端的 JS 语义一致；只处理打了隐藏位的帧。
      if (((mask | 0) & 0x80000000) === 0) continue
      const weight = cw >>> 0
      if (weight >>> 8 !== 0x808080 && weight >>> 8 !== 0x7f7f7f) throw new EmoteDataError('error.cwColor', '暂不支持非中性 cw 颜色权重')
      const previous = numberOf(content.opa) ?? 255
      content.opa = roundHalfAway(previous * (weight & 0xff) / 255)
      content.mask = (((mask | 0) & 0x7fffffff) | 0x400) >>> 0
      delete content.cw
    }
    convertLayers(listOf(member(layer, 'children')))
  }
}

function convertOpacity(model: TreeObject): void {
  const objects = model.object
  if (!isObject(objects)) return
  for (const object of Object.values(objects)) {
    const motions = member(object, 'motion')
    if (!isObject(motions)) continue
    for (const motion of Object.values(motions)) convertLayers(listOf(member(motion, 'layer')))
  }
}

function setSpec(model: TreeObject): void {
  model.spec = 'ems'
  const sources = model.source
  if (!isObject(sources)) return
  for (const source of Object.values(sources)) {
    const texture = member(source, 'texture')
    if (isObject(texture)) texture.type = 'RGBA8'
  }
}

function setBaseEntry(model: TreeObject): void {
  const entry = member(member(member(model.object, 'all_parts'), 'motion'), ENTRY_LABEL)
  if (!truthy(entry)) throw new EmoteDataError('error.missingEntry', `缺少 all_parts/${ENTRY_LABEL} 入口`)
  if (isObject(model.metadata)) model.metadata.base = { chara: 'all_parts', motion: ENTRY_LABEL }
}

/** 就地规范化整棵模型树。 */
export function prepareModel(model: Tree): void {
  if (!isObject(model) || model.metadata === undefined) throw new EmoteDataError('error.missingEntry', '缺少 metadata')
  const selectors = rangedSelectors(model.metadata)
  if (isObject(model.metadata)) {
    dropLegacyMouthControl(model.metadata, new Set(selectors.map(selector => selector.label)))
    convertSelectorValues(model.metadata, selectors)
  }
  convertOpacity(model)
  setSpec(model)
  setBaseEntry(model)
}

export type SnapTracks = [timeline: string, tracks: [label: string, value: number][]][]

/**
 * 摘掉表情时间线里「只有一帧、且落在第 0 帧」的选择器轨道，交给调用方在过渡中点写入。
 * 选择器是离散量（一帧就跳），头身是约 350ms 的线性过渡；不摘就会「脸先啪地变、头身还在移动」。
 */
export function detachSnapTracks(model: Tree): SnapTracks {
  const metadata = member(model, 'metadata')
  const selectors = new Set(listOf(member(metadata, 'selectorControl'))
    .filter(control => truthy(member(control, 'enabled')))
    .map(control => stringOf(member(control, 'label')))
    .filter((label): label is string => label !== undefined))
  const result: SnapTracks = []
  for (const timeline of listOf(member(metadata, 'timelineControl'))) {
    const label = stringOf(member(timeline, 'label'))
    if (label === undefined || !label.startsWith('表情_')) continue
    const detached: [string, number][] = []
    const tracks = member(timeline, 'variableList')
    if (Array.isArray(tracks) && isObject(timeline)) {
      timeline.variableList = tracks.filter(track => {
        const trackLabel = stringOf(member(track, 'label'))
        if (trackLabel === undefined || !selectors.has(trackLabel)) return true
        const keys = listOf(member(track, 'frameList')).filter(frame => truthy(member(frame, 'content')))
        if (keys.length !== 1 || numberOf(member(keys[0], 'time')) !== 0) return true
        const value = numberOf(member(member(keys[0], 'content'), 'value'))
        if (value === undefined) return true
        detached.push([trackLabel, value])
        return false
      })
    }
    result.push([label, detached])
  }
  return result
}
