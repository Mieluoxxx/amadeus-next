export type SearchProviderName = 'brave' | 'tavily'

export type SearchConfig = {
  provider: SearchProviderName
  apiKey: string
  /** 测试注入；缺省用全局 fetch。 */
  fetch?: typeof fetch
}

export type SearchHit = { title: string; url: string; snippet: string }

export type SearchRequest = {
  query: string
  maxResults: number
  signal?: AbortSignal
}

/**
 * 失败只带面向模型的短原因（已脱敏：不含密钥、请求地址、响应原文），由 web_search 原样转述给子代理。
 * kind 供测试与日志区分，不进模型文本。
 */
export class SearchFailure extends Error {
  readonly kind: 'auth' | 'quota' | 'rejected' | 'http' | 'network' | 'malformed'
  constructor(kind: SearchFailure['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

export type SearchProvider = {
  readonly name: SearchProviderName
  search(request: SearchRequest): Promise<SearchHit[]>
}

export const SEARCH_TIMEOUT_MS = 15_000
