/** 命令应答里的 `code`（architecture §7.4）；抛出它的地方决定应答是 error 还是 done。 */
export class CommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** 串行队列：后一个任务在前一个落定（无论成败）之后才开始。 */
export class Lane {
  private tail: Promise<void> = Promise.resolve()
  private count = 0

  get pending(): number { return this.count }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.count += 1
    const result = this.tail.then(job)
    this.tail = result.then(() => undefined, () => undefined)
    return result.finally(() => { this.count -= 1 })
  }

  /** 此刻之前入队的任务全部落定。 */
  drained(): Promise<void> { return this.tail }
}

/** 按键分道：同键串行，异键并行；队列清空后释放，避免已删除会话的键残留。 */
export class KeyedLanes {
  private readonly lanes = new Map<string, Lane>()

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key)
    if (!lane) { lane = new Lane(); this.lanes.set(key, lane) }
    const current = lane
    return current.run(job).finally(() => {
      if (current.pending === 0 && this.lanes.get(key) === current) this.lanes.delete(key)
    })
  }

  async drained(): Promise<void> {
    while (this.lanes.size > 0) await Promise.all([...this.lanes.values()].map(lane => lane.drained()))
  }
}
