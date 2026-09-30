import { contextBridge, ipcRenderer } from 'electron'

type RuntimeEvent = {
  method: string
  params: Record<string, unknown>
}

const request = (method: string, params?: Record<string, unknown>) =>
  ipcRenderer.invoke('next.request', method, params || {}) as Promise<Record<string, unknown>>

contextBridge.exposeInMainWorld('amadeusNext', {
  request,
  onEvent(listener: (event: RuntimeEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: RuntimeEvent) => listener(payload)
    ipcRenderer.on('next.event', handler)
    return () => ipcRenderer.removeListener('next.event', handler)
  },
})

// Existing scene/settings components use the old optional desktop bridge. Keep
// the small subset they need while the rest of the old shell remains out of the
// new application.
contextBridge.exposeInMainWorld('amadeus', {
  platform: process.platform,
  getDesktopSettings: () => request('desktop.settings.get'),
  updateDesktopSettings: (update: unknown) => request('desktop.settings.update', update as Record<string, unknown>),
})
