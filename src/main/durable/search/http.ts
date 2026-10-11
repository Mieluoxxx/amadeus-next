import { SEARCH_TIMEOUT_MS, SearchFailure } from './types.ts'

// 错误响应的 body 用不着：释放连接即可，不等取消完成（被 tee 过的 body 要两路都取消才会 resolve）。
const discard = (response: Response): void => void response.body?.cancel().catch(() => {})

/**
 * 两个后端共用的请求与错误映射。
 * redirect: 'error'：fetch 跨源重定向只会剥掉 Authorization，不会剥自定义头（Brave 的 X-Subscription-Token），
 * 而搜索 API 本来就不该重定向，遇到就当失败，免得密钥被带到别的主机。
 */
export async function requestJson(
  fetchImpl: typeof fetch,
  url: URL,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS), ...(signal ? [signal] : [])]
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.any(signals) })
  } catch (error) {
    // 调用方取消要原样抛出，让工具任务以 aborted 收尾；其余（超时、断网、重定向）都归为连接失败。
    if (signal?.aborted) throw error
    throw new SearchFailure('network', 'The search service could not be reached (connection error or timeout).')
  }
  if (response.status === 401 || response.status === 403) {
    discard(response)
    throw new SearchFailure('auth', 'The search service rejected its credentials, so web search is unavailable.')
  }
  // 限速与用量超限：429 两家都用，Brave 另有 402，Tavily 另用 432（套餐用量）与 433（按量用量）。
  if (response.status === 402 || response.status === 429 || response.status === 432 || response.status === 433) {
    discard(response)
    throw new SearchFailure('quota', 'The search service is rate limited or over its usage limit; try again later.')
  }
  if (response.status === 400 || response.status === 422) {
    discard(response)
    throw new SearchFailure('rejected', 'The search service rejected this query; try different keywords.')
  }
  if (!response.ok) {
    discard(response)
    throw new SearchFailure('http', `The search service returned HTTP ${response.status}.`)
  }
  try {
    return await response.json()
  } catch (error) {
    if (signal?.aborted) throw error
    throw new SearchFailure('malformed', 'The search service returned an unreadable response.')
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const asText = (value: unknown): string => (typeof value === 'string' ? value : '')
