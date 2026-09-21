export {}

declare global {
  type NextRuntimeEvent = {
    method: string
    params: Record<string, unknown>
  }

  interface AmadeusNextBridge {
    request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
    onEvent(listener: (event: NextRuntimeEvent) => void): () => void
    getDesktopSettings(): Promise<Record<string, unknown>>
    updateDesktopSettings(update: {
      values?: Record<string, string | boolean | null>
      secrets?: Record<string, string | null>
    }): Promise<{ ok: boolean; error?: string; settings?: Record<string, unknown> }>
  }

  interface Window {
    amadeusNext: AmadeusNextBridge
  }
}
