import { DefaultResourceLoader, ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent'

type Json = Record<string, unknown>
type ParentPortLike = {
  on(event: 'message', listener: (event: unknown) => void): void
  postMessage(value: unknown): void
}

const port = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort

if (!port) throw new Error('Pi worker must run as an Electron utility process')

const systemPrompt = [
  'You are Amadeus, a warm desktop companion embedded in Salieri.',
  'Speak naturally and concisely. Keep the character present while using Pi tools when they help.',
  'Explain tool results in the user-facing reply; never expose internal protocol details.',
  'For natural character expression, optionally put [EMO preset=smile] before the matching phrase in your spoken reply.',
  'Allowed presets: normal, smile, sad, shy, surprised, angry, thinking, serious_speaking. Use sparingly at emotional or topic changes.',
  'These annotations are removed before display and speech. Never place them inside code or tool arguments. Do not call tools to change expressions.',
].join('\n')

let pi: typeof import('@earendil-works/pi-coding-agent') | null = null
let modelRuntime: ModelRuntime | null = null
let resourceLoader: DefaultResourceLoader | null = null
const sessions = new Map<string, any>()
const stopping = new Map<string, Promise<void>>()

async function initialize(): Promise<void> {
  pi = await import('@earendil-works/pi-coding-agent')
  modelRuntime = await ModelRuntime.create()
  resourceLoader = new DefaultResourceLoader({
    cwd: process.env.SALIERI_NEXT_PI_CWD || process.cwd(),
    agentDir: pi.getAgentDir(),
    systemPrompt,
  })
  await resourceLoader.reload()
}

async function getSession(id: string): Promise<any> {
  const existing = sessions.get(id)
  if (existing) return existing
  if (!pi || !modelRuntime || !resourceLoader) throw new Error('Pi runtime is unavailable')
  const result = await createAgentSession({
    cwd: process.env.SALIERI_NEXT_PI_CWD || process.cwd(),
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    resourceLoader,
  })
  sessions.set(id, result.session)
  return result.session
}

async function handle(raw: unknown): Promise<void> {
  const value = raw && typeof raw === 'object' && 'data' in raw
    ? (raw as { data: unknown }).data
    : raw
  const message = value && typeof value === 'object' ? value as Json : {}
  const requestId = String(message.id || '')
  const sessionId = String(message.sessionId || '')
  try {
    if (message.command === 'prompt') {
      await stopping.get(sessionId)
      const session = await getSession(sessionId)
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
        const stopped = session.abort() as Promise<void>
        stopping.set(sessionId, stopped)
        try { await stopped } finally { if (stopping.get(sessionId) === stopped) stopping.delete(sessionId) }
      }
      port.postMessage({ type: 'aborted', id: requestId })
      return
    }
    throw new Error(`unsupported Pi worker command: ${String(message.command || '')}`)
  } catch (error) {
    port.postMessage({ type: 'error', id: requestId, error: error instanceof Error ? error.message : String(error) })
  }
}

port.on('message', event => { void handle(event) })

initialize()
  .then(() => port.postMessage({ type: 'ready' }))
  .catch(error => port.postMessage({ type: 'ready', error: error instanceof Error ? error.message : String(error) }))
