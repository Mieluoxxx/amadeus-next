// 评估 P2（首包延迟）与 P3（缓存命中率）：用主人真实的模型配置连续对话，会产生真实的 API 费用。
// 用法：node --experimental-strip-types scripts/durable-bench.mjs [--turns 20] [--interval 30] [--legacy]
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { DefaultResourceLoader, ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent'
import { DurableRuntime } from '../src/main/durable/runtime.ts'
import { composePrompt } from '../src/main/role.ts'
import { readSelection } from '../src/main/durable/modelSelection.ts'

const { values } = parseArgs({ options: {
  turns: { type: 'string', default: '20' },
  interval: { type: 'string', default: '30' },
  legacy: { type: 'boolean', default: false },
} })
const turns = Number(values.turns)
const home = process.env.AMADEUS_HOME || path.join(os.homedir(), '.amadeus')
const agentDir = path.join(home, 'pi')
const shared = process.env.AMADEUS_PI_CREDENTIALS_DIR || path.join(os.homedir(), '.pi', 'agent')
const models = await ModelRuntime.create({ authPath: path.join(shared, 'auth.json'), modelsPath: path.join(shared, 'models.json'), modelsStorePath: path.join(agentDir, 'models-store.json') })
if (models.getError()) throw new Error(models.getError())

// 每轮问题不同但都很短，避免回答长度主导耗时；20 轮足以看出缓存是否稳定命中。
const prompts = Array.from({ length: turns }, (_, index) => `第 ${index + 1} 轮：用一句话回答，${index % 2 ? '今天适合喝咖啡吗' : '你现在在想什么'}？`)
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }
const p95 = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] }
const report = (label, firsts) => console.log(`${label}: first text median ${median(firsts).toFixed(0)}ms, p95 ${p95(firsts).toFixed(0)}ms (n=${firsts.length})`)

async function durable() {
  const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-bench-'))
  const memoryDir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-bench-memory-'))
  let first = 0
  let started = 0
  const finished = new Map()
  const runtime = new DurableRuntime({
    models, agentDir, sessionsDir, memoryDir,
    settings: { progress: { partialIntervalMs: Number(values.interval), outputIntervalMs: 100 } },
    post: message => {
      if (message.type !== 'event') return
      if (message.name === 'turn.text' && !first) first = performance.now() - started
      if (message.name === 'turn.done' || message.name === 'turn.error' || message.name === 'turn.aborted') finished.get(message.turnId)?.(message)
    },
  })
  await runtime.start()
  const firsts = []
  try {
    await runtime.handle({ id: 'create', command: 'session.create', params: { sessionId: 'bench', title: 'bench' } })
    for (const [index, text] of prompts.entries()) {
      first = 0
      const turnId = `turn-${index}`
      const done = new Promise(resolve => finished.set(turnId, resolve))
      started = performance.now()
      await runtime.handle({ id: `b${index}`, command: 'chat.submit', params: { sessionId: 'bench', turnId, text } })
      const result = await done
      if (result.name !== 'turn.done') throw new Error(`turn ${index + 1} ended as ${result.name}: ${result.error ?? ''}`)
      firsts.push(first)
    }
    const open = runtime.host.peek('bench')
    const page = await open.root.entries({ order: 'ascending' }, 1000, undefined, BACKGROUND_CONTEXT)
    const usages = page.items.filter(entry => entry.kind === 'pi.assistant').map(entry => entry.model?.[0]?.usage).filter(Boolean)
    report(`durable (partialIntervalMs ${values.interval})`, firsts)
    for (const [index, usage] of usages.entries()) {
      const total = usage.input + usage.cacheRead + usage.cacheWrite
      console.log(`  turn ${index + 1}: cacheRead ${usage.cacheRead} / ${total} = ${total ? (100 * usage.cacheRead / total).toFixed(1) : '0'}%`)
    }
    const later = usages.slice(1).map(usage => usage.cacheRead / Math.max(1, usage.input + usage.cacheRead + usage.cacheWrite))
    console.log(`  turns 2+: min hit ${(100 * Math.min(...later)).toFixed(1)}% (P3 passes at ≥ 80%)`)
  } finally {
    await runtime.handle({ id: 'checkpoint', command: 'checkpoint' })
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(memoryDir, { recursive: true, force: true })
  }
}

async function legacy() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'amadeus-bench-legacy-'))
  const protocol = 'Explain tool results in the user-facing reply; never expose internal protocol details.'
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, systemPrompt: protocol,
    systemPromptOverride: base => composePrompt(agentDir, base ?? protocol),
    noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), modelRuntime: models, resourceLoader })
  const selection = readSelection(agentDir)
  const model = selection.provider && selection.model ? models.getModel(selection.provider, selection.model) : undefined
  if (model) await session.setModel(model)
  const firsts = []
  try {
    for (const text of prompts) {
      let first = 0
      const started = performance.now()
      const unsubscribe = session.subscribe(event => {
        if (!first && event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') first = performance.now() - started
      })
      await session.prompt(text)
      unsubscribe()
      firsts.push(first)
    }
    report('legacy pi-coding-agent', firsts)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
}

await durable()
if (values.legacy) await legacy()
