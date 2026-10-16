import type { Context } from '@earendil-works/chord'
import { getSupportedThinkingLevels, type ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelRef, ToolExecutionApi } from '@earendil-works/pi-durable'

/** 设置页的 delegation_model（`provider/model`，空 = 与对话模型相同）经这个环境变量传给 worker，变化经 config.apply 热更新。 */
export const DELEGATION_MODEL_ENV = 'AMADEUS_DELEGATION_MODEL'

/** 模型 id 里可以有斜杠（如 openrouter 的 `anthropic/claude-…`），所以只在第一个斜杠处切。格式不对一律当作没设置。 */
export function delegationModelFromEnv(env: NodeJS.ProcessEnv): ModelRef | undefined {
  const value = env[DELEGATION_MODEL_ENV]?.trim()
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

export type Delegation = {
  /** 给子对话 configure 的模型；缺省时子对话沿用主对话的（任务归属的子对话创建时复制它的 agent）。 */
  model?: ModelRef
  /** 主对话的思考档位委托模型不支持时的替代档位。 */
  thinkingLevel?: ModelThinkingLevel
  /** 指定了委托模型却用不了：原因。写进条目的 failure.detail，只给任务卡片看。 */
  fallback?: string
}

/**
 * 在 handoff 的 commit 之前决定子对话用哪个模型：目录里有、有凭据才用；否则回退到对话模型并留下原因。
 * 检查本身出错也回退——委托不能因为模型目录读不出来而失败。
 */
export async function resolveDelegation(wanted: ModelRef | undefined, api: ToolExecutionApi, context: Context): Promise<Delegation> {
  if (!wanted) return {}
  const label = `${wanted.provider}/${wanted.modelId}`
  try {
    const model = api.models.getModel(wanted.provider, wanted.modelId)
    if (!model) return { fallback: `Delegation model ${label} is not in the model catalog; the conversation model was used instead.` }
    const available = await api.models.getAvailable(undefined, { signal: AbortSignal.timeout(15_000) })
    if (!available.some(each => each.provider === model.provider && each.id === model.id)) {
      return { fallback: `Delegation model ${label} has no usable credentials; the conversation model was used instead.` }
    }
    const levels = getSupportedThinkingLevels(model)
    const current = (await api.agent(context)).thinkingLevel
    if (!current || levels.includes(current)) return { model: wanted }
    const thinkingLevel = levels.includes('medium') ? 'medium' : levels[0]
    return { model: wanted, ...(thinkingLevel ? { thinkingLevel } : {}) }
  } catch (error) {
    if (context.abortSignal?.aborted) throw error
    return { fallback: `Delegation model ${label} could not be checked (${error instanceof Error ? error.message : String(error)}); the conversation model was used instead.` }
  }
}
