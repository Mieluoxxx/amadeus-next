import { useEffect, useState } from 'react'
import { isTrustedSceneMessage, isCurrentLoadMessage } from './components/scene/useSceneBridge'
import { isTurnKey, type VoiceEvent } from '../shared/voice.ts'
import type { NextRuntime } from './usePiRuntime'

export default function SceneVoiceBridge({ runtime }: { runtime: NextRuntime }) {
  const [error, setError] = useState('')
  const { send, subscribe } = runtime
  useEffect(() => {
    let port: MessagePort | null = null
    let frame: HTMLIFrameElement | null = null
    let token = ''
    let ready = false
    let connection = 0
    const disconnect = () => {
      connection++; ready = false
      port?.close(); port = null
      if (frame) void send('scene.lost', { token }).catch(() => {})
      frame = null
    }
    const connect = (event: MessageEvent) => {
      const candidate = document.querySelector<HTMLIFrameElement>('iframe[data-testid="scene-frame"]')
      if (!candidate) return
      const url = new URL(candidate.src)
      const loadToken = url.searchParams.get('sceneLoadToken') || ''
      if (!isTrustedSceneMessage(event, candidate, url.origin) || !isCurrentLoadMessage(event.data.sceneLoadToken, loadToken) || event.data.status !== 'voice-ready') return
      if (frame === candidate && token === loadToken && port) return
      disconnect()
      frame = candidate; token = loadToken
      const current = ++connection
      const channel = new MessageChannel()
      port = channel.port1
      port.onmessage = message => {
        if (current !== connection) return
        const value = message.data
        if (value?.type === 'connected') {
          void send('scene.ready', { token: loadToken }).then(result => {
            if (current !== connection || !isTurnKey(result.key)) return
            ready = true
            port?.postMessage({ ...result.key, type: 'reset' })
            if (result.text) port?.postMessage({ ...result.key, type: 'text', value: { text: String(result.text), cues: [] } })
          }).catch(reason => setError(String(reason)))
        } else if (value?.type === 'lost') disconnect()
        else if (isTurnKey(value) && 'type' in value && typeof value.type === 'string' && ['playing', 'buffering', 'ended', 'error'].includes(value.type)) {
          void send('voice.playback', value).catch(() => {})
        }
      }
      port.start()
      candidate.contentWindow?.postMessage({ type: 'salieri.connect', sceneLoadToken: token }, url.origin, [channel.port2])
    }
    const remove = subscribe('voice.event', payload => {
      const event = payload as unknown as VoiceEvent
      if (event.type === 'begin') setError('')
      if (event.type === 'error') setError(event.error)
      if (!ready || !port) return
      if (event.type === 'audio') {
        const pcm = new Uint8Array(event.pcm) // transfer only our own buffer
        port.postMessage({ ...event, pcm }, [pcm.buffer])
      } else port.postMessage(event)
    })
    const removeError = subscribe('tts.error', payload => setError(String(payload.error || '语音播放不可用')))
    const removeReload = subscribe('runtime.reload', payload => {
      if (payload.status === 'error') setError(String(payload.error || 'Runtime reload failed'))
      else if (payload.status === 'ready') setError('')
    })
    const observer = new MutationObserver(() => {
      if (frame && (!frame.isConnected || new URL(frame.src).searchParams.get('sceneLoadToken') !== token)) disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
    window.addEventListener('message', connect)
    const existingFrame = document.querySelector<HTMLIFrameElement>('iframe[data-testid="scene-frame"]')
    if (existingFrame?.src) {
      const url = new URL(existingFrame.src)
      existingFrame.contentWindow?.postMessage({ type: 'salieri.probe', sceneLoadToken: url.searchParams.get('sceneLoadToken') }, url.origin)
    }
    return () => { observer.disconnect(); remove(); removeError(); removeReload(); window.removeEventListener('message', connect); disconnect() }
  }, [send, subscribe])
  return error ? <div role="status" style={{ position: 'fixed', bottom: 12, left: 12, zIndex: 100, maxWidth: '80%', padding: 8, color: '#ffd8cd', background: '#221c20ed' }}>{error}</div> : null
}
