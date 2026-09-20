/// <reference types="vite/client" />

export declare global {
  /**
   * The optional preload bridge. This mirrors exactly what
   * `src/preload/index.ts` exposes on `window.amadeus`; the Electron host stubs
   * the members a Next-only runtime has no independent owner for.
   */
  interface AmadeusAPI {
    wallpaperHost: 'macos-companion'
    platform: string
    getDesktopSettings: () => Promise<Record<string, unknown> | null>
    updateDesktopSettings: (update: {
      values?: Record<string, string | boolean | null>
      secrets?: Record<string, string | null>
    }) => Promise<{ ok: boolean; error?: string; settings?: Record<string, unknown> }>
    restartBackend: () => Promise<{ restarted: boolean; reason?: string }>
    focusMainWindow: () => Promise<boolean>
    /** Preload accepts this payload and currently ignores it. */
    notifyTaskComplete: (payload?: {
      key: string
      title: string
      body: string
      workItemId?: string
    }) => Promise<boolean>
    onTaskCompleteActivated: (listener: (payload: { key: string; workItemId: string }) => void) => () => void
    openWorkOverlay: () => Promise<boolean>
    closeWorkOverlay: () => Promise<boolean>
  }

  interface Window {
    amadeus?: AmadeusAPI
  }
}
