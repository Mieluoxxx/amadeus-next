const { app } = require('electron')
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = require('node:fs')
const { writeFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

const project = path.resolve(__dirname, '..')
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'amadeus-acceptance-')))
process.env.PI_CODING_AGENT_DIR = path.join(app.getPath('userData'), 'pi-agent')
mkdirSync(process.env.PI_CODING_AGENT_DIR)
process.env.PI_OFFLINE = '1'
delete process.env.AMADEUS_NEXT_PROJECT_ROOT
delete process.env.AMADEUS_NEXT_CHARACTER_ROOT
delete process.env.FISH_API_KEY
const deadline = setTimeout(() => { console.error('Electron acceptance timed out'); app.exit(1) }, 60000)
const requests = []
let releaseHeld
const modelServer = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const value = JSON.parse(body)
  requests.push(value)
  const userContent = value.messages.findLast(message => message.role === 'user')?.content
  const userText = typeof userContent === 'string' ? userContent : (userContent || []).map(part => part.text || '').join('')
  if (userText === 'hold-for-reload') await new Promise(resolve => { releaseHeld = resolve })
  const retained = value.messages.some(message => message.role === 'assistant' && message.content === 'saved-marker')
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: value.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  response.end(frame({ role: 'assistant', content: retained ? 'context-retained' : 'saved-marker' }) + frame({}, 'stop') + 'data: [DONE]\n\n')
})
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
      let frame = await wait(() => window.webContents.mainFrame.frames.find(f => f.url.includes('wallpaper_engine.html')), 'Scene iframe missing')
      await wait(() => frame.executeJavaScript('!!window.__amadeusCharacter && !!window.__sceneLastReport?.character'), 'Character did not render')
      const visibility = await frame.executeJavaScript(`(async () => {
        const { player: p, canvas: c } = window.__amadeusEmote
        const saved = { scale: p.scale, coord: p.coord, speed: p.speed, step: p.stepUpdate }
        try {
          p.speed = 0; p.stepUpdate = true
          const b = p.charaBounds
          const scale = Math.min(c.width / (b.right - b.left), c.height / (b.bottom - b.top)) * 0.94
          p.setScale(scale, 0)
          p.setCoord(-(b.left + b.right) / 2 * scale, -(b.top + b.bottom) / 2 * scale, 0)
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const read = (x, y, width, height) => c.getContext('2d').getImageData(
            Math.round(c.width / 2 + p.coord[0] + x * scale), Math.round(c.height / 2 + p.coord[1] + y * scale),
            Math.round(width * scale), Math.round(height * scale)).data
          // Model-space region containing the unwanted hanging hand in white-coat B.
          const hand = read(470, 2000, 210, 210)
          let skin = 0
          for (let i = 0; i < hand.length; i += 4) if (hand[i + 3] > 120 && hand[i] > 120 && hand[i] - hand[i + 1] > 12 && hand[i + 1] - hand[i + 2] > 5) skin++
          const head = read(-200, p.charaProfile.eye - 120, 400, 240)
          let headPixels = 0
          for (let i = 3; i < head.length; i += 4) if (head[i] > 120) headPixels++
          return { skinRatio: skin / (hand.length / 4), headRatio: headPixels / (head.length / 4),
            parts: ['fade_head_a', 'fade_body_a', 'arm_type_a', 'arm_type_b'].map(label => p.getVariable(label)) }
        } finally {
          p.setScale(saved.scale, 0); p.setCoord(saved.coord[0], saved.coord[1], 0)
          p.speed = saved.speed; p.stepUpdate = saved.step
        }
      })()`)
      assert.deepEqual(visibility.parts, [100, 100, 100, 0])
      assert.ok(visibility.headRatio > 0.2, 'Hiding the whole head/body is not a visibility fix')
      assert.ok(visibility.skinRatio < 0.025, 'Full-body white-coat B still contains a hanging hand')
      console.log('PASS: full-body white-coat B hides unused sleeves while preserving the head/body')
      const ui = script => window.webContents.executeJavaScript(script)
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      await wait(() => ui('document.querySelectorAll(".settings-section-nav button").length === 4'), 'Settings did not open')
      assert.equal(await ui('!!document.querySelector(\'[data-testid="runtime-reload"]\')'), false, 'Runtime maintenance must not be exposed in settings')
      assert.doesNotMatch(await ui('document.querySelector(".settings-page-shell").textContent'), /运行时热重载|重新加载资源|恢复 Pi 进程|恢复语音助手/)
      await ui('document.querySelectorAll(".settings-section-nav button")[3].click()')
      await wait(() => ui('!!document.querySelector(".settings-field-row input[type=password]")'), 'Fish settings missing')
      await ui(`(() => {
        const input = document.querySelector('.settings-field-row input[type=password]')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'acceptance-fixture-key')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await wait(() => ui('!!document.querySelector(".settings-field-row button:not(:disabled)")'), 'Save action missing')
      await ui('document.querySelector(".settings-field-row button:not(:disabled)").click()')
      await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result =>
        result.values.voice_configuration.find(group => group.id === 'speech_synthesis').configured)`), 'Fish key was not applied live')
      // The old UI schedules a backend restart one second after every save.
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.equal(await ui('!!document.querySelector(".settings-restart-banner")'), false, 'Saving live settings must not request a backend restart')
      assert.equal(await ui('document.querySelector(".settings-main .settings-feedback")?.textContent || ""'), '')
      assert.equal(await ui('window.amadeusNext.request("system.get_config").then(result => "FISH_API_KEY" in result.values)'), false, 'Public config must not expose the API key')
      for (const model of ['s1', 's2.1-pro-free']) {
        assert.ok(await ui(`Array.from(document.querySelector('.settings-main select').options).some(option => option.value === ${JSON.stringify(model)})`), `Fish model option missing: ${model}`)
        await ui(`document.querySelector('.settings-main select').value = ${JSON.stringify(model)}; document.querySelector('.settings-main select').dispatchEvent(new Event('change', { bubbles: true }))`)
        await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result => result.values.FISH_API_MODEL === ${JSON.stringify(model)})`), 'Fish model was not applied live')
      }
      await ui('document.querySelectorAll(".settings-section-nav button")[2].click()')
      await wait(() => ui('!!document.querySelector(".settings-field-row select")'), 'Recognition language missing')
      await ui('document.querySelector(".settings-field-row select").value = "en-US"; document.querySelector(".settings-field-row select").dispatchEvent(new Event("change", { bubbles: true }))')
      await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result =>
        result.values.voice_configuration.find(group => group.id === 'asr_local').fields[0].value === 'en-US')`), 'Recognition language snapshot did not update')
      await ui('document.querySelectorAll(".settings-section-nav button")[3].click()')
      await wait(() => ui('!!document.querySelector(".settings-field-row input[type=password]")'), 'Fish settings did not reopen')
      assert.equal(await ui('document.querySelector(".settings-main select").value'), 's2.1-pro-free', 'The free model selection must survive reopening settings')
      await ui('document.querySelector(".settings-field-row button").click()')
      await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result =>
        !result.values.voice_configuration.find(group => group.id === 'speech_synthesis').configured)`), 'Clearing the key was not applied live')
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      console.log('PASS: settings save, model/language changes and key clearing apply live without a backend restart')
      const chat = async (text, turnId) => {
        const result = await ui(`window.amadeusNext.request('chat.send', {text:${JSON.stringify(text)},turn_id:${JSON.stringify(turnId)}})`)
        assert.equal(result.ok, true)
        return wait(() => ui(`window.amadeusNext.request('session.list').then(result => result.messages.find(message => message.role === 'assistant' && message.turn_id === ${JSON.stringify(turnId)})?.text)`), 'Local Pi reply missing')
      }
      assert.equal(await chat('remember this', 'persist-first'), 'saved-marker')
      const models = await ui('window.amadeusNext.request("pi.models")')
      assert.equal(models.current, 'fixture/fixture-model')
      assert.equal((await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-alternate"})')).current, 'fixture/fixture-alternate')
      assert.equal((await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-alternate",thinkingLevel:"high"})')).thinkingLevel, 'high')
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      await wait(() => ui('document.querySelectorAll(".settings-section-nav button").length === 4'), 'Settings did not reopen')
      await ui('document.querySelectorAll(".settings-section-nav button")[1].click()')
      await wait(() => ui('document.querySelectorAll(".settings-main select").length === 2'), 'Model and thinking controls must remain available')
      assert.doesNotMatch(await ui('document.querySelector(".settings-main").textContent'), /当前模型连接|其他模型连接|高级模型角色|当前没有选中的活动连接|没有用户管理的连接设置/)
      assert.deepEqual(await ui('Array.from(document.querySelectorAll(".settings-main select"), select => select.value)'), ['fixture/fixture-alternate', 'high'])
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      const workerPids = () => app.getAppMetrics().filter(metric => metric.name === 'Amadeus Pi Runtime').map(metric => metric.pid)
      const before = workerPids()
      assert.equal(before.length, 1)
      const modelsFile = path.join(process.env.PI_CODING_AGENT_DIR, 'models.json')
      const savedModels = readFileSync(modelsFile, 'utf8')
      writeFileSync(modelsFile, '{')
      await ui('window.amadeusNext.request("runtime.reload", {targets:["pi-worker"]})')
      await wait(() => ui('window.amadeusNext.request("runtime.status").then(result => result.status === "error")'), 'Invalid replacement configuration was not rejected')
      assert.ok(workerPids().includes(before[0]), 'Failed initialization must leave the old Pi alive')
      writeFileSync(modelsFile, savedModels)
      assert.equal((await ui('window.amadeusNext.request("pi.models")')).current, 'fixture/fixture-alternate')
      assert.equal((await ui('window.amadeusNext.request("runtime.reload", {targets:["pi-worker"]})')).ok, true)
      await wait(() => ui('window.amadeusNext.request("runtime.status").then(result => result.status === "ready" || (result.status === "error" && Promise.reject(new Error(result.error))))'), 'Pi did not recover')
      await wait(() => !workerPids().includes(before[0]), 'Old Pi process was not retired')
      const restoredModel = await ui('window.amadeusNext.request("pi.models")')
      assert.equal(restoredModel.current, 'fixture/fixture-alternate')
      assert.equal(restoredModel.thinkingLevel, 'high')
      assert.equal(await chat('what did you remember?', 'persist-second'), 'context-retained')
      assert.equal(requests.length, 2, 'Restart must not replay requests')
      const pid = process.pid
      const oldUrl = frame.url
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      await wait(() => ui('!!document.querySelector(".settings-page-shell")'), 'Settings did not reopen')
      assert.equal((await ui('window.amadeusNext.request("runtime.reload", {targets:["pi","scene"]})')).ok, true)
      await wait(() => ui('window.amadeusNext.request("runtime.status").then(result => result.status === "ready" || (result.status === "error" && Promise.reject(new Error(result.error))))'), 'Resource reload failed')
      frame = await wait(() => window.webContents.mainFrame.frames.find(f => f.url.includes('wallpaper_engine.html') && f.url !== oldUrl), 'Scene generation was not replaced')
      await wait(() => frame.executeJavaScript('!!window.__amadeusCharacter'), 'Character missing after reload')
      assert.equal(process.pid, pid, 'Resource reload must not restart the main process')
      assert.equal(await chat('still there?', 'persist-third'), 'context-retained')
      assert.equal(requests.length, 3)
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      console.log('PASS: real Pi session survives worker replacement and resource reload; no request replay; fresh scene handshake')
      const heldReply = chat('hold-for-reload', 'held-reply')
      await wait(() => releaseHeld, 'Fixture request was not held')
      const queued = await ui('window.amadeusNext.request("runtime.reload", {targets:["pi"]})')
      assert.equal(queued.status, 'queued')
      assert.equal((await ui('window.amadeusNext.request("chat.send", {text:"must not run"})')).ok, false)
      releaseHeld()
      assert.equal(await heldReply, 'context-retained')
      await wait(() => ui('window.amadeusNext.request("runtime.status").then(result => result.status === "ready" || (result.status === "error" && Promise.reject(new Error(result.error))))'), 'Queued Pi reload failed')
      assert.equal(requests.length, 4)
      console.log('PASS: a real in-flight Pi reply drains before reload; new requests are rejected rather than replayed')
      await frame.executeJavaScript(`(() => {
        const NativeNode = window.AudioWorkletNode
        window.AudioWorkletNode = class extends NativeNode {
          constructor(...args) { super(...args); window.__acceptanceWorklet = this }
        }
      })()`)
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
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.status === "playing"'), 'Audio did not begin')
        await wait(() => frame.executeJavaScript('window.__amadeusEmote.player.getVariable("face_talk") > 0'), 'Audible PCM did not open the native mouth')
        const state = await frame.executeJavaScript('window.__amadeusCharacter')
        assert.equal(state.emotion, 'smile')
        send({ type: 'calibration', calibration: { mouthGain: 12, silenceThreshold: 0.1, syncOffsetMs: 150 } })
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.calibration.mouthGain === 12'), 'Calibration did not update during playback')
        assert.equal(await frame.executeJavaScript('window.__amadeusPlayback.generation'), 1000)
        await writeFile('/tmp/amadeus-electron-speaking.png', (await window.webContents.capturePage()).toPNG())
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.status === "ended"'), 'Playback did not drain')
        assert.equal(await frame.executeJavaScript('window.__amadeusEmote.player.getVariable("face_talk")'), 0, 'Drained audio must close the native mouth')
        await wait(() => frame.executeJavaScript('window.__amadeusCharacter.label === "表情_普通"'), 'Missing return to the native idle expression')
        send({ type: 'begin', generation: 1001, speech: true, calibration: { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 } })
        send({ type: 'audio', generation: 1001, pcm })
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.generation === 1001 && window.__amadeusPlayback.status === "playing"'), 'Second playback did not start')
        send({ type: 'reset', generation: 1002 })
        send({ type: 'audio', generation: 1001, pcm })
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.generation === 1002'), 'Reset not delivered')
        assert.equal(await frame.executeJavaScript('window.__amadeusCharacter.playback'), 'quiet')
        assert.equal(await frame.executeJavaScript('window.wallpaperApp.scene._speakingGate'), 0)
        console.log('PASS: production Electron bridge, real PCM playback, smile cue, drain, post-speech exit, stale generation')
        send({ type: 'error', generation: 1002, error: 'Fish handshake failed [payment_required, HTTP 402]: Check API billing.',
          diagnostic: { provider: 'fish', phase: 'handshake', code: 'payment_required', httpStatus: 402 } })
        await wait(() => ui('document.body.textContent.includes("payment_required, HTTP 402")'), 'Detailed Fish failure was not shown')
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.status === "error"'), 'Fish failure did not stop speech')
        assert.equal(await frame.executeJavaScript('window.__amadeusPlayback.workletReady'), true, 'A remote Fish error must not be misclassified as a local audio processor failure')
        await frame.executeJavaScript('window.__acceptanceWorklet.onprocessorerror()')
        assert.equal(await frame.executeJavaScript('window.__amadeusPlayback.workletReady'), false, 'A failed processor must be discarded')
        send({ type: 'begin', generation: 1003, speech: true, calibration: { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 } })
        send({ type: 'audio', generation: 1003, pcm })
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.generation === 1003 && window.__amadeusPlayback.status === "playing"'), 'Audio did not recover locally')
        assert.equal(await frame.executeJavaScript('!!document.getElementById("amadeus-diagnostic")'), false)
        send({ type: 'reset', generation: 1004 })
        console.log('PASS: failed AudioWorklet recovers on the next turn without reloading the scene or Pi')
        const piBeforePreload = workerPids()
        process.env.AMADEUS_NEXT_DEV = '1'
        const loaded = once(window.webContents, 'did-finish-load')
        await ui('window.amadeusNext.request("dev.reload", {targets:["preload"]})')
        await loaded
        await wait(() => ui('window.amadeusNext.request("runtime.status").then(result => result.status === "ready")'), 'Preload/window reload did not rebind the scene')
        assert.deepEqual(workerPids(), piBeforePreload)
        assert.equal((await ui('window.amadeusNext.request("session.list")')).messages.at(-1).text, 'context-retained')
        assert.equal((await ui('window.amadeusNext.request("pi.models")')).current, 'fixture/fixture-alternate')
        console.log('PASS: preload/window replacement keeps the Pi process, selected model and conversation')
      } catch (error) {
        console.error(await frame.executeJavaScript('({character:window.__amadeusCharacter,playback:window.__amadeusPlayback,diagnostic:document.getElementById("amadeus-diagnostic")?.textContent})'))
        throw error
      }
      clearTimeout(deadline)
      app.exit(0)
    })().catch(async error => {
      console.error(error)
      console.error(await window.webContents.executeJavaScript('document.body.innerText'))
      await writeFile('/tmp/amadeus-electron-failure.png', (await window.webContents.capturePage()).toPNG())
      clearTimeout(deadline); app.exit(1)
    })
  })
})
app.whenReady().then(async () => {
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, models: [{ id: 'fixture-model' }, { id: 'fixture-alternate', reasoning: true }],
  } } }))
  writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture-model', retry: { enabled: false } }))
  await import(pathToFileURL(path.join(project, 'dist/main/index.js')).href)
})
