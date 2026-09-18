export const SUPPORTED_LOCALES = ['en-US', 'zh-CN', 'ja-JP'] as const
export type Locale = typeof SUPPORTED_LOCALES[number]

export function normalizeLocale(value: unknown): Locale {
  const raw = String(value || '').trim().toLowerCase().replace('_', '-')
  if (raw === 'zh' || raw === 'zh-cn' || raw === 'chinese') return 'zh-CN'
  if (raw === 'ja' || raw === 'ja-jp' || raw === 'japanese') return 'ja-JP'
  return 'en-US'
}

export function interpolate(template: string, values: Record<string, unknown> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}
