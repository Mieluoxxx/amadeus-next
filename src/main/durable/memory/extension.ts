import { CompactionTask, defineExtension, hook, type Extension } from '@earendil-works/pi-durable'
import { beforeCompact } from './compact.ts'
import type { ExtractTask } from './extract.ts'
import type { JournalTask } from './recall.ts'
import type { MemoryStore } from './store.ts'
import { createMemoryTools } from './tools.ts'

export const MEMORY_EXTENSION_NAME = 'amadeus-memory'

// P0 的空壳：只占住名字和压缩钩子的位置，供不带 MemoryStore 的测试与过渡期调用方安装。
export const AmadeusMemory = defineExtension({
  name: MEMORY_EXTENSION_NAME,
  hooks: [hook(CompactionTask, { beforeCompact: () => undefined })],
})

export type MemoryExtensionDeps = {
  store: MemoryStore
  extractTask: ExtractTask
  journalTask: JournalTask
  /** 自带陪伴向摘要并剔除记忆块；关闭则沿用 durable 的默认摘要。 */
  companionSummary: boolean
}

/**
 * 记忆条目由宿主代码写入，不经过 hook（HookApi 不能提交事务）；扩展提供工具、后台任务定义和压缩钩子。
 * 任务定义按名字解析，与哪个对话选择了本扩展无关；工具与钩子只在选择它的主对话里生效，子代理看不到记忆。
 */
export function createMemoryExtension({ store, extractTask, journalTask, companionSummary }: MemoryExtensionDeps): Extension {
  return defineExtension({
    name: MEMORY_EXTENSION_NAME,
    tools: [...createMemoryTools(store)],
    tasks: [extractTask, journalTask],
    hooks: companionSummary ? [hook(CompactionTask, { beforeCompact })] : [],
  })
}
