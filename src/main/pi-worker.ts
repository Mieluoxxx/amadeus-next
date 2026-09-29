import { DefaultResourceLoader, ModelRuntime, createAgentSession, getAgentDir, type AgentSession } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openPiSession } from './piSessions.ts'
import { composePrompt } from './role.ts'

type Json = Record<string, unknown>
type ParentPortLike = {
  on(event: 'message', listener: (event: unknown) => void): void
  postMessage(value: unknown): void
}

const port = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

if (!port) throw new Error('Pi worker must run as an Electron utility process')

// 身份在 ~/.amadeus/pi/ROLE.md，输出格式在 PRESENTATION.md；这里只保留与文件无关的协议。
const protocol = 'Explain tool results in the user-facing reply; never expose internal protocol details.'

let modelRuntime: ModelRuntime | null = null
let resourceLoader: DefaultResourceLoader | null = null
const sessions = new Map<string, AgentSession>()
const stopping = new Map<string, Promise<void>>()
const epochs = new Map<string, number>()
const cwd = process.env.AMADEUS_NEXT_PI_CWD || process.cwd()

async function initialize(): Promise<void> {
  const agentDir = getAgentDir()
  modelRuntime = await ModelRuntime.create({
    authPath: process.env.AMADEUS_NEXT_PI_AUTH,
    modelsPath: process.env.AMADEUS_NEXT_PI_MODELS,
    // 模型缓存留在应用目录，不写回共享的 models.json 所在目录。
    modelsStorePath: path.join(agentDir, 'models-store.json'),
  })
  if (modelRuntime.getError()) throw new Error('Pi model configuration is invalid')
  resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPrompt: protocol,
    // 每次 reload 重新读取提示词文件，编辑后不需要重启。
    systemPromptOverride: base => composePrompt(agentDir, base ?? protocol),
    // 系统提示词只有 ROLE.md、PRESENTATION.md 和协议：不加载开发环境的 AGENTS.md、扩展、技能和提示词模板。
    noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  })
  await resourceLoader.reload()
  if (resourceLoader.getExtensions().errors.length) throw new Error('Pi extensions could not be loaded')
}

// 用户在界面里选的模型是全局的：新会话从它开始，打开旧会话时也切到它，而不是沿用会话里上次的模型。
// 每个会话的 SettingsManager 各自缓存，别的会话写下的选择只能从文件里读到。
function readSelection(): { provider?: string; model?: string; thinkingLevel?: string } {
  try {
    const stored = JSON.parse(readFileSync(path.join(getAgentDir(), 'settings.json'), 'utf8')) as Json
    const text = (value: unknown) => typeof value === 'string' && value ? value : undefined
    return { provider: text(stored.defaultProvider), model: text(stored.defaultModel), thinkingLevel: text(stored.defaultThinkingLevel) }
  } catch { return {} }
}

async function followSelection(session: AgentSession): Promise<void> {
  if (!modelRuntime) return
  const selection = readSelection()
  const model = selection.provider && selection.model ? modelRuntime.getModel(selection.provider, selection.model) : undefined
  try {
    if (model && (session.model?.provider !== model.provider || session.model?.id !== model.id)) await session.setModel(model)
    const level = selection.thinkingLevel as Parameters<AgentSession['setThinkingLevel']>[0] | undefined
    if (level && session.getAvailableThinkingLevels().includes(level) && session.thinkingLevel !== level) session.setThinkingLevel(level)
  } catch { /* 选中的模型暂不可用（如缺凭据）时保持会话原有模型 */ }
}

async function getSession(id: string): Promise<AgentSession> {
  const existing = sessions.get(id)
  if (existing) { await followSelection(existing); return existing }
  if (!modelRuntime || !resourceLoader) throw new Error('Pi runtime is unavailable')
  const directory = process.env.AMADEUS_NEXT_PI_SESSIONS
  if (!directory) throw new Error('Pi session directory is required')
  const result = await createAgentSession({
    cwd,
    sessionManager: openPiSession(directory, cwd, id),
    modelRuntime,
    resourceLoader,
  })
  sessions.set(id, result.session)
  await followSelection(result.session)
  return result.session
}

async function handle(message: Json, epoch = 0): Promise<void> {
  const requestId = String(message.id || '')
  const sessionId = String(message.sessionId || '')
  try {
    if (message.command === 'prompt') {
      await stopping.get(sessionId)
      const session = await getSession(sessionId)
      if (epoch !== (epochs.get(sessionId) || 0)) {
        port.postMessage({ type: 'aborted', id: requestId })
        return
      }
      let fullText = ''
      const unsubscribe = session.subscribe((event: any) => {
        if (event?.type === 'message_update') {
          const update = event.assistantMessageEvent
          if (update?.type === 'text_delta' && update.delta) {
            const delta = String(update.delta)
            fullText += delta
            port.postMessage({ type: 'text', id: requestId, delta })
          }
        } else if (event?.type === 'tool_execution_start') {
          port.postMessage({ type: 'tool', id: requestId, name: String(event.toolName || 'tool'), done: false })
        } else if (event?.type === 'tool_execution_end') {
          port.postMessage({ type: 'tool', id: requestId, name: String(event.toolName || 'tool'), done: true })
        }
      })
      try {
        await session.prompt(String(message.text || ''))
        port.postMessage({ type: 'done', id: requestId, text: fullText })
      } finally {
        unsubscribe?.()
      }
      return
    }
    if (message.command === 'abort') {
      const session = sessions.get(sessionId)
      if (session) {
        const stopped = session.abort()
        stopping.set(sessionId, stopped)
        try { await stopped } finally { if (stopping.get(sessionId) === stopped) stopping.delete(sessionId) }
      }
      port.postMessage({ type: 'aborted', id: requestId })
      return
    }
    if (message.command === 'checkpoint' || message.command === 'reload') {
      for (const session of sessions.values()) {
        await session.waitForIdle()
        await session.settingsManager.flush()
        const errors = session.settingsManager.drainErrors()
        if (errors.length) throw new Error('Pi settings could not be saved; reload cancelled')
      }
      if (message.command === 'reload') {
        if (!modelRuntime || !resourceLoader) throw new Error('Pi runtime is unavailable')
        if (!sessions.size) await resourceLoader.reload()
        for (const session of sessions.values()) await session.reload()
        if (resourceLoader.getExtensions().errors.length) throw new Error('Pi extensions could not be reloaded')
        const result = await modelRuntime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(15000) })
        if (result.aborted || result.errors.size || modelRuntime.getError()) throw new Error('Pi model refresh failed; check model configuration and credentials')
        for (const session of sessions.values()) {
          const model = session.model && modelRuntime.getModel(session.model.provider, session.model.id)
          if (model) await session.setModel(model)
        }
      }
      port.postMessage({ type: 'done', id: requestId })
      return
    }
    if (message.command === 'models' || message.command === 'set-model') {
      if (!modelRuntime) throw new Error('Pi runtime is unavailable')
      const session = await getSession(sessionId)
      if (message.command === 'set-model') {
        if (typeof message.model !== 'string') throw new Error('Invalid model')
        const slash = message.model.indexOf('/')
        const model = modelRuntime.getModel(message.model.slice(0, slash), message.model.slice(slash + 1))
        if (!model || slash < 1) throw new Error('Unknown model')
        if (message.thinkingLevel !== undefined) {
          const level = message.thinkingLevel as Parameters<AgentSession['setThinkingLevel']>[0]
          if (session.model?.provider !== model.provider || session.model?.id !== model.id) throw new Error('Select the model before changing its thinking level')
          if (!session.getAvailableThinkingLevels().includes(level)) throw new Error('Unsupported thinking level')
          session.setThinkingLevel(level, { persist: true })
        } else await session.setModel(model, { persist: true })
        await session.settingsManager.flush()
      }
      const models = await modelRuntime.getAvailable(undefined, { signal: AbortSignal.timeout(15000) })
      port.postMessage({ type: 'done', id: requestId,
        models: models.map(model => ({ value: `${model.provider}/${model.id}`, label: `${model.name} (${model.provider})` })),
        current: session.model ? `${session.model.provider}/${session.model.id}` : '',
        thinkingLevel: session.thinkingLevel, thinkingLevels: session.getAvailableThinkingLevels(),
      })
      return
    }
    throw new Error(`unsupported Pi worker command: ${String(message.command || '')}`)
  } catch (error) {
    port.postMessage({ type: 'error', id: requestId, error: error instanceof Error ? error.message : String(error) })
  }
}

const initialized = initialize()
// The desktop owns one active turn. Serialize maintenance with turns; abort must bypass the queue.
let queue = initialized.catch(() => {})
port.on('message', raw => {
  const value = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw
  const message = value && typeof value === 'object' ? value as Json : {}
  const id = String(message.sessionId || '')
  if (message.command === 'abort') {
    epochs.set(id, (epochs.get(id) || 0) + 1)
    void handle(message)
  } else {
    const epoch = epochs.get(id) || 0
    queue = queue.then(() => handle(message, epoch))
  }
})

initialized
  .then(() => port.postMessage({ type: 'ready' }))
  .catch(error => port.postMessage({ type: 'ready', error: error instanceof Error ? error.message : String(error) }))
