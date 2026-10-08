/** 模型树沿用 FreeMote 解包 JSON 的形状；只有「数值写成小数的整数」需要额外标记。 */
export type Tree = null | boolean | number | string | Double | Tree[] | { [key: string]: Tree }
export type TreeObject = { [key: string]: Tree }

/**
 * JSON 里写成 `1.0`、`1e2`、`-0` 的整数。
 * JS 解析后与 `1` 无法区分，但 PSB 按书写区分整数与双精度，运行时也按字段类型取值，必须保留原样。
 */
export class Double {
  readonly value: number
  constructor(value: number) { this.value = value }
  toJSON(): number { return this.value }
}

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown

/** 借 `JSON.parse` 的源文本访问（Node 21+）按书写判断数值类型，与 serde_json 的整数/浮点划分一致。 */
export function parseModelJson(text: string): Tree {
  const reviver: Reviver = (_key, value, context) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return value
    const source = context?.source
    if (source === undefined) throw new Error('当前运行时不支持 JSON 源文本访问，无法区分整数与浮点')
    return /[.eE]/.test(source) || Object.is(value, -0) ? new Double(value) : value
  }
  return JSON.parse(text, reviver as (this: unknown, key: string, value: unknown) => unknown) as Tree
}

export function isObject(value: Tree | undefined): value is TreeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Double)
}

export function member(value: Tree | undefined, key: string): Tree | undefined {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined
}

export function numberOf(value: Tree | undefined): number | undefined {
  if (typeof value === 'number') return value
  return value instanceof Double ? value.value : undefined
}

export function stringOf(value: Tree | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 非列表一律视作空列表，与上游「缺字段就跳过」的宽松读取一致。 */
export function listOf(value: Tree | undefined): Tree[] {
  return Array.isArray(value) ? value : []
}

/** JS 真值语义：对象与列表恒为真（哪怕为空），否则 `all_parts/全体構造` 这类空对象入口会被误判缺失。 */
export function truthy(value: Tree | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 0
  const number = numberOf(value)
  return number === undefined ? true : number !== 0
}

/** 转回普通 JSON 并按 UTF-16 码元排序键，使 meta 输出稳定、便于对照。 */
export function plainJson(value: Tree | undefined): unknown {
  if (value === undefined) return null
  if (value instanceof Double) return value.value
  if (Array.isArray(value)) return value.map(plainJson)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, plainJson(value[key])]))
}
