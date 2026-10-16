/**
 * 设置页里由 worker 消费的设置，都以环境变量的形式交给它：fork 时作为初值，之后经 `config.apply` 热更新，不再重启 worker。
 * worker 里的读取方大多在每次使用时读 process.env，所以改写 process.env 就能生效；少数在启动时缓存的由 worker 显式刷新。
 */
export const PROXY_KEYS = ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY'] as const

export const WORKER_SETTING_KEYS = [
  ...PROXY_KEYS,
  'AMADEUS_JEV_URL', 'AMADEUS_JEV_MODEL', 'AMADEUS_JEV_API_KEY',
  'AMADEUS_SKILLS_MODE', 'AMADEUS_MCP_MODE',
  'AMADEUS_DELEGATION_MODEL', 'AMADEUS_TRANSLATION_MODEL',
  'AMADEUS_REMOTE_TARGETS',
] as const

export type WorkerSettingKey = (typeof WORKER_SETTING_KEYS)[number]

/** 把一组设置写进 env：空串表示删除。返回真正变了的键。 */
export function applySettingsEnv(env: NodeJS.ProcessEnv, values: Record<string, unknown>): Set<WorkerSettingKey> {
  const changed = new Set<WorkerSettingKey>()
  for (const key of WORKER_SETTING_KEYS) {
    if (!(key in values)) continue
    const value = typeof values[key] === 'string' ? values[key] as string : ''
    if ((env[key] ?? '') === value) continue
    if (value) env[key] = value
    else delete env[key]
    changed.add(key)
  }
  return changed
}
