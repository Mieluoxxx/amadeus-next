import { initialCharacterState, transition, type CharacterDefinition, type CharacterState, type CharacterEvent } from '../shared/character.ts'
import { AlignmentTimeline } from '../shared/presentation.ts'
import { isTurnKey, sameTurn, type VoiceEvent, type TurnKey, type SceneInitialization, type Calibration } from '../shared/voice.ts'

// The existing renderer owns Pixi objects; this adapter is its only state-machine writer in Next.
type Sprite = {
  setEmotion(label: string): void; setSpeaking(value: boolean): void; setMouth(value: number): void
  clearHold(): void; holdFrame(frame: number): void; holdClosedFrame(): void
  prefetchLabels(labels: string[], priority: string, options?: unknown): void
  loadFrames(label: string, frames: string[]): void; loadMouthConfig(label: string, config: unknown): void
  setIdleFrameIntervalMs(label: string, interval: number): void; setClipConfig(label: string, config: unknown): void
  setIdleAnimation(value: boolean): void
}
const host = window as any
let sprite: Sprite
let definition: CharacterDefinition
let state: CharacterState
let port: MessagePort | null = null
let key: TurnKey | null = null
let speech = false
let text = ''
let timeline = new AlignmentTimeline()
let calibration: Calibration = { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 }
let context: AudioContext | null = null
let worklet: AudioWorkletNode | null = null
let preparing: Promise<void> | null = null
let pending: { generation: number; samples: Float32Array<ArrayBuffer> }[] = []
let inputEnded = false
let trailingByte: number | null = null
let reports: any[] = []
let playbackStatus = ''
let failed = false
let lastPosition = 0

Object.defineProperty(host, '__salieriPlayback', { get: () => ({
  status: playbackStatus, audioState: context?.state, audioTime: context?.currentTime,
  outputTime: context?.getOutputTimestamp?.().contextTime, pending: pending.length,
  reports: reports.length, inputEnded, failed, workletReady: !!worklet, generation: key?.generation,
}) })

function diagnostic(message: string): void {
  let element = document.getElementById('salieri-diagnostic')
  if (!element) {
    element = document.createElement('div'); element.id = 'salieri-diagnostic'; element.setAttribute('role', 'status')
    Object.assign(element.style, { position: 'absolute', bottom: '8px', left: '8px', maxWidth: '85%', padding: '8px', background: '#221c20e8', color: '#ffd8cd', font: '12px sans-serif', zIndex: '100' })
    document.body.append(element)
  }
  element.textContent = message
}

function dispatch(event: CharacterEvent): void {
  if (!definition?.nodes[definition.root] || !sprite) return
  const result = transition(state, event, definition)
  state = result.state
  for (const effect of result.effects) {
    if (effect.type === 'play') {
      sprite.clearHold(); sprite.setEmotion(effect.label)
      const next = (definition.edges[state.node] || []).filter(edge => edge.weight > 0).map(edge => definition.nodes[edge.to].label)
      sprite.prefetchLabels(next, 'warm', { reason: 'next-state' })
    } else if (effect.type === 'hold') {
      if (effect.closed) sprite.holdClosedFrame(); else sprite.holdFrame(-1)
    } else {
      sprite.setSpeaking(effect.value)
      host.wallpaperApp?.scene?.setSpeaking(effect.value)
    }
  }
  // Small, non-sensitive live state for integration checks and diagnosis.
  host.__salieriCharacter = { ...state, label: definition.nodes[state.node]?.label }
}

host.__SALIERI_CHARACTER_FACTORY__ = (driver: Sprite) => {
  sprite = driver
  return {
    onCycleComplete(label: string) {
      if (definition && definition.nodes[state.node]?.label === label) dispatch({ type: 'cycle', node: state.node, random: Math.random() })
    },
  }
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
  worklet?.port.postMessage({ type: 'reset', generation: key?.generation ?? -1 })
  sprite?.setMouth(0)
  dispatch({ type: 'reset' })
  diagnostic(`语音播放不可用：${String(error)}`)
  playback('error', String(error))
}

async function prepareAudio(): Promise<void> {
  const resume = async () => {
    if (!context) return
    const audio = context
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
    if (context.state === 'suspended' && !document.getElementById('salieri-enable-audio')) {
      const button = document.createElement('button')
      button.id = 'salieri-enable-audio'; button.textContent = '启用声音'
      Object.assign(button.style, { position: 'absolute', bottom: '12px', right: '12px', padding: '10px', zIndex: '101' })
      button.onclick = () => { void context?.resume().catch(failAudio) }
      document.body.append(button)
      context.addEventListener('statechange', () => { if (context?.state === 'running') button.remove() })
    }
    await resumed
  }
  if (worklet) { await resume(); return }
  if (preparing) return preparing
  preparing = (async () => {
    context = new AudioContext({ sampleRate: 24000 })
    if (context.sampleRate !== 24000) throw new Error('The audio device did not accept 24 kHz playback')
    // Activate before loading the worklet: a suspended context can defer its render thread.
    await resume()
    await context.audioWorklet.addModule('/next/audio-worklet.js')
    worklet = new AudioWorkletNode(context, 'salieri-pcm')
    worklet.connect(context.destination)
    worklet.onprocessorerror = () => failAudio('Audio processor stopped')
    worklet.port.onmessage = event => {
      if (!key || event.data.generation !== key.generation || failed) return
      if (event.data.type === 'error') { failAudio(event.data.error); return }
      reports.push(event.data)
    }
    worklet.port.postMessage({ type: 'reset', generation: key?.generation ?? -1 })
    for (const item of pending.splice(0)) if (item.generation === key?.generation && !failed) worklet.port.postMessage({ type: 'pcm', generation: item.generation, buffer: item.samples.buffer }, [item.samples.buffer])
    if (inputEnded) worklet.port.postMessage({ type: 'end', generation: key?.generation })
    await resume()
  })()
  try { await preparing } finally { preparing = null }
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

function receive(event: VoiceEvent): void {
  if (!isTurnKey(event)) return
  if (event.type === 'begin' || event.type === 'reset') {
    if (key && event.generation < key.generation) return
    key = { sessionId: event.sessionId, turnId: event.turnId, generation: event.generation }
    pending = []; reports = []; timeline = new AlignmentTimeline(); trailingByte = null; inputEnded = false; playbackStatus = ''; lastPosition = 0
    text = ''; failed = false; speech = event.type === 'begin' && event.speech
    worklet?.port.postMessage({ type: 'reset', generation: key.generation })
    sprite?.setMouth(0); dispatch({ type: 'reset' })
    host.wallpaperApp.setSubtitle('')
    if (event.type === 'begin') {
      calibration = event.calibration
      for (const [label, config] of Object.entries(definition.mouths)) sprite.loadMouthConfig(label, { ...config, silenceThreshold: calibration.silenceThreshold })
      if (speech) {
        dispatch({ type: 'playback', status: 'waiting', now: performance.now() })
        void prepareAudio().catch(failAudio)
      }
    }
    return
  }
  if (!sameTurn(key, event)) return
  if (event.type === 'activity') {
    dispatch({ type: 'activity', activity: event.activity, random: Math.random() })
    host.wallpaperApp.setAsrStatus({ status: event.activity === 'listening' ? 'listening' : 'idle' })
  } else if (event.type === 'text') {
    text += event.value.text
    timeline.append(event.value.text, event.value.cues)
    host.wallpaperApp.setSubtitle(text)
    if (!speech) for (const cue of event.value.cues) dispatch({ type: 'cue', emotion: cue.emotion, random: Math.random() })
  } else if (event.type === 'audio') {
    if (event.alignment) timeline.update(event.alignment)
    pcm(new Uint8Array(event.pcm))
  } else if (event.type === 'input-ended') {
    inputEnded = true
    if (trailingByte !== null) { failAudio('Truncated PCM sample'); return }
    worklet?.port.postMessage({ type: 'end', generation: key?.generation })
  } else if (event.type === 'error') failAudio(event.error)
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
        dispatch({ type: 'playback', status: report.type, now: performance.now(), random: Math.random() })
        playback(report.type)
      } else if (report.type === 'ended') {
        dispatch({ type: 'playback', status: 'ended', now: performance.now() })
        playback('ended')
      }
      const mouth = report.type === 'playing' ? Math.min(1, report.rms * calibration.mouthGain) : 0
      sprite.setMouth(mouth)
      host.wallpaperApp.scene.setMouth(mouth)
      host.wallpaperApp.scene.setSpeaking(report.type === 'playing' || report.type === 'buffering')
    }
    if (playbackStatus === 'playing' || playbackStatus === 'buffering') {
      const emotion = timeline.take(lastPosition + calibration.syncOffsetMs / 1000)
      if (emotion) dispatch({ type: 'cue', emotion, random: Math.random() })
    }
  }
  if (state?.phase === 'holding') dispatch({ type: 'tick', now: performance.now(), random: Math.random() })
  requestAnimationFrame(tick)
}

window.addEventListener('salieri:scene-ready', () => {
  void (async () => {
    const response = await fetch('/next/init')
    if (!response.ok) throw new Error('Scene initialization unavailable')
    const init = await response.json() as SceneInitialization
    definition = init.definition
    state = initialCharacterState(definition)
    host.wallpaperApp.initDesktopScene(init.scene)
    for (const [label, clip] of Object.entries(definition.clips)) {
      sprite.loadFrames(label, clip.frames)
      sprite.setIdleFrameIntervalMs(label, clip.frameIntervalMs)
      sprite.setClipConfig(label, { loopMode: clip.loopMode, frameIntervalMs: clip.frameIntervalMs })
    }
    for (const [label, config] of Object.entries(definition.mouths)) sprite.loadMouthConfig(label, config)
    sprite.setIdleAnimation(true)
    dispatch({ type: 'reset' })
    if (definition.diagnostics.length) diagnostic(definition.diagnostics.join('；'))
    const token = new URLSearchParams(location.search).get('sceneLoadToken')
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.data?.type !== 'salieri.connect' || !token || event.data.sceneLoadToken !== token || !event.ports[0] || port) return
      port = event.ports[0]
      port.onmessage = message => receive(message.data)
      port.start()
      port.postMessage({ type: 'connected' })
    })
    window.parent.postMessage({ source: 'amadeus-scene', status: 'voice-ready', sceneLoadToken: token }, '*')
    requestAnimationFrame(tick)
  })().catch(error => diagnostic(String(error)))
}, { once: true })

window.addEventListener('pagehide', () => { port?.postMessage({ type: 'lost' }); port?.close(); void context?.close() })
