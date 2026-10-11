import path from 'node:path'
import { ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ParentPortLike } from '../pi-worker.ts'
import { searchConfigFromEnv } from './handoff/index.ts'
import { DurableRuntime } from './runtime.ts'

type Json = Record<string, unknown>

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
    const created = new DurableRuntime({
      models, sessionsDir, agentDir,
      memoryDir: process.env.AMADEUS_MEMORY_DIR,
      post: message => port.postMessage(message),
      handoff: { search: searchConfigFromEnv(process.env) },
      // 仅供测试缩短等待；正式运行用默认的 10 秒。
      ...(process.env.AMADEUS_NEXT_LOCK_WAIT_MS ? { lockWaitMs: Number(process.env.AMADEUS_NEXT_LOCK_WAIT_MS) } : {}),
    })
    // 先取进程锁再开任何库；锁被占用时在 ready 里报错，不开库。
    await created.start()
    runtime = created
    process.once('exit', () => created.releaseLock())
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
