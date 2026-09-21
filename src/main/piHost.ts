import { randomUUID } from 'node:crypto'
import type { UtilityProcess } from 'electron'

type Json = Record<string, unknown>
type Callbacks = { onText?: (delta: string) => void; onTool?: (name: string, done: boolean) => void }

export class PiHost {
  private readonly fork: () => UtilityProcess
  private process: UtilityProcess | null = null
  private starting: Promise<UtilityProcess> | null = null
  private restarting: Promise<void> | null = null
  private disposed = false
  private readonly failures = new WeakMap<UtilityProcess, Error>()
  private readonly children = new Set<UtilityProcess>()
  private readonly pending = new Map<string, Callbacks & {
    owner: UtilityProcess
    resolve: (value: Json) => void
    reject: (error: Error) => void
  }>()
  error = ''

  constructor(fork: () => UtilityProcess) { this.fork = fork }

  async init(): Promise<void> {
    try { await this.ensureStarted() } catch (error) { this.error = String(error) }
  }

  private spawnReady(): Promise<UtilityProcess> {
    const child = this.fork()
    this.children.add(child)
    return new Promise((resolve, reject) => {
      let ready = false
      const fail = (error: Error) => {
        this.failures.set(child, error)
        clearTimeout(timer)
        if (!ready) reject(error)
        if (this.process === child) { this.process = null; this.error = error.message }
        for (const [id, pending] of this.pending) {
          if (pending.owner !== child) continue
          this.pending.delete(id)
          pending.reject(error)
        }
      }
      const timer = setTimeout(() => { fail(new Error('Pi startup timed out')); child.kill() }, 20000)
      child.on('message', (message: Json) => {
        if (message?.type === 'ready') {
          if (ready || this.failures.has(child)) return
          clearTimeout(timer)
          if (message.error) { fail(new Error(String(message.error))); child.kill(); return }
          ready = true
          resolve(child)
          return
        }
        const id = String(message?.id || '')
        const pending = this.pending.get(id)
        if (!pending || pending.owner !== child) return
        if (message.type === 'text') pending.onText?.(String(message.delta || ''))
        else if (message.type === 'tool') pending.onTool?.(String(message.name || 'tool'), message.done === true)
        else if (['done', 'error', 'aborted'].includes(String(message.type))) {
          this.pending.delete(id)
          if (message.type === 'error') pending.reject(new Error(String(message.error || 'Pi request failed')))
          else pending.resolve(message)
        }
      })
      child.on('exit', code => { this.children.delete(child); fail(new Error(`Pi utility process exited (${code})`)) })
      child.on('error', type => { fail(new Error(`Pi utility process error: ${type}`)); child.kill() })
    })
  }

  private async ensureStarted(): Promise<UtilityProcess> {
    if (this.disposed) throw new Error('Pi host is closed')
    if (this.restarting) await this.restarting
    if (this.process) return this.process
    if (!this.starting) {
      this.starting = this.spawnReady().then(child => {
        const failure = this.failures.get(child)
        if (failure) throw failure
        if (this.disposed) { child.kill(); throw new Error('Pi host is closed') }
        this.process = child
        this.error = ''
        console.info(`[amadeus-next] Pi runtime ready: ${child.pid ?? 'unknown'}`)
        return child
      }).finally(() => { this.starting = null })
    }
    return this.starting
  }

  private command(child: UtilityProcess, command: string, params: Json = {}, callbacks: Callbacks = {}, timeout = 60000): Promise<Json> {
    const failure = this.failures.get(child)
    if (failure) return Promise.reject(failure)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi ${command} timed out`))
      }, timeout) : null
      const finish = () => { if (timer) clearTimeout(timer) }
      this.pending.set(id, { ...callbacks, owner: child, resolve: value => { finish(); resolve(value) }, reject: error => { finish(); reject(error) } })
      try { child.postMessage({ ...params, id, command }) } catch (error) {
        this.pending.delete(id)
        finish()
        reject(error)
      }
    })
  }

  async request(command: string, params: Json = {}): Promise<Json> {
    return this.command(await this.ensureStarted(), command, params)
  }

  async prompt(sessionId: string, text: string, callbacks: Callbacks): Promise<string> {
    const response = await this.command(await this.ensureStarted(), 'prompt', { sessionId, text }, callbacks, 0)
    return String(response.text || '')
  }

  async abort(sessionId: string): Promise<void> {
    if (this.process) await this.command(this.process, 'abort', { sessionId })
  }

  restart(): Promise<void> {
    if (this.restarting) return this.restarting
    this.restarting = (async () => {
      if (this.disposed) throw new Error('Pi host is closed')
      if (this.starting) await this.starting
      const previous = this.process
      if (previous) await this.command(previous, 'checkpoint')
      const replacement = await this.spawnReady()
      const failure = this.failures.get(replacement)
      if (failure) throw failure
      if (this.disposed) { replacement.kill(); throw new Error('Pi host is closed') }
      this.process = replacement
      this.error = ''
      previous?.kill()
    })().finally(() => { this.restarting = null })
    return this.restarting
  }

  dispose(): void {
    this.disposed = true
    for (const child of this.children) child.kill()
    this.children.clear()
    this.process = null
    for (const pending of this.pending.values()) pending.reject(new Error('Pi host is closed'))
    this.pending.clear()
  }
}
