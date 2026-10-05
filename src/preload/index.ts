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

// 暴露最小兼容桥接接口，供既有场景及设置组件过渡使用，避免破坏前端既有调用。
contextBridge.exposeInMainWorld('amadeus', {
  platform: process.platform,
  getDesktopSettings: () => request('desktop.settings.get'),
  updateDesktopSettings: (update: unknown) => request('desktop.settings.update', update as Record<string, unknown>),
})
