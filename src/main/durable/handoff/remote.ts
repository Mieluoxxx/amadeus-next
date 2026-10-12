import { Type } from '@earendil-works/pi-ai'
import { defineExtension, wrapTool, type Extension } from '@earendil-works/pi-durable'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import type { RemoteLimits } from './limits.ts'
import { reportProgress } from './progress.ts'

export const REMOTE_EXTENSION_NAME = 'amadeus-remote'

const BASH_DESCRIPTION_NOTE = (limits: RemoteLimits) =>
  ` The command runs on the remote machine, in your working directory, with that machine's login environment; it is not shown to anyone for approval. The default timeout is ${limits.bashDefaultTimeoutSec} seconds, at most ${limits.bashMaxTimeoutSec}.`

/**
 * remote 子代理：内置的 read / write / edit / bash，全部作用在远程机器上（执行环境由宿主按 HandoffItem.target 选）。
 * 主人选择了不设确认与路径限制，所以这里没有 guard 与确认包装；唯一的包装是给 bash 补缺省超时，
 * 内置 bash 没有超时，卡住的命令会一直占着任务直到活跃超时。bash 不覆盖 env：本机的变量（含密钥）不该带到远程。
 */
export function createRemoteExtension(limits: RemoteLimits): Extension {
  const bash = createBashTool()
  return defineExtension({
    name: REMOTE_EXTENSION_NAME,
    tools: [createReadTool(), reportProgress, bash, createWriteTool(), createEditTool()],
    wraps: [
      wrapTool(bash, base => ({
        ...base,
        description: base.description + BASH_DESCRIPTION_NOTE(limits),
        parameters: Type.Object({
          command: Type.String({ description: 'Bash command to execute' }),
          timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (optional, default ${limits.bashDefaultTimeoutSec}, at most ${limits.bashMaxTimeoutSec})` })),
        }),
        execute: (args, api, context) => {
          const requested = args.timeout
          const timeout = requested !== undefined && Number.isFinite(requested) && requested > 0 ? Math.min(requested, limits.bashMaxTimeoutSec) : limits.bashDefaultTimeoutSec
          return base.execute({ ...args, timeout }, api, context)
        },
      })),
    ],
  })
}
