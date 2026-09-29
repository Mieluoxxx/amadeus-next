import type { CharacterEvent } from '../shared/character.ts'
import { createEmoteRenderer, type EmoteCharacter } from './emote.ts'
import { AlignmentTimeline } from '../shared/presentation.ts'
import { isTurnKey, sameTurn, type VoiceEvent, type ConversationIdleEvent, type TurnKey, type SceneInitialization, type Calibration } from '../shared/voice.ts'

const host = window as any
const loadCharacter = createEmoteRenderer()
let sprite: EmoteCharacter | null = null
let port: MessagePort | null = null
let key: TurnKey | null = null
let speech = false
let display = ''
let shownSubtitle = ''
let hasSubtitles = false
let timeline = new AlignmentTimeline()
let calibration: Calibration = { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 }
let context: AudioContext | null = null
let worklet: AudioWorkletNode | null = null
let preparing: Promise<void> | null = null
let audioEpoch = 0
let pending: { generation: number; samples: Float32Array<ArrayBuffer> }[] = []
let inputEnded = false
let trailingByte: number | null = null
let reports: any[] = []
let playbackStatus = ''
let failed = false
let lastPosition = 0
let idleUrls: string[] = []
let conversationIdle = false

/** 空闲演出只由主进程的 conversation-idle 驱动；回合是否进行中由主进程统一判定。 */
function applyIdle(): void {
  host.wallpaperApp?.scene?.setIdleLoop(conversationIdle ? idleUrls : null)
  // 有静帧时前景与静帧交叉淡入淡出；没有静帧就直接隐藏，和以前一样。
  host.renderApp?.setForegroundVisible(!conversationIdle, idleUrls.length > 0)
}

Object.defineProperty(host, '__amadeusPlayback', { get: () => ({
  status: playbackStatus, audioState: context?.state, audioTime: context?.currentTime,
  outputTime: context?.getOutputTimestamp?.().contextTime, pending: pending.length,
  reports: reports.length, inputEnded, failed, workletReady: !!worklet, generation: key?.generation,
  calibration: { ...calibration },
}) })

function diagnostic(message: string): void {
  let element = document.getElementById('amadeus-diagnostic')
  if (!message) { element?.remove(); return }
  if (!element) {
    element = document.createElement('div'); element.id = 'amadeus-diagnostic'; element.setAttribute('role', 'status')
    Object.assign(element.style, { position: 'absolute', bottom: '8px', left: '8px', maxWidth: '85%', padding: '8px', background: '#221c20e8', color: '#ffd8cd', font: '12px sans-serif', zIndex: '100' })
    document.body.append(element)
  }
  element.textContent = message
}

function dispatch(event: CharacterEvent): void {
  if (!sprite) return
  sprite.dispatch(event)
  host.wallpaperApp?.scene?.setSpeaking(['playing', 'buffering'].includes(sprite.state.playback))
  // Small, non-sensitive live state for integration checks and diagnosis.
  host.__amadeusCharacter = { ...sprite.state }
}

function playback(type: string, error?: string): void {
  if (!key || !['playing', 'buffering', 'ended', 'error'].includes(type)) return
  if (type === playbackStatus && !error) return
  playbackStatus = type
  port?.postMessage({ ...key, type, ...(error ? { error } : {}) })
}

function failAudio(error: unknown): void {
  if (failed) return
  failed = true; speech = false
  pending = []; reports = []; trailingByte = null
  audioEpoch++
  const previousContext = context
  if (worklet) {
    worklet.onprocessorerror = null
    worklet.port.onmessage = null
    worklet.port.close()
    worklet.disconnect()
  }
  worklet = null; context = null; preparing = null
  if (previousContext && previousContext.state !== 'closed') void previousContext.close().catch(() => {})
  document.getElementById('amadeus-enable-audio')?.remove()
  sprite?.setMouth(0)
  dispatch({ type: 'reset' })
  diagnostic(`语音播放不可用：${String(error)}`)
  playback('error', String(error))
  applyIdle()
}

async function prepareAudio(): Promise<void> {
  const resume = async (audio: AudioContext) => {
    const resumed = new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (audio.state === 'running' || audio.state === 'closed') {
          audio.removeEventListener('statechange', changed)
          if (audio.state === 'running') resolve(); else reject(new Error('Audio context closed'))
        }
      }
      audio.addEventListener('statechange', changed)
      void audio.resume().then(changed, error => { audio.removeEventListener('statechange', changed); reject(error) })
      changed()
    })
    if (audio.state === 'suspended' && !document.getElementById('amadeus-enable-audio')) {
      const button = document.createElement('button')
      button.id = 'amadeus-enable-audio'; button.textContent = '启用声音'
      Object.assign(button.style, { position: 'absolute', bottom: '12px', right: '12px', padding: '10px', zIndex: '101' })
      button.onclick = () => { void audio.resume().catch(error => { if (context === audio) failAudio(error) }) }
      document.body.append(button)
      audio.addEventListener('statechange', () => { if (audio.state === 'running' || audio.state === 'closed') button.remove() })
    }
    await resumed
  }
  if (worklet && context) { await resume(context); return }
  if (preparing) return preparing
  const epoch = audioEpoch
  const audio = new AudioContext({ sampleRate: 24000 })
  context = audio
  const preparation = (async () => {
    if (audio.sampleRate !== 24000) throw new Error('The audio device did not accept 24 kHz playback')
    // Activate before loading the worklet: a suspended context can defer its render thread.
    await resume(audio)
    if (epoch !== audioEpoch) return
    await audio.audioWorklet.addModule('/next/audio-worklet.js')
    if (epoch !== audioEpoch) return
    worklet = new AudioWorkletNode(audio, 'amadeus-pcm')
    worklet.connect(audio.destination)
    worklet.onprocessorerror = () => { if (epoch === audioEpoch) failAudio('Audio processor stopped') }
    worklet.port.onmessage = event => {
      if (epoch !== audioEpoch || !key || event.data.generation !== key.generation || failed || !speech) return
      if (event.data.type === 'error') { failAudio(event.data.error); return }
      reports.push(event.data)
    }
    worklet.port.postMessage({ type: 'reset', generation: key?.generation ?? -1 })
    for (const item of pending.splice(0)) if (item.generation === key?.generation && !failed) worklet.port.postMessage({ type: 'pcm', generation: item.generation, buffer: item.samples.buffer }, [item.samples.buffer])
    if (inputEnded) worklet.port.postMessage({ type: 'end', generation: key?.generation })
    await resume(audio)
    const notice = document.getElementById('amadeus-diagnostic')
    if (epoch === audioEpoch && notice?.textContent?.startsWith('语音播放不可用：')) notice.remove()
  })()
  preparing = preparation
  try { await preparation } finally { if (preparing === preparation) preparing = null }
}

function pcm(bytes: Uint8Array): void {
  if (!key || !speech || failed) return
  const samples = new Float32Array(Math.floor((bytes.length + (trailingByte === null ? 0 : 1)) / 2))
  let source = 0, target = 0
  const sample = (lo: number, hi: number) => { const value = lo | hi << 8; return (value >= 32768 ? value - 65536 : value) / 32768 }
  if (trailingByte !== null && bytes.length) { samples[target++] = sample(trailingByte, bytes[source++]); trailingByte = null }
  while (source + 1 < bytes.length) { samples[target++] = sample(bytes[source], bytes[source + 1]); source += 2 }
  if (source < bytes.length) trailingByte = bytes[source]
  if (!samples.length) return
  if (worklet) worklet.port.postMessage({ type: 'pcm', generation: key.generation, buffer: samples.buffer }, [samples.buffer])
  else pending.push({ generation: key.generation, samples })
}

function receive(event: VoiceEvent | ConversationIdleEvent): void {
  if (event.type === 'conversation-idle') {
    conversationIdle = event.active
    applyIdle()
    return
  }
  if (!isTurnKey(event)) return
  if (event.type === 'calibration') {
    if (!sameTurn(key, event)) return
    calibration = event.calibration
    return
  }
  if (event.type === 'begin' || event.type === 'reset') {
    if (key && event.generation < key.generation) return
    key = { sessionId: event.sessionId, turnId: event.turnId, generation: event.generation }
    pending = []; reports = []; timeline = new AlignmentTimeline(); trailingByte = null; inputEnded = false; playbackStatus = ''; lastPosition = 0
    display = ''; shownSubtitle = ''; hasSubtitles = false; failed = false; speech = event.type === 'begin' && event.speech
    worklet?.port.postMessage({ type: 'reset', generation: key.generation })
    sprite?.setMouth(0); dispatch({ type: 'reset' })
    applyIdle()
    host.wallpaperApp.setSubtitle('')
    if (event.type === 'begin') {
      calibration = event.calibration
      if (speech) {
        dispatch({ type: 'playback', status: 'waiting', now: performance.now() })
        const epoch = audioEpoch
        void prepareAudio().catch(error => { if (epoch === audioEpoch && sameTurn(key, event)) failAudio(error) })
      }
    }
    return
  }
  if (!sameTurn(key, event)) return
  if (event.type === 'activity') {
    dispatch({ type: 'activity', activity: event.activity, random: Math.random() })
  } else if (event.type === 'text') {
    const { subtitles = [] } = event.value
    display += event.value.display ?? event.value.text
    timeline.append(event.value.text, event.value.cues, subtitles)
    if (subtitles.length) hasSubtitles = true
    // Timed subtitles follow the audio; everything else (silent, plain, or after a speech failure) shows the reply.
    if (!hasSubtitles || !speech) host.wallpaperApp.setSubtitle(display)
    if (!speech) for (const cue of event.value.cues) dispatch({ type: 'cue', emotion: cue.emotion, random: Math.random() })
  } else if (event.type === 'audio') {
    if (event.alignment) timeline.update(event.alignment)
    pcm(new Uint8Array(event.pcm))
  } else if (event.type === 'input-ended') {
    inputEnded = true
    if (trailingByte !== null) { failAudio('Truncated PCM sample'); return }
    worklet?.port.postMessage({ type: 'end', generation: key?.generation })
  } else if (event.type === 'error') {
    if (event.diagnostic?.provider !== 'fish') { failAudio(event.error); return }
    // A producer failure is already reported by the main process. Stop speech without
    // destroying a healthy audio processor or echoing it back as a playback failure.
    speech = false; inputEnded = true; pending = []; reports = []; trailingByte = null
    host.wallpaperApp.setSubtitle(display)
    worklet?.port.postMessage({ type: 'reset', generation: key?.generation ?? -1 })
    sprite?.setMouth(0)
    dispatch({ type: 'reset' })
    playbackStatus = 'error'
    applyIdle()
  }
}

function syncSubtitle(): void {
  if (!hasSubtitles || !speech) return
  const line = timeline.subtitleAt(lastPosition + calibration.syncOffsetMs / 1000)
  if (line && line !== shownSubtitle) { shownSubtitle = line; host.wallpaperApp.setSubtitle(line) }
}

function tick(): void {
  if (context) {
    const outputTime = context.getOutputTimestamp?.().contextTime || context.currentTime
    while (reports.length && reports[0].contextTime <= outputTime) {
      const report = reports.shift()
      if (report.generation !== key?.generation || failed || playbackStatus === 'ended') continue
      lastPosition = report.seconds
      if (report.type === 'playing' || report.type === 'buffering') {
        const emotion = timeline.take(lastPosition + calibration.syncOffsetMs / 1000)
        if (emotion) dispatch({ type: 'cue', emotion, random: Math.random() })
        syncSubtitle()
        dispatch({ type: 'playback', status: report.type, now: performance.now(), random: Math.random() })
        playback(report.type)
      } else if (report.type === 'ended') {
        dispatch({ type: 'playback', status: 'ended', now: performance.now() })
        playback('ended')
        applyIdle()
      }
      const amplitude = Math.min(1, report.rms * calibration.mouthGain)
      const mouth = report.type === 'playing' && amplitude >= calibration.silenceThreshold ? amplitude : 0
      sprite?.setMouth(mouth)
      host.wallpaperApp.scene.setMouth(mouth)
      host.wallpaperApp.scene.setSpeaking(report.type === 'playing' || report.type === 'buffering')
    }
    if (playbackStatus === 'playing' || playbackStatus === 'buffering') {
      const emotion = timeline.take(lastPosition + calibration.syncOffsetMs / 1000)
      if (emotion) dispatch({ type: 'cue', emotion, random: Math.random() })
      syncSubtitle()
    }
  }
  dispatch({ type: 'tick', now: performance.now(), random: Math.random() })
  requestAnimationFrame(tick)
}

window.addEventListener('amadeus:scene-ready', () => {
  void (async () => {
    const response = await fetch('/next/init')
    if (!response.ok) throw new Error('Scene initialization unavailable')
    const init = await response.json() as SceneInitialization
    host.wallpaperApp.initDesktopScene(init.scene)
    idleUrls = Array.isArray(init.scene.idleUrls) ? (init.scene.idleUrls as unknown[]).map(item => String(item)) : []
    if (init.character?.renderer !== 'emote' || init.character.model !== 'kurisu_ab_white') throw new Error('不支持的 E-mote 模型')
    sprite = await loadCharacter(init.character.model, diagnostic, init.character)
    dispatch({ type: 'reset' })
    const token = new URLSearchParams(location.search).get('sceneLoadToken')
    window.addEventListener('message', event => {
      if (event.source !== window.parent || !token || event.data?.sceneLoadToken !== token) return
      if (event.data.type === 'amadeus.probe') {
        window.parent.postMessage({ source: 'amadeus-scene', status: 'voice-ready', sceneLoadToken: token }, '*')
        return
      }
      if (event.data.type !== 'amadeus.connect' || !event.ports[0]) return
      port?.close()
      port = event.ports[0]
      port.onmessage = message => receive(message.data)
      port.start()
      port.postMessage({ type: 'connected' })
    })
    window.parent.postMessage({ source: 'amadeus-scene', status: 'voice-ready', sceneLoadToken: token }, '*')
    requestAnimationFrame(tick)
  })().catch(error => window.dispatchEvent(new CustomEvent('amadeus:scene-failed', { detail: String(error) })))
}, { once: true })

window.addEventListener('amadeus:scene-failed', event => {
  diagnostic((event as CustomEvent).detail)
  if (key) failAudio((event as CustomEvent).detail)
  port?.postMessage({ type: 'lost' }); port?.close(); port = null
})

window.addEventListener('pagehide', () => { audioEpoch++; port?.postMessage({ type: 'lost' }); port?.close(); void context?.close() })
