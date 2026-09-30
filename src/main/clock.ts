/** 计时器接缝：运行时的各种截止时间在测试里可以逐步推进。 */
export type Clock = {
  now(): number
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout> | null | undefined): void
}

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer ?? undefined),
}
