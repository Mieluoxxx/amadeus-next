import path from 'node:path'

/** 严格限制解析路径在指定的资源根目录内，防御跨目录穿越访问。 */
export function safeFilePath(root: string, pathname: string): string | null {
  let relative: string
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  const candidate = path.resolve(root, relative)
  const relativeToRoot = path.relative(path.resolve(root), candidate)
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null
  return candidate
}
