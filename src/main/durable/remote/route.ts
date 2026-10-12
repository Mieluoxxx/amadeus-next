import type { HarnessOptions } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { HandoffsDoc } from '../handoff/docs.ts'

/**
 * Harness 的 env 回调：子对话对应的委托条目带 target 就到那台机器上执行，否则在本机。
 * 条目上的 target 是唯一依据，不看 cwd 长什么样：远程路径在本机可能恰好也存在。
 */
export function executionEnvs(remoteEnv?: (target: string, cwd: string) => Promise<ExecutionEnv>): NonNullable<HarnessOptions['env']> {
  return async ({ conversationId, cwd, read }, context) => {
    if (!cwd) return undefined
    if (remoteEnv) {
      const handoffs = await read.snapshot(HandoffsDoc, ROOT_CONVERSATION_ID, context)
      const target = handoffs?.items.find(item => item.child === conversationId)?.target
      if (target) return remoteEnv(target, cwd)
    }
    return new NodeExecutionEnv({ cwd })
  }
}
