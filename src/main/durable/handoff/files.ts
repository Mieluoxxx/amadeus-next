import { defineExtension, type Extension } from '@earendil-works/pi-durable'
import { createGuardedRead, createListDirTool } from './fileTools.ts'
import { reportProgress } from './progress.ts'
import type { PathGuard } from './pathGuard.ts'

export const FILES_EXTENSION_NAME = 'amadeus-files'

/** files 子代理：只读，范围是主人授权的路径（pi-tool-constraints §4.2）。 */
export function createFilesExtension(guard: PathGuard): Extension {
  const read = createGuardedRead(guard)
  return defineExtension({ name: FILES_EXTENSION_NAME, tools: [read.tool, createListDirTool(guard), reportProgress], wraps: [read.wrap] })
}
