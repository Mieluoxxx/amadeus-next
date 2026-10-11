import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    // EPERM 说明进程存在但属于别的用户，同样视为占用。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type Owner = { pid: number; startedAt: number | undefined }

/** 兼容只写了 pid 的旧格式。 */
function ownerOf(file: string): Owner {
  const raw = readFileSync(file, 'utf8').trim()
  try {
    const value = JSON.parse(raw)
    if (value && typeof value === 'object') return { pid: Number(value.pid), startedAt: typeof value.startedAt === 'number' ? value.startedAt : undefined }
    return { pid: Number(value), startedAt: undefined }
  } catch { return { pid: Number(raw), startedAt: undefined } }
}

/**
 * 进程的启动时间（毫秒时间戳）；取不到（没有 ps、Windows、进程已不在）返回 undefined。
 * `ps -o lstart=` 在 macOS 与 Linux 上都有，输出本地时间、精度 1 秒；LC_ALL=C 固定成 `Sat Oct 11 10:23:45 2026` 这种可解析的格式。
 */
export function processStartTime(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 2000, windowsHide: true }, (error, stdout) => {
      const parsed = error ? Number.NaN : Date.parse(stdout.trim())
      resolve(Number.isFinite(parsed) ? parsed : undefined)
    })
  })
}

// lstart 只有秒级精度，Linux 上还会随挂起漂移；真正的复用发生在原持有者退出之后，通常相隔很久，所以宽一点没有代价。
const START_SKEW_MS = 30_000

export type AcquireOptions = {
  /** 持有者存活时最多等多久；默认 10 秒（architecture §2.2）。 */
  waitMs?: number
  intervalMs?: number
}

export type ProcessLockOptions = {
  /** 测试接缝：取某个 pid 的进程启动时间。 */
  startTimeOf?: (pid: number) => Promise<number | undefined>
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * durable 存储没有跨进程锁，第二个进程能打开同一个库并接管任务，导致第一个进程中毒（评估 §3.1）。
 * 所以由应用在会话根目录放一个按 pid 判活的锁文件，保证同一时间只有一个 worker 打开任何会话库；先取锁再开任何库。
 * utilityProcess 被 kill() 时不会跑退出钩子，锁会残留，而 pid 可能已被别的进程复用，所以判活还要核对：
 * 该 pid 的进程必须不晚于锁里记录的 startedAt 启动，否则它不是写锁的那个进程。
 */
export class ProcessLock {
  private readonly file: string
  private readonly startTimeOf: (pid: number) => Promise<number | undefined>
  private held = false

  constructor(directory: string, options: ProcessLockOptions = {}) {
    this.file = path.join(directory, '.lock')
    this.startTimeOf = options.startTimeOf ?? processStartTime
  }

  get isHeld(): boolean { return this.held }

  async acquire(options: AcquireOptions = {}): Promise<void> {
    if (this.held) return
    const waitMs = options.waitMs ?? 10_000
    const intervalMs = options.intervalMs ?? 1000
    const deadline = Date.now() + waitMs
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    for (;;) {
      try {
        writeFileSync(this.file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 })
        this.held = true
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      let owner: Owner
      try { owner = ownerOf(this.file) } catch { continue }
      if (!Number.isInteger(owner.pid)) {
        // 刚创建、内容还没写完的锁读出来也是空的：年轻的先等一下，别把别人的锁当垃圾回收了。
        let young = false
        try { young = Date.now() - statSync(this.file).mtimeMs < 1000 } catch { continue }
        if (young) { await sleep(20); continue }
      }
      if (Number.isInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid && alive(owner.pid) && await this.isOwner(owner)) {
        if (Date.now() >= deadline) throw new Error(`Session storage is held by process ${owner.pid}`)
        await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())))
        continue
      }
      // 持有者已退出（崩溃或被强杀）留下的锁，回收后立刻重试。
      try { unlinkSync(this.file) } catch { /* 并发回收时由下一轮的 wx 决胜。 */ }
    }
  }

  /** pid 存活还不够：取得到启动时间且晚于写锁时刻，说明这个 pid 已经属于后来的另一个进程。取不到时按存活处理。 */
  private async isOwner({ pid, startedAt }: Owner): Promise<boolean> {
    if (startedAt === undefined) return true
    const started = await this.startTimeOf(pid)
    return started === undefined || started <= startedAt + START_SKEW_MS
  }

  /** 同步，因为进程退出钩子里只能做同步的事。 */
  release(): void {
    if (!this.held) return
    this.held = false
    try {
      if (ownerOf(this.file).pid === process.pid) unlinkSync(this.file)
    } catch { /* 锁文件已不在，无需处理。 */ }
  }
}
