import { homedir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import { FileError, err, type ShellExecOptions, type WatchChange } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { PROTOCOL_VERSION, handleRef, lineChannel, type CallFrame, type Frame } from './protocol.ts'

/** 只有这些名字能被远程调用：按名字分派的 RPC 不加白名单的话，`constructor` 之类的属性也会被当成方法。 */
const ENV_METHODS = new Set([
  'absolutePath', 'joinPath', 'readTextFile', 'openTextLineReader', 'readTextLines', 'readBinaryFile', 'openBinaryReader',
  'writeFile', 'appendFile', 'truncateFile', 'flushFile', 'renameFile', 'fileInfo', 'listDir', 'openDirReader', 'watch',
  'canonicalPath', 'exists', 'createDir', 'remove', 'createTempDir', 'createTempFile', 'cleanup', 'exec',
])
const HANDLE_METHODS = new Set(['readLine', 'info', 'read', 'scanLines', 'next', 'close'])
const OPENERS = new Set(['openTextLineReader', 'openBinaryReader', 'openDirReader', 'watch'])

/** 输出攒一小段再发：一条命令可能每秒吐上万个小块，逐块成帧会把链路塞满。只合并同一流的相邻块，顺序与解码边界不变。 */
const OUTPUT_FLUSH_MS = 10

type Closable = { close(context: Context): Promise<void> } & Record<string, unknown>

export type RunnerOptions = {
  input: Readable
  output: Writable
  log?: (message: string) => void
}

/** 在远程机器上提供 ExecutionEnv；连接断开即收尾：取消在途调用、关闭句柄、杀掉所有还在跑的命令。 */
export function serveRunner(options: RunnerOptions): Promise<void> {
  const log = options.log ?? (message => process.stderr.write(`[amadeus-runner] ${message}\n`))
  const envs = new Map<string, NodeExecutionEnv>()
  const handles = new Map<number, Closable>()
  const inflight = new Map<number, (reason?: unknown) => void>()
  let nextHandle = 1
  let finished!: () => void
  const done = new Promise<void>(resolve => { finished = resolve })

  const envFor = (cwd: string | undefined): NodeExecutionEnv => {
    const key = cwd || homedir()
    let env = envs.get(key)
    if (!env) {
      env = new NodeExecutionEnv({ cwd: key })
      envs.set(key, env)
    }
    return env
  }

  const register = (value: Closable, mode?: 'native' | 'polling') => {
    const id = nextHandle++
    handles.set(id, value)
    return handleRef(id, mode)
  }

  const channel = lineChannel(options.input, options.output, frame => onFrame(frame))

  function onFrame(frame: Frame): void {
    if ('cancel' in frame) return void inflight.get(frame.cancel)?.()
    if ('method' in frame) void call(frame)
  }

  async function call(frame: CallFrame): Promise<void> {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT)
    inflight.set(frame.id, cancel)
    if (frame.aborted) cancel()
    try {
      const value = frame.handle === undefined ? await envCall(frame, context) : await handleCall(frame, context)
      channel.send({ id: frame.id, value })
    } catch (error) {
      channel.send({ id: frame.id, thrown: error instanceof Error ? error.message : String(error) })
    } finally {
      inflight.delete(frame.id)
    }
  }

  async function handleCall(frame: CallFrame, context: Context): Promise<unknown> {
    const target = handles.get(frame.handle!)
    // 关闭过的句柄已从表里删除；与 NodeExecutionEnv 一样，关闭后再用是 invalid，再次关闭什么也不做。
    if (!target) return frame.method === 'close' ? undefined : err(new FileError('invalid', 'handle is closed'))
    if (!HANDLE_METHODS.has(frame.method) || typeof target[frame.method] !== 'function') throw new Error(`unsupported handle method ${frame.method}`)
    if (frame.method === 'close') handles.delete(frame.handle!)
    return (target[frame.method] as (...args: unknown[]) => Promise<unknown>)(...frame.args, context)
  }

  async function envCall(frame: CallFrame, context: Context): Promise<unknown> {
    if (!ENV_METHODS.has(frame.method)) throw new Error(`unsupported method ${frame.method}`)
    const env = envFor(frame.cwd)
    if (frame.method === 'exec') return exec(env, frame, context)
    if (frame.method === 'watch') {
      const [targets] = frame.args as [Parameters<NodeExecutionEnv['watch']>[0]]
      const result = await env.watch(targets, (change: WatchChange) => channel.send({ event: 'watch', call: frame.id, payload: change }), context)
      return result.ok ? { ok: true, value: register(result.value as unknown as Closable, result.value.mode) } : result
    }
    const result = await (env[frame.method as keyof NodeExecutionEnv] as (...args: unknown[]) => Promise<unknown>).call(env, ...frame.args, context)
    if (OPENERS.has(frame.method)) {
      const opened = result as { ok: boolean; value?: Closable }
      return opened.ok ? { ok: true, value: register(opened.value!) } : opened
    }
    return result
  }

  async function exec(env: NodeExecutionEnv, frame: CallFrame, context: Context): Promise<unknown> {
    const [command, wire] = frame.args as [string | string[], (Omit<ShellExecOptions, 'onOutput'> & { output?: boolean }) | undefined]
    const { output, ...rest } = wire ?? {}
    let buffered = ''
    let bufferedStream: 'stdout' | 'stderr' = 'stdout'
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = undefined }
      if (!buffered) return
      channel.send({ event: 'output', call: frame.id, payload: { text: buffered, stream: bufferedStream } })
      buffered = ''
    }
    const execOptions: ShellExecOptions = {
      ...rest,
      ...(output ? {
        onOutput: (text, _context, info) => {
          if (buffered && info.stream !== bufferedStream) flush()
          bufferedStream = info.stream
          buffered += text
          timer ??= setTimeout(flush, OUTPUT_FLUSH_MS)
        },
      } : {}),
    }
    try {
      return await env.exec(command, execOptions, context)
    } finally {
      // 回复之前把剩下的输出发完：本端收到回复就认为输出已经齐了。
      flush()
    }
  }

  channel.onClose(reason => {
    void (async () => {
      log(`connection ended: ${reason}`)
      for (const cancel of inflight.values()) cancel()
      inflight.clear()
      await Promise.allSettled([...handles.values()].map(handle => handle.close(BACKGROUND_CONTEXT)))
      handles.clear()
      await Promise.allSettled([...envs.values()].map(env => env.cleanup(BACKGROUND_CONTEXT)))
      envs.clear()
      finished()
    })()
  })

  channel.send({ hello: { protocol: PROTOCOL_VERSION, os: process.platform, arch: process.arch, home: homedir(), node: process.version } })
  return done
}
