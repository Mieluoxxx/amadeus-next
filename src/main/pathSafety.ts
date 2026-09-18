import path from 'node:path'

/** Resolve a request path only when it stays below the selected asset root. */
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
