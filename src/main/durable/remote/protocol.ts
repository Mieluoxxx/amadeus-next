import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { ExecutionError, FileError, type ExecutionErrorCode, type FileErrorCode } from '@earendil-works/pi-durable/env'

/** 握手里双方都要核对的协议版本；runner 随 bundle 哈希一起部署，两端总是同一份代码，这里只防手动启动的旧 runner。 */
export const PROTOCOL_VERSION = 1

/** 单帧上限：大文件读写由调用方分块，超限的帧说明对端出了错，直接断开而不是缓冲下去。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export type Hello = { protocol: number; os: NodeJS.Platform; arch: string; home: string; node: string }

/** 本端 → runner。runner 按 cwd 复用 NodeExecutionEnv；`handle` 指向之前打开的 reader / watcher。 */
/** `aborted`：发出时调用方的 context 已经取消；runner 先取消再调用，否则一个很快的调用会赶在随后的 cancel 帧之前成功。 */
export type CallFrame = { id: number; method: string; cwd?: string; handle?: number; args: unknown[]; aborted?: true }
export type CancelFrame = { cancel: number }
/** runner → 本端。 */
export type ReplyFrame = { id: number; value?: unknown; thrown?: string }
export type EventFrame = { event: 'output' | 'watch'; call: number; payload: unknown }
export type HelloFrame = { hello: Hello }

export type Frame = CallFrame | CancelFrame | ReplyFrame | EventFrame | HelloFrame

const B64 = '$b64'
const FILE_ERROR = '$fileError'
const EXEC_ERROR = '$execError'
const HANDLE = '$handle'

export type HandleRef = { [HANDLE]: number; mode?: 'native' | 'polling' }

export const handleRef = (id: number, mode?: 'native' | 'polling'): HandleRef => ({ [HANDLE]: id, ...(mode ? { mode } : {}) })
export const isHandleRef = (value: unknown): value is HandleRef => typeof value === 'object' && value !== null && HANDLE in value

/** Uint8Array 与两类错误要跨 JSON 往返：错误类型决定调用方走哪条分支，必须在本端重建成同一个类。 */
function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { [B64]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (value instanceof FileError) return { [FILE_ERROR]: { code: value.code, message: value.message, ...(value.path ? { path: value.path } : {}) } }
  if (value instanceof ExecutionError) return { [EXEC_ERROR]: { code: value.code, message: value.message, ...(value.spillPath ? { spillPath: value.spillPath } : {}) } }
  return value
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (B64 in value) return new Uint8Array(Buffer.from((value as Record<string, string>)[B64], 'base64'))
  if (FILE_ERROR in value) {
    const { code, message, path } = (value as Record<string, { code: FileErrorCode; message: string; path?: string }>)[FILE_ERROR]
    return new FileError(code, message, path)
  }
  if (EXEC_ERROR in value) {
    const { code, message, spillPath } = (value as Record<string, { code: ExecutionErrorCode; message: string; spillPath?: string }>)[EXEC_ERROR]
    const error = new ExecutionError(code, message)
    if (spillPath) error.spillPath = spillPath
    return error
  }
  return value
}

export const encodeFrame = (frame: Frame): string => JSON.stringify(frame, replacer)
export const decodeFrame = (line: string): Frame => JSON.parse(line, reviver) as Frame

export type FrameChannel = {
  send(frame: Frame): void
  /** 只调用一次；对端关闭、流出错或收到坏帧时触发。 */
  onClose(listener: (reason: string) => void): void
  close(): void
}

/**
 * JSON lines：JSON.stringify 会转义换行，所以一行恰好一帧。stdout 只走帧，日志一律写 stderr，
 * 否则 runner 自己的一行 console.log 就会被当成坏帧把连接断掉。`lenient` 为真时跳过坏行：
 * 远程登录脚本（~/.profile 里的 echo）会在 runner 启动前往 stdout 写字，握手之前的这些行不算错。
 */
export function lineChannel(input: Readable, output: Writable, onFrame: (frame: Frame) => void, options: { lenient?: () => boolean } = {}): FrameChannel {
  let closed = false
  let closeListener: ((reason: string) => void) | undefined
  let pendingReason: string | undefined
  const finish = (reason: string) => {
    if (closed) return
    closed = true
    lines.close()
    if (closeListener) closeListener(reason)
    else pendingReason = reason
  }
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', line => {
    if (closed || line.length === 0) return
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return finish('frame too large')
    let frame: Frame
    try {
      frame = decodeFrame(line)
    } catch {
      if (options.lenient?.()) return
      return finish('malformed frame')
    }
    onFrame(frame)
  })
  lines.on('close', () => finish('closed'))
  input.on('error', error => finish(`input error: ${error.message}`))
  output.on('error', error => finish(`output error: ${error.message}`))
  return {
    send(frame) {
      if (closed) return
      output.write(`${encodeFrame(frame)}\n`)
    },
    onClose(listener) {
      closeListener = listener
      if (pendingReason !== undefined) listener(pendingReason)
    },
    close() {
      finish('closed locally')
      output.end()
    },
  }
}
