export type ChatProviderOption = { value: string; label: string }

export const CHAT_PROVIDER_OPTIONS: readonly ChatProviderOption[] = [
  { value: 'pi', label: 'Pi' },
]

export function chatProviderLabel(value: unknown): string {
  const id = String(value ?? '').trim().toLowerCase()
  return CHAT_PROVIDER_OPTIONS.find(option => option.value === id)?.label || id
}
