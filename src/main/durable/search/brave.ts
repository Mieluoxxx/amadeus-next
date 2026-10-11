import { asText, isRecord, requestJson } from './http.ts'
import { SearchFailure, type SearchHit, type SearchProvider } from './types.ts'

// 依据 Brave Search API 文档（api-dashboard.search.brave.com 的 Web Search 与官方 brave-search-skills）：
// GET /res/v1/web/search，鉴权头 X-Subscription-Token；q 为 1 到 400 字符、最多 50 个词；count 为 1 到 20；
// text_decorations 缺省 true，会在片段里插高亮标记，这里关掉；结果在 web.results[]，字段 title / url / description。
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const MAX_QUERY_CHARS = 400
const MAX_QUERY_WORDS = 50

/** 超出 q 的上限会被 422 拒绝，所以在这里截断而不是让子代理为措辞反复试错。 */
export function braveQuery(query: string): string {
  const words = query.replace(/\s+/g, ' ').trim().split(' ').slice(0, MAX_QUERY_WORDS).join(' ')
  return Array.from(words).slice(0, MAX_QUERY_CHARS).join('').trim()
}

export function createBraveProvider(options: { apiKey: string; fetch?: typeof fetch }): SearchProvider {
  const fetchImpl = options.fetch ?? fetch
  return {
    name: 'brave',
    async search({ query, maxResults, signal }) {
      const url = new URL(ENDPOINT)
      url.searchParams.set('q', braveQuery(query))
      url.searchParams.set('count', String(Math.min(Math.max(maxResults, 1), 20)))
      url.searchParams.set('text_decorations', 'false')
      const body = await requestJson(fetchImpl, url, { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': options.apiKey } }, signal)
      if (!isRecord(body)) throw new SearchFailure('malformed', 'The search service returned an unreadable response.')
      // 没有网页结果时 Brave 可能整个省略 web。
      const results = isRecord(body.web) && Array.isArray(body.web.results) ? body.web.results : []
      return results.flatMap((entry): SearchHit[] =>
        isRecord(entry) && asText(entry.url) ? [{ title: asText(entry.title), url: asText(entry.url), snippet: asText(entry.description) }] : [],
      )
    },
  }
}
