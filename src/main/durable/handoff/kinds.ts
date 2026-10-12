import type { Extension } from '@earendil-works/pi-durable'
import { createFilesExtension } from './files.ts'
import type { HandoffKind } from './docs.ts'
import { FILES_INSTRUCTIONS, RESEARCH_INSTRUCTIONS, TASK_INSTRUCTIONS, grantedLocations } from './instructions.ts'
import type { HandoffLimits } from './limits.ts'
import type { PathGuard } from './pathGuard.ts'
import { createResearchExtension } from './research.ts'
import { createTaskExtension } from './task.ts'

export type KindSpec = {
  /** handoff description 里这一类的一行说明。 */
  line: string
  /** files 与 task 需要 paths 参数，研究类不接受。 */
  needsPaths: boolean
  /** 子对话精确选择的扩展，不含 amadeus-handoff（禁止递归委托）。 */
  extension: Extension
  /** 授权路径与私有目录是每个任务自己的，所以 instructions 按任务生成。 */
  instructions(grant: { paths: readonly string[]; cwd: string }): string
}

// 新增类型要同时登记到 pi-tool-constraints §4.2；启用哪些类型在 worker 启动时确定，schema 与 description 随之固定。
export const KIND_LINES: Record<HandoffKind, string> = {
  research: '- research: look things up on the web, read pages and summarize.',
  files: '- files: read files or directories the user pointed to and answer questions about them (read-only). Needs paths.',
  task: "- task: do things that change something, such as organizing files or running scripts; every write or command needs the user's approval. Needs paths.",
}

/** description 里的顺序、enum 的顺序都按这里。 */
export const ALL_KINDS: readonly HandoffKind[] = ['research', 'files', 'task']

export type KindDeps = {
  limits: HandoffLimits
  guard: PathGuard
  bashEnv?: () => NodeJS.ProcessEnv
}

export function createKindSpecs(kinds: readonly HandoffKind[], deps: KindDeps): Partial<Record<HandoffKind, KindSpec>> {
  const specs: Partial<Record<HandoffKind, KindSpec>> = {}
  for (const kind of ALL_KINDS) {
    if (!kinds.includes(kind)) continue
    if (kind === 'research') {
      specs.research = { line: KIND_LINES.research, needsPaths: false, extension: createResearchExtension(), instructions: () => RESEARCH_INSTRUCTIONS }
    } else if (kind === 'files') {
      specs.files = {
        line: KIND_LINES.files,
        needsPaths: true,
        extension: createFilesExtension(deps.guard),
        instructions: ({ paths, cwd }) => `${FILES_INSTRUCTIONS}\n${grantedLocations(paths, cwd, { scratch: false })}`,
      }
    } else {
      specs.task = {
        line: KIND_LINES.task,
        needsPaths: true,
        extension: createTaskExtension({ limits: deps.limits, guard: deps.guard, ...(deps.bashEnv ? { env: deps.bashEnv } : {}) }),
        instructions: ({ paths, cwd }) => `${TASK_INSTRUCTIONS}\n${grantedLocations(paths, cwd, { scratch: true })}`,
      }
    }
  }
  return specs
}
