/**
 * 一个回合从"主人说完"到"开口"的关键路径打点（AOE 图的各个事件）。每个点只记第一次；回合结束时输出一行分解，
 * 按发生时间排列，每段是相对前一个点的增量；缺的点（文字模式没有配音、汇报回合没有识别）直接跳过。
 */
export const LATENCY_STAGES = ['heard', 'final', 'begin', 'submitted', 'text', 'line', 'fish', 'directed', 'audio', 'playing'] as const
export type LatencyStage = (typeof LATENCY_STAGES)[number]

export class TurnLatency {
  private readonly marks = new Map<LatencyStage, number>()
  private readonly now: () => number

  constructor(now: () => number, earlier: Partial<Record<LatencyStage, number>> = {}) {
    this.now = now
    for (const stage of LATENCY_STAGES) if (earlier[stage] !== undefined) this.marks.set(stage, earlier[stage]!)
  }

  mark(stage: LatencyStage): void {
    if (!this.marks.has(stage)) this.marks.set(stage, this.now())
  }

  has(stage: LatencyStage): boolean { return this.marks.has(stage) }

  /** `final +1500ms begin +3ms …  total 4210ms`：总计从最早的点算到最晚的点。 */
  summary(): string {
    // 按时间排：Fish 握手与主模型并行，它可能先于首段文字完成。
    const points = [...this.marks.entries()].sort((left, right) => left[1] - right[1])
    if (points.length < 2) return ''
    const parts = points.map(([stage, at], index) => index === 0 ? stage : `+${Math.round(at - points[index - 1][1])}ms ${stage}`)
    return `${parts.join(' ')}  total ${Math.round(points.at(-1)![1] - points[0][1])}ms`
  }
}
