import { asText, isRecord, requestJson } from './http.ts'
import { SearchFailure, type SearchHit, type SearchProvider } from './types.ts'

// 依据 Tavily 文档（docs.tavily.com 的 Search 接口与 OpenAPI）：
// POST https://api.tavily.com/search，鉴权头 Authorization: Bearer <key>；
// 请求体 query、max_results（0 到 20）、search_depth（basic 消耗 1 个额度，advanced 2 个）；
// 结果在 results[]，字段 title / url / content；错误体是 { detail: { error } }，状态码 401 / 429 / 432 / 433 等。
const ENDPOINT = 'https://api.tavily.com/search'

export function createTavilyProvider(options: { apiKey: string; fetch?: typeof fetch }): SearchProvider {
  const fetchImpl = options.fetch ?? fetch
  return {
    name: 'tavily',
    async search({ query, maxResults, signal }) {
      const body = await requestJson(
        fetchImpl,
        new URL(ENDPOINT),
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          // 只要结果列表：不请求生成式答案、原文和图片，省额度也省 token。
          body: JSON.stringify({
            query: query.replace(/\s+/g, ' ').trim(),
            max_results: Math.min(Math.max(maxResults, 1), 20),
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
            include_images: false,
          }),
        },
        signal,
      )
      if (!isRecord(body) || !Array.isArray(body.results)) throw new SearchFailure('malformed', 'The search service returned an unreadable response.')
      return body.results.flatMap((entry): SearchHit[] =>
        isRecord(entry) && asText(entry.url) ? [{ title: asText(entry.title), url: asText(entry.url), snippet: asText(entry.content) }] : [],
      )
    },
  }
}
