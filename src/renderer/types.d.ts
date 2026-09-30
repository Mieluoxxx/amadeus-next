export {}

declare global {
  type NextRuntimeEvent = {
    method: string
    params: Record<string, unknown>
  }

  interface AmadeusNextBridge {
    request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
    onEvent(listener: (event: NextRuntimeEvent) => void): () => void
  }

  interface Window {
    amadeusNext: AmadeusNextBridge
  }
}
