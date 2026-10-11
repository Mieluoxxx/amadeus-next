import type { MemoryBaselineState, SnapshotReason } from './kinds.ts'
import { renderUpdate, utf8Bytes, type MemoryItem } from './render.ts'
import { RENDER_ORDER, type MemoryType } from './types.ts'

// 增量累计超过 max(快照字节, 4096) 就重新冻结（long-term-memory.md §4.3 第 6 行）。
const UPDATE_BUDGET_FLOOR = 4096

export type PlanInput = {
  baseline: MemoryBaselineState
  current: readonly MemoryItem[]
  /** 活动上下文的起点：最新压缩头或重置条目的 head；没有则为 undefined。 */
  activeHead: number | undefined
}

export type Plan =
  | { kind: 'none' }
  // 快照已不在上下文里，而新旧内容都是空的：只需要把基线复位。
  | { kind: 'forget-snapshot' }
  | { kind: 'snapshot'; reason: SnapshotReason; omit: number[] }
  | { kind: 'refreeze' }
  | { kind: 'update'; added: MemoryItem[]; removed: MemoryItem[]; text: string }

function sameBodies(effective: MemoryBaselineState['effective'], current: readonly MemoryItem[]): boolean {
  const left = Object.values(effective).map(item => item.body).sort()
  const right = current.map(item => item.body).sort()
  return left.length === right.length && left.every((body, index) => body === right[index])
}

/** 纯函数，按文档 §4.3 的判定表从上到下取第一条命中的。重新冻结只由"内容清空"与"增量超预算"触发。 */
export function plan({ baseline, current, activeHead }: PlanInput): Plan {
  const effectiveEmpty = Object.keys(baseline.effective).length === 0
  if (baseline.snapshotEntryId === null) {
    return current.length === 0 ? { kind: 'none' } : { kind: 'snapshot', reason: 'first', omit: [] }
  }
  // 对范围外的快照做 replace 不会生效也不报错，所以必须追加新快照，不能退化成重新冻结。
  if (activeHead !== undefined && activeHead > baseline.snapshotEntryId) {
    if (effectiveEmpty && current.length === 0) return { kind: 'forget-snapshot' }
    const omit = baseline.updateEntryIds.filter(id => id >= activeHead)
    return { kind: 'snapshot', reason: 'compaction', omit }
  }
  if (sameBodies(baseline.effective, current)) return { kind: 'none' }
  if (current.length === 0) return { kind: 'refreeze' }

  const currentBodies = new Set(current.map(item => item.body))
  const effectiveItems: MemoryItem[] = Object.entries(baseline.effective)
    .map(([id, item]) => ({ id, type: item.type, body: item.body }))
    .sort((a, b) => (RENDER_ORDER[a.type as MemoryType] ?? 99) - (RENDER_ORDER[b.type as MemoryType] ?? 99) || (a.id < b.id ? -1 : 1))
  const effectiveBodies = new Set(effectiveItems.map(item => item.body))
  const added = current.filter(item => !effectiveBodies.has(item.body))
  const removed = effectiveItems.filter(item => !currentBodies.has(item.body))
  const text = renderUpdate(added, removed)
  if (baseline.updateBytes + utf8Bytes(text) > Math.max(baseline.snapshotBytes, UPDATE_BUDGET_FLOOR)) {
    return { kind: 'refreeze' }
  }
  return { kind: 'update', added, removed, text }
}
