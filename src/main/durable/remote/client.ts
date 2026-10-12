import type { Readable, Writable } from 'node:stream'
import type { Context } from '@earendil-works/chord'
import { withAbortSignal } from '@earendil-works/chord/context'
import {
  ExecutionError,
  FileError,
  err,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from '@earendil-works/pi-durable/env'
import { PROTOCOL_VERSION, isHandleRef, lineChannel, type Frame, type FrameChannel, type HandleRef, type Hello } from './protocol.ts'

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  onEvent?(payload: unknown): void
}

/** 连接已断：调用方据此把失败转成 FileError / ExecutionError，而不是当成 runner 的 bug 抛出。 */
export class DisconnectedError extends Error {}

/** RemoteExecutionEnv 只依赖这几项；离线时用 OfflineConnection 顶上，env 照常构造，调用一律失败。 */
export interface RpcConnection {
  call(method: string, args: unknown[], context: Context, extra?: CallExtra): Promise<unknown>
  onClose(listener: (reason: string) => void): () => void
  dropWatcher(callId: number): void
  peekId(): number
}

type CallExtra = { cwd?: string; handle?: number; onEvent?: (payload: unknown) => void; watch?: (change: WatchChange) => void }

export class OfflineConnection implements RpcConnection {
  private readonly reason: string
  constructor(reason: string) { this.reason = reason }
  call(): Promise<unknown> { return Promise.reject(new DisconnectedError(this.reason)) }
  onClose(listener: (reason: string) => void): () => void { listener(this.reason); return () => {} }
  dropWatcher(): void {}
  peekId(): number { return 0 }
}

/**
 * 到一个 runner 的一条连接，也就是一个 generation：断开之后不会恢复，在途和之后的调用一律失败。
 * 重连由池子新建一条连接；绑在旧连接上的 env 不会悄悄换到新连接上，否则一次写入可能在两台进程上各执行一次。
 */
export class RemoteConnection implements RpcConnection {
  private readonly channel: FrameChannel
  private readonly pending = new Map<number, Pending>()
  /** watch 的回调在 watcher 关闭前一直有效，与调用本身的应答分开登记。 */
  private readonly watchers = new Map<number, (change: WatchChange) => void>()
  private nextId = 1
  private closedReason: string | undefined
  private readonly closeListeners = new Set<(reason: string) => void>()
  readonly hello: Promise<Hello>

  constructor(input: Readable, output: Writable) {
    let gotHello!: (hello: Hello) => void
    let noHello!: (error: Error) => void
    this.hello = new Promise<Hello>((resolve, reject) => { gotHello = resolve; noHello = reject })
    this.hello.catch(() => {})
    let greeted = false
    this.hello.then(() => { greeted = true }, () => {})
    this.channel = lineChannel(input, output, frame => this.onFrame(frame, gotHello, noHello), { lenient: () => !greeted })
    this.channel.onClose(reason => {
      this.closedReason = reason
      noHello(new DisconnectedError(`runner closed before hello: ${reason}`))
      const error = new DisconnectedError(`disconnected: ${reason}`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.watchers.clear()
      for (const listener of this.closeListeners) listener(reason)
    })
  }

  get closed(): boolean { return this.closedReason !== undefined }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason !== undefined) {
      listener(this.closedReason)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void { this.channel.close() }

  private onFrame(frame: Frame, gotHello: (hello: Hello) => void, noHello: (error: Error) => void): void {
    if ('hello' in frame) {
      if (frame.hello.protocol !== PROTOCOL_VERSION) {
        noHello(new Error(`runner speaks protocol ${frame.hello.protocol}, expected ${PROTOCOL_VERSION}`))
        this.channel.close()
        return
      }
      return gotHello(frame.hello)
    }
    if ('event' in frame) {
      if (frame.event === 'watch') return this.watchers.get(frame.call)?.(frame.payload as WatchChange)
      return this.pending.get(frame.call)?.onEvent?.(frame.payload)
    }
    if ('id' in frame && !('method' in frame)) {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.thrown !== undefined) pending.reject(new Error(frame.thrown))
      else pending.resolve(frame.value)
    }
  }

  /** 发出一次调用；context 取消时通知 runner，但仍等 runner 的应答（它会报 aborted），结果与本地 env 一致。 */
  call(method: string, args: unknown[], context: Context, extra: CallExtra = {}): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(new DisconnectedError(`disconnected: ${this.closedReason}`))
    const id = this.nextId++
    const signal = context.abortSignal
    const onAbort = () => this.channel.send({ cancel: id })
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...(extra.onEvent ? { onEvent: extra.onEvent } : {}) })
    })
    if (extra.watch) this.watchers.set(id, extra.watch)
    this.channel.send({
      id, method, args,
      ...(extra.cwd !== undefined ? { cwd: extra.cwd } : {}),
      ...(extra.handle !== undefined ? { handle: extra.handle } : {}),
      ...(signal?.aborted ? { aborted: true as const } : {}),
    })
    if (signal && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true })
    return result.finally(() => signal?.removeEventListener('abort', onAbort))
  }

  /** watch 的调用 id 就是 watcher 的事件键；关闭 watcher 后不再转发它的事件。 */
  dropWatcher(callId: number): void { this.watchers.delete(callId) }
  /** 下一次 call 将使用的 id；watch 需要在发出之前知道它。 */
  peekId(): number { return this.nextId }
}

const fileDisconnected = (name: string, error: unknown): FileError =>
  new FileError('unknown', `remote target ${name} is not reachable (${error instanceof Error ? error.message : String(error)})`)

/**
 * 远程机器上的 ExecutionEnv：每个方法都是一次 RPC，由 runner 用 NodeExecutionEnv 执行。
 * 失败语义与本地一致：预期内的失败是 Result，连接断开也折算成 Result（unknown），不抛出，工具照常把错误交给模型。
 */
export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  private readonly connection: RpcConnection
  private readonly name: string

  constructor(options: { name: string; connection: RpcConnection; cwd: string }) {
    this.name = options.name
    this.id = `remote:${options.name}`
    this.connection = options.connection
    this.cwd = options.cwd
  }

  private async fs<T>(method: string, args: unknown[], context: Context): Promise<Result<T, FileError>> {
    try {
      return (await this.connection.call(method, args, context, { cwd: this.cwd })) as Result<T, FileError>
    } catch (error) {
      return err(fileDisconnected(this.name, error))
    }
  }

  private async opened<T>(method: string, args: unknown[], context: Context, wrap: (ref: HandleRef) => T, extra: { watch?: (change: WatchChange) => void } = {}): Promise<Result<T, FileError>> {
    try {
      const result = (await this.connection.call(method, args, context, { cwd: this.cwd, ...extra })) as Result<unknown, FileError>
      if (!result.ok) return result
      if (!isHandleRef(result.value)) return err(new FileError('unknown', `runner returned no handle for ${method}`))
      return { ok: true, value: wrap(result.value) }
    } catch (error) {
      return err(fileDisconnected(this.name, error))
    }
  }

  private handleCall<T>(ref: HandleRef, method: string, args: unknown[], context: Context): Promise<Result<T, FileError>> {
    return this.connection.call(method, args, context, { handle: ref.$handle }).then(
      value => value as Result<T, FileError>,
      error => err(fileDisconnected(this.name, error)),
    )
  }

  /** close 不能失败：连接已断时对端的句柄已经随连接释放。 */
  private closeHandle(ref: HandleRef, context: Context): Promise<void> {
    return this.connection.call('close', [], context, { handle: ref.$handle }).then(() => undefined, () => undefined)
  }

  absolutePath(path: string, context: Context) { return this.fs<string>('absolutePath', [path], context) }
  joinPath(parts: string[], context: Context) { return this.fs<string>('joinPath', [parts], context) }
  readTextFile(path: string, context: Context) { return this.fs<string>('readTextFile', [path], context) }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) { return this.fs<string[]>('readTextLines', [path, options], context) }
  readBinaryFile(path: string, context: Context) { return this.fs<Uint8Array>('readBinaryFile', [path], context) }
  writeFile(path: string, content: string | Uint8Array, context: Context) { return this.fs<void>('writeFile', [path, content], context) }
  appendFile(path: string, content: string | Uint8Array, context: Context) { return this.fs<void>('appendFile', [path, content], context) }
  truncateFile(path: string, size: number, context: Context) { return this.fs<void>('truncateFile', [path, size], context) }
  flushFile(path: string, context: Context) { return this.fs<void>('flushFile', [path], context) }
  renameFile(sourcePath: string, destinationPath: string, context: Context) { return this.fs<void>('renameFile', [sourcePath, destinationPath], context) }
  fileInfo(path: string, context: Context) { return this.fs<FileInfo>('fileInfo', [path], context) }
  listDir(path: string, context: Context) { return this.fs<FileInfo[]>('listDir', [path], context) }
  canonicalPath(path: string, context: Context) { return this.fs<string>('canonicalPath', [path], context) }
  exists(path: string, context: Context) { return this.fs<boolean>('exists', [path], context) }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) { return this.fs<void>('createDir', [path, options], context) }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) { return this.fs<void>('remove', [path, options], context) }
  createTempDir(prefix: string | undefined, context: Context) { return this.fs<string>('createTempDir', [prefix], context) }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) { return this.fs<string>('createTempFile', [options], context) }

  openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.opened('openTextLineReader', [path], context, ref => ({
      readLine: (ctx: Context) => this.handleCall<TextLine | undefined>(ref, 'readLine', [], ctx),
      close: (ctx: Context) => this.closeHandle(ref, ctx),
    }))
  }

  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.opened('openBinaryReader', [path, options], context, ref => ({
      info: (ctx: Context) => this.handleCall<FileInfo>(ref, 'info', [], ctx),
      read: (offset: number, length: number, ctx: Context) => this.handleCall<Uint8Array>(ref, 'read', [offset, length], ctx),
      scanLines: (scan: { startLine: number; endLine?: number }, ctx: Context) => this.handleCall<LineScan>(ref, 'scanLines', [scan], ctx),
      close: (ctx: Context) => this.closeHandle(ref, ctx),
    }))
  }

  openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.opened('openDirReader', [path], context, ref => ({
      next: (maxEntries: number, ctx: Context) => this.handleCall<{ entries: FileInfo[]; done: boolean }>(ref, 'next', [maxEntries], ctx),
      close: (ctx: Context) => this.closeHandle(ref, ctx),
    }))
  }

  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const callId = this.connection.peekId()
    let open = true
    let stopOnClose = () => {}
    const forward = (change: WatchChange) => { if (open) onChange(change) }
    const result = await this.opened('watch', [targets], context, (ref): FileWatcher => ({
      mode: ref.mode ?? 'native',
      close: async (ctx: Context) => {
        if (!open) return
        open = false
        stopOnClose()
        this.connection.dropWatcher(callId)
        await this.closeHandle(ref, ctx)
      },
    }), { watch: forward })
    if (!result.ok) {
      open = false
      this.connection.dropWatcher(callId)
      return result
    }
    // 连接断开等于 watcher 停止：按 WatchChange 的约定报一次 error，之后不再回调。watch 失败时不报，所以成功之后才登记。
    stopOnClose = this.connection.onClose(reason => {
      if (!open) return
      open = false
      onChange({ error: new FileError('unknown', `remote target ${this.name} disconnected: ${reason}`) })
    })
    return result
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const { onOutput, ...rest } = options ?? {}
    let callbackError: ExecutionError | undefined
    // 回调抛错在本地无法同步打断远程进程：记下错误、取消远程命令，等它收尾后按 callback_error 返回，与 NodeExecutionEnv 一致。
    const cancel = new AbortController()
    const callContext = withAbortSignal(cancel.signal, context)
    const onEvent = onOutput
      ? (payload: unknown) => {
        if (callbackError) return
        const { text, stream } = payload as { text: string; stream: 'stdout' | 'stderr' }
        try {
          onOutput(text, context, { stream })
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error))
          callbackError = new ExecutionError('callback_error', cause.message, cause)
          cancel.abort()
        }
      }
      : undefined
    try {
      const result = (await this.connection.call('exec', [command, { ...rest, ...(onOutput ? { output: true } : {}) }], callContext, { cwd: this.cwd, ...(onEvent ? { onEvent } : {}) })) as Result<ShellExecResult, ExecutionError>
      return callbackError ? err(callbackError) : result
    } catch (error) {
      if (callbackError) return err(callbackError)
      return err(new ExecutionError('unknown', `remote target ${this.name} is not reachable (${error instanceof Error ? error.message : String(error)})`))
    }
  }

  /** 只在 env 的所有者收尾时调用；连接已断时远程命令已经随连接被杀，无事可做。 */
  async cleanup(context: Context): Promise<void> {
    await this.connection.call('cleanup', [], context, { cwd: this.cwd }).catch(() => {})
  }
}
