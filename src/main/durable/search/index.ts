import { createBraveProvider } from './brave.ts'
import { createTavilyProvider } from './tavily.ts'
import type { SearchConfig, SearchProvider, SearchProviderName } from './types.ts'

export { braveQuery, createBraveProvider } from './brave.ts'
export { createTavilyProvider } from './tavily.ts'
export { SEARCH_TIMEOUT_MS, SearchFailure, type SearchConfig, type SearchHit, type SearchProvider, type SearchProviderName, type SearchRequest } from './types.ts'

export const SEARCH_PROVIDER_ENV = 'AMADEUS_SEARCH_PROVIDER'
export const SEARCH_API_KEY_ENV = 'AMADEUS_SEARCH_API_KEY'

const PROVIDERS: readonly SearchProviderName[] = ['brave', 'tavily']

/**
 * 主人未配置或配置不完整时返回 undefined，web_search 保持"尚未配置后端"的行为；
 * 不抛错也不回显密钥：配置问题由设置页提示，不该变成运行时崩溃。
 */
export function searchConfigFromEnv(env: NodeJS.ProcessEnv): SearchConfig | undefined {
  const provider = env[SEARCH_PROVIDER_ENV]?.trim().toLowerCase()
  const apiKey = env[SEARCH_API_KEY_ENV]?.trim()
  if (!provider || !apiKey || !(PROVIDERS as readonly string[]).includes(provider)) return undefined
  return { provider: provider as SearchProviderName, apiKey }
}

export function createSearchProvider(config: SearchConfig): SearchProvider {
  const options = { apiKey: config.apiKey, ...(config.fetch ? { fetch: config.fetch } : {}) }
  return config.provider === 'brave' ? createBraveProvider(options) : createTavilyProvider(options)
}
