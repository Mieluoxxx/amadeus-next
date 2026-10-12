import { homedir } from 'node:os'
import path from 'node:path'
import { ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ParentPortLike } from '../pi-worker.ts'
import { McpManager, mcpConfigFiles, skillRoots, type CapabilityMode, type HandoffOptions } from './handoff/index.ts'
import { TargetPool, sshConnector } from './remote/pool.ts'
import { targetsFromEnv } from './remote/targets.ts'
import { DurableRuntime } from './runtime.ts'

type Json = Record<string, unknown>

const modeOf = (value: string | undefined): CapabilityMode => (value?.trim().toLowerCase() === 'shared' ? 'shared' : 'isolated')

/**
 * 子代理的 skills 与 MCP（设置页的两个开关，经环境变量进 worker，变化时 worker 重载）。
 * 不知道 amadeus 主目录（基准脚本、旧主进程）就都不挂，而不是猜一个目录去读。
 */
export function capabilitiesFromEnv(env: NodeJS.ProcessEnv, log: (message: string) => void): Pick<HandoffOptions, 'skills' | 'mcp'> {
  const home = env.AMADEUS_HOME_DIR?.trim()
  if (!home) return {}
  const userHome = homedir()
  const sharedDir = env.AMADEUS_PI_SHARED_DIR?.trim() || path.join(userHome, '.pi', 'agent')
  return {
    skills: { roots: skillRoots(modeOf(env.AMADEUS_SKILLS_MODE), { home, sharedDir, userHome }), log },
    mcp: new McpManager({ files: mcpConfigFiles(modeOf(env.AMADEUS_MCP_MODE), { home, sharedDir }), userHome, log }),
  }
}

export function startDurableWorker(port: ParentPortLike): void {
  let runtime: DurableRuntime | null = null

  async function initialize(): Promise<void> {
    const agentDir = getAgentDir()
    // AMADEUS_NEXT_DURABLE_SESSIONS 是 P0 期的旧名，主进程切到新名之前两个都认。
    const sessionsDir = process.env.AMADEUS_NEXT_SESSIONS || process.env.AMADEUS_NEXT_DURABLE_SESSIONS
    if (!sessionsDir) throw new Error('Durable session directory is required')
    // 只复用 pi-coding-agent 的 ModelRuntime：auth.json / models.json 不用改（评估 P1）。
    const models = await ModelRuntime.create({
      authPath: process.env.AMADEUS_NEXT_PI_AUTH,
      modelsPath: process.env.AMADEUS_NEXT_PI_MODELS,
      modelsStorePath: path.join(agentDir, 'models-store.json'),
    })
    if (models.getError()) throw new Error('Pi model configuration is invalid')
    const log = (message: string) => console.error(`[amadeus-next] ${message}`)
    const targets = targetsFromEnv(process.env, log)
    const runnerFile = process.env.AMADEUS_RUNNER_FILE?.trim()
    if (targets.length && !runnerFile) log('remote targets are configured but the runner bundle is unknown; remote tasks are disabled')
    const remote = targets.length && runnerFile ? new TargetPool({ targets, connector: sshConnector({ runnerFile }) }) : undefined
    const created = new DurableRuntime({
      models, sessionsDir, agentDir,
      memoryDir: process.env.AMADEUS_MEMORY_DIR,
      post: message => port.postMessage(message),
      handoff: capabilitiesFromEnv(process.env, log),
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
