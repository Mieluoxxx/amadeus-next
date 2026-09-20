import { useCallback, useEffect, useRef, useState } from 'react'

type Payload = Record<string, unknown>
type Subscriber = (payload: Payload) => void

export type NextRuntime = {
  connected: boolean
  send: (method: string, params?: Payload) => Promise<Payload>
  subscribe: (method: string, listener: Subscriber) => () => void
}

export function usePiRuntime(): NextRuntime {
  const [connected, setConnected] = useState(false)
  const subscribers = useRef(new Map<string, Set<Subscriber>>())

  useEffect(() => {
    if (!window.salieriNext) return
    setConnected(true)
    return window.salieriNext.onEvent(event => {
      const listeners = subscribers.current.get(event.method)
      if (!listeners) return
      for (const listener of listeners) listener(event.params || {})
    })
  }, [])

  const send = useCallback((method: string, params?: Payload) => {
    if (!window.salieriNext) return Promise.reject(new Error('Salieri runtime unavailable'))
    return window.salieriNext.request(method, params)
  }, [])

  const subscribe = useCallback((method: string, listener: Subscriber) => {
    const listeners = subscribers.current.get(method) || new Set<Subscriber>()
    listeners.add(listener)
    subscribers.current.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) subscribers.current.delete(method)
    }
  }, [])

  useEffect(() => {
    if (!import.meta.hot) return
    const reload = (payload: { targets: string[] }) => {
      void send('dev.reload', payload).then(result => {
        if (!result.ok) console.error(result.error)
      }).catch(console.error)
    }
    import.meta.hot.on('salieri:reload', reload)
    return () => import.meta.hot?.off('salieri:reload', reload)
  }, [send])

  return { connected, send, subscribe }
}
