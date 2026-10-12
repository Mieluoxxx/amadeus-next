export type HandoffLimits = {
  /** 每会话同时运行的任务数；持久状态无法跨存储协调，多个会话合计可超过它。 */
  concurrency: number
  /** queued + running 的上限，避免无限排队的 Reporter。 */
  activeTasks: number
  /** 活跃时间超时（不含确认等待）。 */
  activeTimeoutMs: number
  /** 墙钟上限，给"不断请求确认"的情形兜底。 */
  wallTimeoutMs: number
  /** 子对话各模型桶 totalTokens 之和（含缓存读取，数值偏大）。 */
  tokenLimit: number
  /** 子对话里 deny / expired 的确认次数。 */
  denyLimit: number
  /** deliver / wait-slot 的节拍：检查点提交、用量与超时检查的间隔，也是文档监视之外的兜底。 */
  tickMs: number
  /** 写操作确认的有效期，过期按拒绝计数；进程内计时器，崩溃后工具本来就是 interrupted。 */
  approvalTtlMs: number
  /** task 的 bash 缺省超时（秒）：built-in 的 bash 没有默认超时，卡住的命令会一直占着确认之后的执行。 */
  bashDefaultTimeoutSec: number
  bashMaxTimeoutSec: number
  /** 子代理 report_progress 推送到界面（task.graph）的最小间隔：期间的多次调用只在间隔结束时推最新一条；条目本身总是最新的。 */
  progressIntervalMs: number
  /** remote 的上限：远程开发要跑构建和测试，本机任务那一套 5 分钟的预算不够；只覆盖这几项。 */
  remote: RemoteLimits
}

export type RemoteLimits = Pick<HandoffLimits, 'activeTimeoutMs' | 'wallTimeoutMs' | 'tokenLimit' | 'bashDefaultTimeoutSec' | 'bashMaxTimeoutSec'> & {
  /** 目标连续不可达多久判任务失败；短暂断线由连接层重连，子代理只会看到个别工具调用失败。 */
  offlineMs: number
}

// 初值待原型调整（pi-tool-constraints §3.2）。
export const DEFAULT_LIMITS: HandoffLimits = {
  concurrency: 2,
  activeTasks: 5,
  activeTimeoutMs: 5 * 60_000,
  wallTimeoutMs: 30 * 60_000,
  tokenLimit: 600_000,
  denyLimit: 3,
  tickMs: 5_000,
  approvalTtlMs: 10 * 60_000,
  bashDefaultTimeoutSec: 120,
  bashMaxTimeoutSec: 600,
  progressIntervalMs: 15_000,
  remote: {
    activeTimeoutMs: 60 * 60_000,
    wallTimeoutMs: 4 * 60 * 60_000,
    tokenLimit: 3_000_000,
    bashDefaultTimeoutSec: 600,
    bashMaxTimeoutSec: 3600,
    offlineMs: 2 * 60_000,
  },
}

export const BRIEF_MIN_CHARS = 10
export const BRIEF_MAX_CHARS = 1500
/** handoff_send 的消息上限，与 brief 一致。 */
export const MESSAGE_MAX_CHARS = 1500
export const TITLE_MAX_CHARS = 30
export const PATHS_MAX = 5

export type LimitOverrides = Partial<Omit<HandoffLimits, 'remote'>> & { remote?: Partial<RemoteLimits> }

export function resolveLimits(overrides: LimitOverrides = {}): HandoffLimits {
  return { ...DEFAULT_LIMITS, ...overrides, remote: { ...DEFAULT_LIMITS.remote, ...overrides.remote } }
}

/** 某一类任务实际生效的上限：remote 换上自己的超时与用量，其余项（并发、节拍……）全会话共用。 */
export function limitsFor(limits: HandoffLimits, kind: string): HandoffLimits {
  if (kind !== 'remote') return limits
  const { offlineMs: _offline, ...remote } = limits.remote
  return { ...limits, ...remote }
}
