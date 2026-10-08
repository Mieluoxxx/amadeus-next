import type { UtilityProcess } from 'electron'
import { BAKER_VERSION } from '../shared/emote/bake.ts'
import type { Baker, BakeJob } from './emoteBakeNode.ts'

/**
 * 烘焙放进独立的 utilityProcess：峰值内存不压主进程，分配器留着不还的那部分也随进程退出一并回收。
 * 每个任务一个进程，烘焙很少发生，没必要常驻。
 */
export function workerBaker(fork: () => UtilityProcess, timeoutMs = 120_000): Baker {
  return {
    version: BAKER_VERSION,
    bake: (job: BakeJob) => new Promise<void>((resolve, reject) => {
      const child = fork()
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        if (error) reject(error); else resolve()
      }
      const timer = setTimeout(() => settle(new Error(`E-mote 烘焙超时（${timeoutMs / 1000}s）`)), timeoutMs)
      child.on('message', (message: { type?: string; error?: string }) => {
        if (message?.type === 'ready') child.postMessage(job)
        else if (message?.type === 'done') settle()
        else if (message?.type === 'error') settle(new Error(message.error || 'E-mote 烘焙失败'))
      })
      child.on('exit', code => settle(new Error(`E-mote 烘焙进程意外退出（${code}）`)))
      child.on('error', type => settle(new Error(`E-mote 烘焙进程异常：${type}`)))
    }),
  }
}
