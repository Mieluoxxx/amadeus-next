/**
 * 部件显隐查表：3.9 运行时不会按选择器推导部件开关，消费方每帧要把结果写回去。
 * 烘焙时把映射展开成「选中某个选项时要写哪些变量」，场景侧每帧只做一次区间查找。
 */
import { listOf, member, numberOf, stringOf, truthy, type Tree } from './value.ts'

export type PartOption = { lower: number; upper: number; writes: Record<string, number> }
export type PartSelector = { label: string; defaultValue: number; options: PartOption[] }
export type PartTable = PartSelector[]

type Option = { lower: number; upper: number; label?: string; onValue?: number; offValue?: number }

function defaultOf(metadata: Tree | undefined, label: string): number {
  const variable = listOf(member(metadata, 'variableMetaInfoList')).find(entry => stringOf(member(entry, 'id')) === label)
  return numberOf(member(variable, 'defaultValue')) ?? 0
}

export function partTable(metadata: Tree | undefined): PartTable {
  const table: PartTable = []
  for (const control of listOf(member(metadata, 'customSelectorList'))) {
    if (!truthy(member(control, 'enabled'))) continue
    const label = stringOf(member(control, 'label'))
    if (label === undefined) continue
    const options: Option[] = []
    for (const option of listOf(member(control, 'optionList'))) {
      const lower = numberOf(member(option, 'lower')), upper = numberOf(member(option, 'upper'))
      // 没有数值区间的选项永远命中不了，直接丢掉，避免它参与 onValue/offValue 写入。
      if (lower === undefined || upper === undefined) continue
      options.push({
        lower, upper,
        label: stringOf(member(option, 'label')) || undefined,
        onValue: numberOf(member(option, 'onValue')),
        offValue: numberOf(member(option, 'offValue')),
      })
    }
    table.push({
      label,
      defaultValue: defaultOf(metadata, label),
      options: options.map((option, selected) => {
        const writes: Record<string, number> = {}
        for (const [index, other] of options.entries()) {
          if (!other.label) continue
          const outcome = index === selected ? other.onValue : other.offValue
          if (outcome !== undefined) writes[other.label] = outcome
        }
        return { lower: option.lower, upper: option.upper, writes }
      }),
    })
  }
  return table
}
