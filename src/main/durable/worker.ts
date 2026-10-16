import { homedir } from 'node:os'
import path from 'node:path'
import { ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ParentPortLike } from '../pi-worker.ts'
import { McpManager, mcpConfigFiles, skillRoots, type CapabilityMode, type HandoffOptions } from './handoff/index.ts'
import { TargetPool, sshConnector } from './remote/pool.ts'
import { targetsFromEnv } from './remote/targets.ts'
import { DurableRuntime } from './runtime.ts'
import { installProxy } from './proxy.ts'
import { PROXY_KEYS } from '../../shared/workerSettings.ts'

type Json = Record<string, unknown>

const modeOf = (value: string | undefined): CapabilityMode => (value?.trim().toLowerCase() === 'shared' ? 'shared' : 'isolated')

type Capabilities = Pick<HandoffOptions, 'skills' | 'mcp'>

function capabilityDirs(env: NodeJS.ProcessEnv): { home: string; sharedDir: string; userHome: string } | undefined {
  const home = env.AMADEUS_HOME_DIR?.trim()
  if (!home) return undefined
  const userHome = homedir()
  return { home, sharedDir: env.AMADEUS_PI_SHARED_DIR?.trim() || path.join(userHome, '.pi', 'agent'), userHome }
}

/**
 * 子代理的 skills 与 MCP（设置页的两个开关）。不知道 amadeus 主目录（基准脚本）就都不挂，而不是猜一个目录去读。
 */
export function capabilitiesFromEnv(env: NodeJS.ProcessEnv, log: (message: string) => void): Capabilities {
  const dirs = capabilityDirs(env)
  if (!dirs) return {}
  return {
    skills: { roots: skillRoots(modeOf(env.AMADEUS_SKILLS_MODE), dirs), log },
    mcp: new McpManager({ files: mcpConfigFiles(modeOf(env.AMADEUS_MCP_MODE), dirs), userHome: dirs.userHome, log }),
  }
}

/** 设置页切换了来源：原地改。委托扩展每次受理都现扫 skills、现读 MCP 配置，所以不必重建扩展。 */
export function refreshCapabilities(capabilities: Capabilities, env: NodeJS.ProcessEnv): void {
  const dirs = capabilityDirs(env)
  if (!dirs) return
  if (capabilities.skills) capabilities.skills.roots = skillRoots(modeOf(env.AMADEUS_SKILLS_MODE), dirs)
  capabilities.mcp?.setFiles(mcpConfigFiles(modeOf(env.AMADEUS_MCP_MODE), dirs))
}

export function startDurableWorker(port: ParentPortLike): void {
  let runtime: DurableRuntime | null = null

  async function initialize(): Promise<void> {
    const agentDir = getAgentDir()
    const sessionsDir = process.env.AMADEUS_NEXT_SESSIONS
    if (!sessionsDir) throw new Error('Durable session directory is required')
    // 只复用 pi-coding-agent 的 ModelRuntime：auth.json / models.json 不用改（评估 P1）。
    const models = await ModelRuntime.create({
      authPath: process.env.AMADEUS_NEXT_PI_AUTH,
      modelsPath: process.env.AMADEUS_NEXT_PI_MODELS,
      modelsStorePath: path.join(agentDir, 'models-store.json'),
    })
    if (models.getError()) throw new Error('Pi model configuration is invalid')
    const log = (message: string) => console.error(`[amadeus-next] ${message}`)
    installProxy()
    const targets = targetsFromEnv(process.env, log)
    const runnerFile = process.env.AMADEUS_RUNNER_FILE?.trim()
    if (targets.length && !runnerFile) log('remote targets are configured but the runner bundle is unknown; remote tasks are disabled')
    // 没有目标也建池子：设置页之后加了机器，热更新直接往里加。
    const remote = runnerFile ? new TargetPool({ targets, connector: sshConnector({ runnerFile }) }) : undefined
    const capabilities = capabilitiesFromEnv(process.env, log)
    const created = new DurableRuntime({
      models, sessionsDir, agentDir,
      memoryDir: process.env.AMADEUS_MEMORY_DIR,
      post: message => port.postMessage(message),
      handoff: capabilities,
      onSettings: changed => {
        if (PROXY_KEYS.some(key => changed.has(key))) installProxy()
        if (changed.has('AMADEUS_SKILLS_MODE') || changed.has('AMADEUS_MCP_MODE')) refreshCapabilities(capabilities, process.env)
      },
      ...(remote ? { remote } : {}),
      // 仅供测试缩短等待；正式运行用默认的 10 秒。
      ...(process.env.AMADEUS_NEXT_LOCK_WAIT_MS ? { lockWaitMs: Number(process.env.AMADEUS_NEXT_LOCK_WAIT_MS) } : {}),
    })
    // 先取进程锁再开任何库；锁被占用时在 ready 里报错，不开库。
    await created.start()
    runtime = created
    process.once('exit', () => {
      created.releaseLock()
      remote?.close()
    })
  }

  const initialized = initialize()
  const unavailable = (id: string) => port.postMessage({ type: 'error', id, code: 'failed', error: 'Pi runtime is unavailable' })

  port.on('message', raw => {
    const value = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw
    const message: Json = value && typeof value === 'object' ? value as Json : {}
    // 就绪前到达的命令按到达顺序等待；之后的分道、abort 旁路与 epoch 都在 runtime.handle 里。
    void initialized.then(() => (runtime ? runtime.handle(message) : unavailable(String(message.id || ''))), () => unavailable(String(message.id || '')))
  })

  initialized
    .then(() => {
      port.postMessage({ type: 'ready' })
      void runtime?.warm()
    })
    .catch(error => port.postMessage({ type: 'ready', error: error instanceof Error ? error.message : String(error) }))
}
