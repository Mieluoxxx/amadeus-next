import { homedir } from 'node:os'
import { McpClient, StdioTransport, StreamableHttpTransport, type CallToolResult, type McpTransport, type Tool } from '@earendil-works/pi-mcp'
import { bashEnvironment } from '../task.ts'
import { loadMcpConfig, type McpConfigFile, type McpServer } from './config.ts'

export type McpTransportFactory = (server: McpServer, env: NodeJS.ProcessEnv) => McpTransport

export type McpManagerOptions = {
  files: readonly McpConfigFile[]
  /** stdio server 的白名单变量与 `${VAR}` 展开的来源；缺省取当前进程的 env。 */
  env?: () => NodeJS.ProcessEnv
  userHome?: string
  /** 测试接缝：缺省按配置建 stdio / streamable HTTP。 */
  createTransport?: McpTransportFactory
  log?: (message: string) => void
}

type Connection = { config: string; ready: Promise<{ client: McpClient; tools: Tool[] }> }

const CLIENT = { name: 'amadeus-next', version: '1.0.0' }
const STDERR_MAX = 16 * 1024

/**
 * stdio server 不继承 worker 的环境：那里有 AMADEUS_JEV_API_KEY 等密钥。与 bash 用同一份白名单，再叠加配置里显式写的 env。
 * 这只是防误传，不是沙箱：server 本身是主人配置的任意程序。
 */
export function defaultTransport(server: McpServer, env: NodeJS.ProcessEnv): McpTransport {
  const transport = server.transport
  if (transport.type === 'http') return new StreamableHttpTransport({ url: transport.url, headers: transport.headers })
  return new StdioTransport({
    command: transport.command,
    args: transport.args,
    ...(transport.cwd ? { cwd: transport.cwd } : {}),
    env: { ...bashEnvironment(env), ...transport.env },
    inheritEnv: false,
    stderr: 'pipe',
    maxStderrBytes: STDERR_MAX,
  })
}

export class McpUnavailable extends Error {}

const describe = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/**
 * worker 内唯一的 MCP 连接表。懒连接：子代理第一次用到某个 server 才拉起它，没人用就不起进程。
 * 配置在每次受理委托时重读；某个 server 的配置变了，旧连接关掉，下次用时按新配置重连。
 */
export class McpManager {
  private options: McpManagerOptions
  private servers: McpServer[] = []
  private readonly connections = new Map<string, Connection>()

  constructor(options: McpManagerOptions) {
    this.options = options
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env?.() ?? process.env
  }

  /** 设置页切换了 MCP 来源：换一组配置文件，不再出现或配置变了的 server 立即断开。 */
  setFiles(files: readonly McpConfigFile[]): void {
    this.options = { ...this.options, files }
    this.refresh()
  }

  refresh(): { servers: readonly McpServer[]; errors: readonly string[] } {
    const loaded = loadMcpConfig(this.options.files, { env: this.env(), userHome: this.options.userHome ?? homedir() })
    for (const error of loaded.errors) this.options.log?.(`mcp: ${error}`)
    this.servers = loaded.servers
    for (const [name, connection] of this.connections) {
      const current = this.servers.find(server => server.name === name)
      if (!current || JSON.stringify(current) !== connection.config) this.drop(name)
    }
    return loaded
  }

  server(name: string): McpServer | undefined {
    return this.servers.find(server => server.name === name)
  }

  private drop(name: string): void {
    const connection = this.connections.get(name)
    if (!connection) return
    this.connections.delete(name)
    void connection.ready.then(({ client }) => client.close()).catch(() => {})
  }

  private connect(server: McpServer): Connection['ready'] {
    const config = JSON.stringify(server)
    const existing = this.connections.get(server.name)
    if (existing && existing.config === config) return existing.ready
    const ready = (async () => {
      const client = new McpClient({ ...CLIENT, requestTimeoutMs: server.timeoutMs })
      const transport = (this.options.createTransport ?? defaultTransport)(server, this.env())
      try {
        await client.connect(transport)
        const tools = await client.listTools({ timeoutMs: server.timeoutMs })
        return { client, tools }
      } catch (error) {
        await client.close().catch(() => {})
        const stderr = transport instanceof StdioTransport ? transport.stderr.trim().split('\n').slice(-3).join(' ') : ''
        throw new McpUnavailable(`${describe(error)}${stderr ? ` (stderr: ${describe(stderr)})` : ''}`)
      }
    })()
    const connection: Connection = { config, ready }
    this.connections.set(server.name, connection)
    // 失败的连接不缓存，下次调用重试；连上之后断开也一样。
    ready.then(
      ({ client }) => client.onClose(() => { if (this.connections.get(server.name) === connection) this.connections.delete(server.name) }),
      () => { if (this.connections.get(server.name) === connection) this.connections.delete(server.name) },
    )
    return ready
  }

  async tools(name: string): Promise<Tool[]> {
    const server = this.server(name)
    if (!server) throw new McpUnavailable(`there is no MCP server named ${JSON.stringify(name)}`)
    return (await this.connect(server)).tools
  }

  async call(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const server = this.server(name)
    if (!server) throw new McpUnavailable(`there is no MCP server named ${JSON.stringify(name)}`)
    const { client } = await this.connect(server)
    return client.callTool(tool, args, { timeoutMs: server.timeoutMs, ...(signal ? { signal } : {}) })
  }

  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(connections.map(connection => connection.ready.then(({ client }) => client.close()).catch(() => {})))
  }
}
