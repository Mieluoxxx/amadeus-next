/// <reference types="vite/client" />

export declare global {
  /**
   * The optional preload bridge. This mirrors exactly what
   * `src/preload/index.ts` exposes on `window.amadeus`.
   */
  interface AmadeusAPI {
    platform: string
    getDesktopSettings: () => Promise<Record<string, unknown> | null>
    updateDesktopSettings: (update: {
      values?: Record<string, string | boolean | null>
      secrets?: Record<string, string | null>
    }) => Promise<{ ok: boolean; error?: string; settings?: Record<string, unknown> }>
  }

  interface Window {
    amadeus?: AmadeusAPI
  }
}
