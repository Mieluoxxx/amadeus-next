export const DEFAULT_JEV_URL = 'https://opencode.ai/zen/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-1.13-free'

export type JevQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, string> }
  | { type: 'score'; instructions: unknown; criteria: string[] }

export type JevAnswer = {
  type: JevQuestion['type']
  noul?: number
  choice?: string
  score?: number
  probabilities?: unknown
  confidence?: number
}

export type JevConfig = { url: string; apiKey: string; model: string }

/** 未配置密钥时返回 null，调用方据此静默跳过记忆判定而不是报错打断对话。 */
export function jevConfig(env: NodeJS.ProcessEnv): JevConfig | null {
  const apiKey = env.AMADEUS_JEV_API_KEY || ''
  if (!apiKey) return null
  return { url: env.AMADEUS_JEV_URL || DEFAULT_JEV_URL, apiKey, model: env.AMADEUS_JEV_MODEL || DEFAULT_JEV_MODEL }
}

export async function systemOne(
  config: JevConfig,
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<Record<string, JevAnswer>> {
  const response = await fetch(config.url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, state, questions }),
  })
  // 错误正文可能回显请求内容，只暴露状态码以免对话隐私进入日志。
  if (!response.ok) throw new Error(`Jev request failed: HTTP ${response.status}`)
  const body = await response.json() as { answers?: unknown }
  if (!body.answers || typeof body.answers !== 'object') throw new Error('Jev response has no answers')
  return body.answers as Record<string, JevAnswer>
}
