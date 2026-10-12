import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { Context, JsonValue } from '@earendil-works/chord'
import { defineExtension, wrapTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable'
import { createBashTool, createEditTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { runApproved, type ApprovalRequest } from './approvals.ts'
import { checkPath, createGuardedRead, createListDirTool, refused } from './fileTools.ts'
import type { HandoffLimits } from './limits.ts'
import type { PathGuard } from './pathGuard.ts'
import { reportProgress } from './progress.ts'

export const TASK_EXTENSION_NAME = 'amadeus-task'

// 只给 bash 这些变量：worker 的环境里有 AMADEUS_JEV_API_KEY 等密钥，bash 默认会整个继承（pi-tool-constraints §4.1）。
// 小写的代理变量是 macOS / Linux 上更常见的写法，与大写同样放行。
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

export function bashEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ENV_ALLOWLIST) {
    const value = source[name]
    if (typeof value === 'string') env[name] = value
  }
  // inheritEnv=false 之后没有 PATH 的话连 ls 都找不到。
  env.PATH ??= FALLBACK_PATH
  return env
}

const COMMAND_PREVIEW_MAX = 2000
const COMMAND_TOO_LONG = `The command is longer than ${COMMAND_PREVIEW_MAX} characters, which is more than the approval card can show, so it was not run. Split it into smaller commands, or write it to a script file first and run that.`
// write / edit 的卡片要完整展示将写入的内容：只展示前一段，主人批准的就是看不全的东西。超限不截断，直接拒绝。
const DETAIL_MAX = 20_000
const WRITE_TOO_LONG = `The content is longer than ${DETAIL_MAX} characters, which is more than the approval card can show, so nothing was written. Split it across several smaller files, or create the file with a short write and extend it with several smaller edits.`
const EDITS_TOO_LONG = `The edits total more than ${DETAIL_MAX} characters, which is more than the approval card can show, so nothing was changed. Split them into several smaller edit calls.`
const SUMMARY_MAX = 120

const cut = (value: string, max: number): string => {
  const chars = Array.from(value)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value
}

const length = (value: string): number => Array.from(value).length

/** 每处修改按差异的样子展开：旧文本逐行加 "- "，新文本逐行加 "+ "。分隔行不含自然语言，由界面决定怎么称呼。 */
const renderEdits = (edits: readonly { oldText: string; newText: string }[]): string =>
  edits
    .map((each, index) =>
      [`@@ ${index + 1}/${edits.length} @@`, ...each.oldText.split('\n').map(line => `- ${line}`), ...each.newText.split('\n').map(line => `+ ${line}`)].join('\n'),
    )
    .join('\n\n')

const firstLine = (value: string, max: number): string => cut(value.trim().split('\n', 1)[0].trim(), max)

// 摘要只是一行提示，批准的依据在 detail 里；多行命令必须标出没显示的行数，否则首行看起来就是全部。
const commandSummary = (command: string): string => {
  const extra = command.trim().split('\n').length - 1
  return `Run command: ${firstLine(command, 80)}${extra > 0 ? ` (+${extra} more line${extra === 1 ? '' : 's'})` : ''}`
}

const BASH_DESCRIPTION_NOTE =
  ' Every command is shown to the user for approval before it runs; if it is declined, do not retry it in a different form. The command runs in your private working directory with a minimal environment. The default timeout is 120 seconds, at most 600.'

export type TaskOptions = {
  limits: HandoffLimits
  guard: PathGuard
  /** bash 白名单变量的来源；缺省取当前进程的 env。 */
  env?: () => NodeJS.ProcessEnv
}

/**
 * task 子代理：read / list_dir 同 files，bash / write / edit 来自 built-in，经 wrapTool 逐次请求确认（pi-tool-constraints §4.3）。
 * 包装函数必须是纯的，所以确认所需的一切（limits、guard）都在闭包里，不在包装函数里读全局状态。
 */
export function createTaskExtension(options: TaskOptions): Extension {
  const { limits, guard } = options
  const read = createGuardedRead(guard)
  const bash = createBashTool({
    prepare: execution => {
      execution.inheritEnv = false
      execution.env = bashEnvironment(options.env?.() ?? process.env)
    },
  })
  const write = createWriteTool()
  const edit = createEditTool()

  /** 守卫通过后请求确认；allow 才执行，参数就是卡片上展示的那一份。 */
  const gated = <D extends JsonValue>(
    target: string,
    request: ApprovalRequest,
    api: ToolExecutionApi<D>,
    context: Context,
    run: () => Promise<ToolExecutionResult<D>>,
  ): Promise<ToolExecutionResult<D>> => runApproved(api, context, request, limits.approvalTtlMs, target, run)

  // 文件名可以含换行等控制字符，摘要是单行文本。
  const summary = (text: string): string => cut(text.replace(/[\u0000-\u001F\u007F]+/g, ' '), SUMMARY_MAX)

  return defineExtension({
    name: TASK_EXTENSION_NAME,
    tools: [read.tool, createListDirTool(guard), reportProgress, bash, write, edit],
    wraps: [
      read.wrap,
      wrapTool(bash, base => ({
        ...base,
        description: base.description + BASH_DESCRIPTION_NOTE,
        parameters: Type.Object({
          command: Type.String({ description: 'Bash command to execute' }),
          timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (optional, default ${limits.bashDefaultTimeoutSec}, at most ${limits.bashMaxTimeoutSec})` })),
        }),
        executionMode: 'sequential',
        execute: async (args, api, context) => {
          const requested = args.timeout
          const timeout = requested !== undefined && Number.isFinite(requested) && requested > 0 ? Math.min(requested, limits.bashMaxTimeoutSec) : limits.bashDefaultTimeoutSec
          const command = args.command
          // 确认卡片放不下的命令不让主人批准：看不全的尾部可以藏任何东西。要跑长脚本就先写成文件（写入本身也要确认）再执行。
          if (length(command) > COMMAND_PREVIEW_MAX) {
            return { content: [{ type: 'text', text: COMMAND_TOO_LONG }], isError: true }
          }
          return gated(
            firstLine(command, 80),
            {
              tool: 'bash',
              summary: summary(commandSummary(command)),
              detail: { tool: 'bash', command, ...(api.env?.cwd ? { cwd: api.env.cwd } : {}) },
            },
            api,
            context,
            () => base.execute({ ...args, timeout }, api, context),
          )
        },
      })),
      wrapTool(write, base => ({
        ...base,
        executionMode: 'sequential',
        execute: async (args, api, context) => {
          const target = await checkPath(guard, api, context, args.path)
          if (!target) return refused(args.path)
          if (length(args.content) > DETAIL_MAX) return { content: [{ type: 'text', text: WRITE_TOO_LONG }], isError: true }
          // checkPath 通过就说明 api.env 存在。
          const existing = await api.env!.exists(target, context)
          const overwrite = existing.ok && existing.value
          const bytes = Buffer.byteLength(args.content)
          return gated(
            args.path,
            {
              tool: 'write',
              summary: summary(`Write file: ${path.basename(target)} (${bytes} bytes, ${overwrite ? 'overwrite' : 'create'})`),
              detail: { tool: 'write', path: target, preview: args.content },
            },
            api,
            context,
            () => base.execute({ ...args, path: target }, api, context),
          )
        },
      })),
      wrapTool(edit, base => ({
        ...base,
        executionMode: 'sequential',
        execute: async (args, api, context) => {
          const target = await checkPath(guard, api, context, args.path)
          if (!target) return refused(args.path)
          // 限长按卡片上实际展示的差异算，而不是原始文本：行首标记也占地方。
          const preview = renderEdits(args.edits)
          if (length(preview) > DETAIL_MAX) return { content: [{ type: 'text', text: EDITS_TOO_LONG }], isError: true }
          return gated(
            args.path,
            {
              tool: 'edit',
              summary: summary(`Edit file: ${path.basename(target)} (${args.edits.length} edit${args.edits.length === 1 ? '' : 's'})`),
              detail: { tool: 'edit', path: target, preview },
            },
            api,
            context,
            () => base.execute({ ...args, path: target }, api, context),
          )
        },
      })),
    ],
  })
}
