import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getSupportedThinkingLevels, type Api, type Model, type Models, type ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'

export type Selection = { provider?: string; model?: string; thinkingLevel?: string }

// 与 pi-coding-agent 的 DEFAULT_THINKING_LEVEL 保持一致，两种运行时切换时思考档位不跳变。
const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'medium'
const ALL_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const settingsFile = (agentDir: string) => path.join(agentDir, 'settings.json')

function readSettings(agentDir: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(settingsFile(agentDir), 'utf8'))
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch { return {} }
}

/** 沿用旧运行时的 settings.json 字段，切换运行时无需改配置（评估 P1）。 */
export function readSelection(agentDir: string): Selection {
  const stored = readSettings(agentDir)
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined
  return { provider: text(stored.defaultProvider), model: text(stored.defaultModel), thinkingLevel: text(stored.defaultThinkingLevel) }
}

export function writeSelection(agentDir: string, change: Selection): void {
  const stored = readSettings(agentDir)
  if (change.provider !== undefined) stored.defaultProvider = change.provider
  if (change.model !== undefined) stored.defaultModel = change.model
  if (change.thinkingLevel !== undefined) stored.defaultThinkingLevel = change.thinkingLevel
  mkdirSync(agentDir, { recursive: true })
  const file = settingsFile(agentDir)
  // 先写临时文件再改名，避免与 pi-coding-agent 共享的设置文件写到一半被读到。
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

export function thinkingLevels(model: Model<Api> | undefined): ModelThinkingLevel[] {
  return model ? getSupportedThinkingLevels(model) : [...ALL_LEVELS]
}

export type Resolved = { model: Model<Api>; ref: ModelRef; thinkingLevel: ModelThinkingLevel }

/** 设置里的默认模型优先；不可用时退到第一个有凭据的模型，与旧运行时的初始模型规则一致。 */
export async function resolveSelection(models: Models, agentDir: string): Promise<Resolved | undefined> {
  const selection = readSelection(agentDir)
  let model = selection.provider && selection.model ? models.getModel(selection.provider, selection.model) : undefined
  if (!model) model = (await models.getAvailable(undefined, { signal: AbortSignal.timeout(15000) }))[0]
  if (!model) return undefined
  const levels = thinkingLevels(model)
  const wanted = (selection.thinkingLevel || DEFAULT_THINKING_LEVEL) as ModelThinkingLevel
  const thinkingLevel = levels.includes(wanted) ? wanted : levels.includes(DEFAULT_THINKING_LEVEL) ? DEFAULT_THINKING_LEVEL : levels[0] ?? 'off'
  return { model, ref: { provider: model.provider, modelId: model.id }, thinkingLevel }
}
