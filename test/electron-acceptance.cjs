const { app } = require('electron')
const { mkdtempSync } = require('node:fs')
const { writeFile } = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const project = path.resolve(__dirname, '..')
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'salieri-acceptance-')))
delete process.env.SALIERI_NEXT_PROJECT_ROOT
delete process.env.SALIERI_NEXT_CHARACTER_ROOT
delete process.env.FISH_API_KEY
const deadline = setTimeout(() => { console.error('Electron acceptance timed out'); app.exit(1) }, 45000)
const wait = async (probe, message, timeout = 15000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await probe()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(message)
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error('Renderer:', event.message)
  })
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const frame = await wait(() => window.webContents.mainFrame.frames.find(f => f.url.includes('wallpaper_engine.html')), 'Scene iframe missing')
      await wait(() => frame.executeJavaScript('!!window.__salieriCharacter && !!window.__sceneLastReport?.character'), 'Character did not render')
      // Production IPC -> React MessageChannel -> real scene -> AudioWorklet.
      const key = { sessionId: 'acceptance', turnId: 'audio', generation: 1000 }
      const send = params => window.webContents.send('next.event', { method: 'voice.event', params: { ...key, ...params } })
      send({ type: 'begin', speech: true, calibration: { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 } })
      send({ type: 'text', value: { text: 'Hello world', cues: [{ offset: 0, emotion: 'smile' }] } })
      const pcm = new Uint8Array(24000 * 2 * 3)
      const view = new DataView(pcm.buffer)
      for (let i = 0; i < 72000; i++) view.setInt16(i * 2, Math.sin(i / 24000 * Math.PI * 440) * 1200, true)
      send({ type: 'audio', pcm, alignment: { chunk_seq: 0, content: 'Hello world', chunk_audio_offset_sec: 0, alignment: { segments: [{ text: 'Hello', start: 0, end: 1 }, { text: 'world', start: 1, end: 3 }] } } })
      send({ type: 'input-ended' })
      try {
        await wait(() => frame.executeJavaScript('window.__salieriPlayback.status === "playing"'), 'Audio did not begin')
        const state = await frame.executeJavaScript('window.__salieriCharacter')
        assert.equal(state.emotion, 'smile')
        await writeFile('/tmp/salieri-electron-speaking.png', (await window.webContents.capturePage()).toPNG())
        await wait(() => frame.executeJavaScript('window.__salieriPlayback.status === "ended"'), 'Playback did not drain')
        await wait(() => frame.executeJavaScript('window.__salieriCharacter.label === "smile"'), 'Missing smile exit')
        send({ type: 'begin', generation: 1001, speech: true, calibration: { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 } })
        send({ type: 'audio', generation: 1001, pcm })
        await wait(() => frame.executeJavaScript('window.__salieriPlayback.generation === 1001 && window.__salieriPlayback.status === "playing"'), 'Second playback did not start')
        send({ type: 'reset', generation: 1002 })
        send({ type: 'audio', generation: 1001, pcm })
        await wait(() => frame.executeJavaScript('window.__salieriPlayback.generation === 1002'), 'Reset not delivered')
        assert.equal(await frame.executeJavaScript('window.__salieriCharacter.playback'), 'quiet')
        assert.equal(await frame.executeJavaScript('window.wallpaperApp.scene._speakingGate'), 0)
        console.log('PASS: production Electron bridge, real PCM playback, smile cue, drain, post-speech exit, stale generation')
      } catch (error) {
        console.error(await frame.executeJavaScript('({character:window.__salieriCharacter,playback:window.__salieriPlayback,diagnostic:document.getElementById("salieri-diagnostic")?.textContent})'))
        throw error
      }
      clearTimeout(deadline)
      app.exit(0)
    })().catch(async error => {
      console.error(error)
      console.error(await window.webContents.executeJavaScript('document.body.innerText'))
      await writeFile('/tmp/salieri-electron-failure.png', (await window.webContents.capturePage()).toPNG())
      clearTimeout(deadline); app.exit(1)
    })
  })
})
app.whenReady().then(() => import(pathToFileURL(path.join(project, 'dist/main/index.js')).href))
