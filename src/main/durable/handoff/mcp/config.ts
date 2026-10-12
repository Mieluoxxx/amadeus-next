import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CapabilityMode } from '../skills.ts'

export type McpSource = 'amadeus' | 'shared'

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; headers: Record<string, string> }

export type McpServer = {
  name: string
  transport: McpTransportConfig
  timeoutMs: number
  description?: string
  /** 免确认的工具名。只取自 amadeus 自己的 mcp.json：共享来的宿主配置不能放宽 amadeus 的审批。 */
  autoApprove: readonly string[]
  source: McpSource
}

export type McpConfigFile = { file: string; source: McpSource }

export type LoadedMcp = { servers: McpServer[]; errors: string[] }

/** 隔离模式只读 amadeus 的 mcp.json；共享模式再合并宿主机 pi 的，同名以 amadeus 的为准。 */
export function mcpConfigFiles(mode: CapabilityMode, dirs: { home: string; sharedDir: string }): McpConfigFile[] {
  const files: McpConfigFile[] = [{ file: path.join(dirs.home, 'mcp.json'), source: 'amadeus' }]
  if (mode === 'shared') files.push({ file: path.join(dirs.sharedDir, 'mcp.json'), source: 'shared' })
  return files
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/
const DEFAULT_TIMEOUT_MS = 60_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// 与 pi 一致：只差 - 与 _ 的两个名字算同一个 server。
export const serverKey = (name: string): string => name.toLowerCase().replace(/-/g, '_')

class Invalid extends Error {}

function expandHome(value: string, userHome: string): string {
  return value === '~' ? userHome : value.startsWith('~/') ? path.join(userHome, value.slice(2)) : value
}

/** `${VAR}` 从 worker 的环境展开；`!command` 要起 shell，本期不支持。 */
function expand(value: string, env: NodeJS.ProcessEnv): string {
  if (value.startsWith('!')) throw new Invalid('values starting with "!" (shell commands) are not supported')
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? '')
}

function stringMap(value: unknown, field: string, env: NodeJS.ProcessEnv): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Invalid(`${field} must be an object of strings`)
  const out: Record<string, string> = {}
  for (const [key, each] of Object.entries(value)) {
    if (typeof each !== 'string') throw new Invalid(`${field}.${key} must be a string`)
    out[key] = expand(each, env)
  }
  return out
}

function parseServer(name: string, raw: unknown, source: McpSource, context: { env: NodeJS.ProcessEnv; userHome: string; baseDir: string }): McpServer | undefined {
  if (!NAME.test(name)) throw new Invalid('the name may contain only letters, digits, "_" and "-"')
  if (!isRecord(raw)) throw new Invalid('the entry must be an object')
  if (raw.enabled === false) return undefined
  if (raw.oauth !== undefined || raw.auth !== undefined) throw new Invalid('OAuth sign-in is not supported yet; pass a token in headers instead')
  const type = raw.type
  if (type === 'sse') throw new Invalid('the SSE transport is not supported; use the streamable HTTP endpoint (often /mcp)')
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') throw new Invalid(`unknown type ${JSON.stringify(type)}`)
  let transport: McpTransportConfig
  if (typeof raw.command === 'string' && type !== 'http' && type !== 'streamable-http') {
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(each => typeof each !== 'string'))) throw new Invalid('args must be an array of strings')
    const cwd = typeof raw.cwd === 'string' ? path.resolve(context.baseDir, expandHome(raw.cwd, context.userHome)) : undefined
    transport = {
      type: 'stdio',
      command: expandHome(raw.command, context.userHome),
      args: ((raw.args as string[] | undefined) ?? []).map(each => expandHome(each, context.userHome)),
      env: stringMap(raw.env, 'env', context.env),
      ...(cwd ? { cwd } : {}),
    }
  } else if (typeof raw.url === 'string') {
    const url = expand(raw.url, context.env)
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Invalid('url is malformed') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Invalid('url must be http or https')
    transport = { type: 'http', url, headers: stringMap(raw.headers, 'headers', context.env) }
  } else throw new Invalid('needs either command (stdio) or url (HTTP)')
  const timeout = typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0 ? raw.timeout * 1000 : DEFAULT_TIMEOUT_MS
  const autoApprove = source === 'amadeus' && Array.isArray(raw.autoApprove) ? raw.autoApprove.filter((each): each is string => typeof each === 'string') : []
  return {
    name,
    transport,
    timeoutMs: timeout,
    ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
    autoApprove,
    source,
  }
}

/**
 * 支持与 Claude / pi 相同的 `mcpServers` 子集：stdio（command / args / env / cwd）与 streamable HTTP（url / headers），
 * 外加 enabled、timeout（秒）、description、autoApprove。坏条目跳过并记错误，不影响其它 server。
 * pi-coding-agent 自己的 loadMcpConfig 没有从包根导出，所以在这里另写。
 */
export function loadMcpConfig(files: readonly McpConfigFile[], context: { env: NodeJS.ProcessEnv; userHome: string }): LoadedMcp {
  const servers: McpServer[] = []
  const errors: string[] = []
  const taken = new Set<string>()
  for (const { file, source } of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${file}: cannot be read`)
      continue
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { errors.push(`${file}: not valid JSON`); continue }
    const entries = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined
    if (!entries) { errors.push(`${file}: missing the "mcpServers" object`); continue }
    for (const [name, raw] of Object.entries(entries)) {
      const key = serverKey(name)
      if (taken.has(key)) continue
      try {
        const server = parseServer(name, raw, source, { ...context, baseDir: path.dirname(file) })
        // 停用的条目也占住名字：amadeus 里停用的 server 不该被共享配置里的同名条目复活。
        taken.add(key)
        if (server) servers.push(server)
      } catch (error) {
        taken.add(key)
        errors.push(`${file}: server ${JSON.stringify(name)}: ${error instanceof Invalid ? error.message : String(error)}`)
      }
    }
  }
  return { servers, errors }
}
