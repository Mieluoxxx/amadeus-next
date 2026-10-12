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
process.env.AMADEUS_HOME = path.join(app.getPath('userData'), 'home')
// 模型定义和凭据来自共享目录；应用自己的 Pi 目录在 AMADEUS_HOME/pi。
process.env.AMADEUS_PI_CREDENTIALS_DIR = path.join(app.getPath('userData'), 'pi-agent')
mkdirSync(process.env.AMADEUS_PI_CREDENTIALS_DIR)
process.env.PI_OFFLINE = '1'
delete process.env.AMADEUS_NEXT_PROJECT_ROOT
delete process.env.AMADEUS_NEXT_CHARACTER_ROOT
delete process.env.FISH_API_KEY
const deadline = setTimeout(() => { console.error('Electron acceptance timed out'); app.exit(1) }, 120000)
const requests = []
let releaseHeld
// 记忆抽取等后台任务也会请求模型；验收只数主对话的请求（带 handoff 工具的那些）。
const mainRequests = () => requests.filter(value => value.tools?.some(tool => tool.function?.name === 'handoff'))
const modelServer = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const value = JSON.parse(body)
  requests.push(value)
  const userContent = value.messages.findLast(message => message.role === 'user')?.content
  const userText = typeof userContent === 'string' ? userContent : (userContent || []).map(part => part.text || '').join('')
  if (userText.includes('hold-for-reload')) await new Promise(resolve => { releaseHeld = resolve })
  const retained = value.messages.some(message => message.role === 'assistant' && message.content === 'saved-marker')
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: value.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const isSubagent = value.tools?.some(tool => tool.function?.name === 'web_fetch')
  // 子代理先查一次再给结论，工作面板才有真实的工具步骤可看。
  if (isSubagent && !value.messages.some(message => message.role === 'tool')) {
    const call = { index: 0, id: 'call_fetch', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'fixture findings' }) } }
    return response.end(frame({ role: 'assistant', content: '' }) + frame({ tool_calls: [call] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n')
  }
  if (isSubagent) return response.end(frame({ role: 'assistant', content: 'subagent-findings' }) + frame({}, 'stop') + 'data: [DONE]\n\n')
  if (userText.includes('delegate-research') && !value.messages.some(message => message.role === 'tool')) {
    const call = { index: 0, id: 'call_handoff', type: 'function', function: { name: 'handoff', arguments: JSON.stringify({ kind: 'research', title: '查资料', brief: 'Find the fixture findings and report them back plainly.' }) } }
    return response.end(frame({ role: 'assistant', content: '好，我去查。' }) + frame({ tool_calls: [call] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n')
  }
  const text = userText.includes('amadeus_handoff_result') ? 'report-spoken' : retained ? 'context-retained' : 'saved-marker'
  response.end(frame({ role: 'assistant', content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n')
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
      let frame = await wait(() => window.webContents.mainFrame.frames.find(f => f.url.includes('index.html') || f.url.includes('wallpaper_engine.html')), 'Scene iframe missing')
      // 渲染进程收到的 next.event 都记下来，回合结果与汇报卡片靠它断言。
      const hookEvents = () => window.webContents.executeJavaScript('window.__acceptanceEvents = window.__acceptanceEvents || []; if (!window.__acceptanceHooked) { window.__acceptanceHooked = true; window.amadeusNext.onEvent(event => window.__acceptanceEvents.push(event)) } true')
      await hookEvents()
      await wait(() => frame.executeJavaScript('!!window.__amadeusCharacter && !!window.__sceneLastReport?.character'), 'Character did not render')
      const idle = active => window.webContents.send('next.event', { method: 'voice.event', params: { type: 'conversation-idle', active } })
      idle(true)
      await wait(() => frame.executeJavaScript('window.wallpaperApp.scene.idleLayer?.visible && window.wallpaperApp.scene.idleA.texture.baseTexture.valid && !window.wallpaperApp.scene._idleFade && window.wallpaperApp.scene.idleOpaque()'), 'Idle frame did not render')
      const inspectIdle = () => frame.executeJavaScript(`(() => {
        const scene = window.wallpaperApp.scene, app = scene.app
        const original = [app.screen.width, app.screen.height]
        const results = []
        try {
          for (const [width, height] of [original, [900, 700]]) {
            app.renderer.resize(width, height)
            const target = PIXI.RenderTexture.create({ width, height, resolution: 1 })
            const pixels = visible => {
              scene.idleLayer.visible = visible
              app.renderer.render(app.stage, { renderTexture: target })
              return app.renderer.extract.pixels(target)
            }
            const before = pixels(false), after = pixels(true), b = scene._crtBounds
            let outside = 0, inside = 0
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 4
              if (!before.subarray(i, i + 4).some((value, offset) => value !== after[i + offset])) continue
              // Allow the antialiased edge, but not changes to the TV bezel or room.
              if (x < b.x - 2 || x > b.right + 2 || y < b.y - 2 || y > b.bottom + 2) outside++
              else inside++
            }
            // Matched ceiling, floor and clock-side landmarks: idle pixels -> original wallpaper pixels.
            const landmarks = [[323.53, 253.86, 661, 259.89], [483.15, 807.89, 738.82, 529.60], [1197.67, 352.08, 1086.43, 307.83]]
            const sprite = scene.idleA
            const alignmentError = Math.max(...landmarks.map(([x, y, bx, by]) => Math.hypot(
              (sprite.x + x * sprite.scale.x) * 1672 / width - bx,
              (sprite.y + y * sprite.scale.y) * 941 / height - by)))
            const scaleError = Math.abs(sprite.scale.x * 1672 / width - sprite.scale.y * 941 / height)
            results.push({ outside, inside, alignmentError, scaleError, masked: scene.idleLayer.mask === scene.mask })
            target.destroy(true)
          }
          return { results, foreground: window.renderApp._sprite.sprite.visible }
        } finally { app.renderer.resize(...original) }
      })()`)
      const idleCount = await frame.executeJavaScript('window.wallpaperApp.scene._idleUrls.length')
      for (let index = 0; index < idleCount; index++) {
        if (index) {
          await frame.executeJavaScript('window.wallpaperApp.scene._idleAdvance()')
          const transition = await wait(() => frame.executeJavaScript(`(() => {
            const scene = window.wallpaperApp.scene, fade = scene._idleFade
            if (!fade || fade.t < 0.25 || fade.t > 0.75) return null
            return { foreground: window.renderApp._sprite.sprite.visible, covered: scene.idleOpaque(),
              outgoingAlpha: fade.outgoing.alpha, incomingOnTop: scene.idleLayer.children.at(-1) === fade.incoming }
          })()`), 'Idle transition midpoint was not observed')
          assert.deepEqual(transition, { foreground: false, covered: true, outgoingAlpha: 1, incomingOnTop: true },
            'Idle-to-idle transitions must not expose E-mote or the underlying room')
          await wait(() => frame.executeJavaScript('(() => { const s = window.wallpaperApp.scene; return s.idleA.texture === PIXI.Texture.from(s._idleUrls[' + index + ']) && !s._idleFade && s.idleA.texture.baseTexture.valid })()'), 'Next idle frame did not render')
        }
        const idlePixels = await inspectIdle()
        for (const result of idlePixels.results) {
          assert.equal(result.outside, 0, 'Idle stills must not replace any pixels outside the TV screen, including after resize')
          assert.ok(result.inside > 1000, 'Idle stills must actually change the TV content')
          assert.equal(result.masked, true, 'Idle stills must follow the existing CRT polygon')
          assert.ok(result.alignmentError < 1, 'Idle background landmarks moved by ' + result.alignmentError.toFixed(2) + ' wallpaper pixels')
          assert.ok(result.scaleError < 1e-9, 'Idle artwork must scale uniformly in wallpaper coordinates')
        }
        assert.equal(idlePixels.foreground, false, 'Idle stills replace only the E-mote foreground')
      }
      await writeFile('/tmp/amadeus-electron-idle.png', (await window.webContents.capturePage()).toPNG())
      const state = 'JSON.stringify((() => { const s = window.wallpaperApp.scene; return { layer: s.idleLayer.visible, alpha: s.idleLayer.alpha, foreground: window.renderApp._sprite.sprite.visible } })())'
      const observe = async predicate => predicate(JSON.parse(await frame.executeJavaScript(state)))
      idle(false)
      // Leaving idle crossfades: the character is already there beneath the stills as they fade out.
      await wait(() => observe(s => s.layer && s.alpha > 0 && s.alpha < 1 && s.foreground), 'Leaving idle must fade out, not cut')
      await wait(() => frame.executeJavaScript('!window.wallpaperApp.scene.idleLayer.visible && window.renderApp._sprite.sprite.visible'), 'Leaving idle did not restore E-mote')
      idle(true)
      // Entering idle crossfades too: the character stays until the stills fully cover it.
      await wait(() => observe(s => s.layer && s.alpha > 0 && s.alpha < 1 && s.foreground), 'Entering idle must fade in over the character, not cut')
      await wait(() => frame.executeJavaScript('window.wallpaperApp.scene.idleOpaque() && !window.renderApp._sprite.sprite.visible'), 'The character must hide once the stills cover it')
      idle(false)
      await wait(() => frame.executeJavaScript('!window.wallpaperApp.scene.idleLayer.visible && window.renderApp._sprite.sprite.visible'), 'Leaving idle again did not restore E-mote')
      console.log('PASS: every idle frame aligns with the original background at both viewport sizes; exterior unchanged; leaving and entering idle crossfade with E-mote')
      const visibility = await frame.executeJavaScript(`(async () => {
        const { player: p, canvas: c } = window.__amadeusEmote
        const saved = { scale: p.scale, coord: p.coord, speed: p.speed, step: p.stepUpdate }
        try {
          p.speed = 0; p.stepUpdate = true
          const b = p.charaBounds
          const scale = Math.min(c.width / (b.right - b.left), c.height / (b.bottom - b.top)) * 0.94
          p.setScale(scale, 0)
          p.setCoord(-(b.left + b.right) / 2 * scale, -(b.top + b.bottom) / 2 * scale, 0)
          // E-mote 由场景节拍驱动且待机限帧，固定等两个 rAF 未必赶上重绘；等它实际画完两帧再读像素。
          const drawn = async () => {
            const device = window.EmotePlayer.device, start = device.lastAnimationTime
            while (device.lastAnimationTime === start) await new Promise(resolve => requestAnimationFrame(resolve))
          }
          await drawn(); await drawn()
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
      await wait(() => ui('document.querySelectorAll(".settings-main section[data-section]").length === 4'), 'Settings did not open')
      assert.equal(await ui('!!document.querySelector(\'[data-testid="runtime-reload"]\')'), false, 'Runtime maintenance must not be exposed in settings')
      assert.doesNotMatch(await ui('document.querySelector(".settings-page-shell").textContent'), /运行时热重载|重新加载资源|恢复 Pi 进程|恢复语音助手/)
      await wait(() => ui('!!document.querySelector("[data-subsection=tts] .settings-field-row input[type=password]")'), 'Fish settings missing')
      await ui(`(() => {
        const input = document.querySelector('[data-subsection=tts] .settings-field-row input[type=password]')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'acceptance-fixture-key')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await wait(() => ui('!!document.querySelector("[data-subsection=tts] .settings-field-row button:not(:disabled)")'), 'Save action missing')
      await ui('document.querySelector("[data-subsection=tts] .settings-field-row button:not(:disabled)").click()')
      await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result =>
        result.values.voice_configuration.find(group => group.id === 'speech_synthesis').configured)`), 'Fish key was not applied live')
      // The old UI schedules a backend restart one second after every save.
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.equal(await ui('!!document.querySelector(".settings-restart-banner")'), false, 'Saving live settings must not request a backend restart')
      assert.equal(await ui('document.querySelector(".settings-main .settings-feedback")?.textContent || ""'), '')
      assert.equal(await ui('window.amadeusNext.request("system.get_config").then(result => "FISH_API_KEY" in result.values)'), false, 'Public config must not expose the API key')
      for (const model of ['s1', 's2.1-pro-free']) {
        assert.ok(await ui(`Array.from(document.querySelector('[data-subsection=tts] select').options).some(option => option.value === ${JSON.stringify(model)})`), `Fish model option missing: ${model}`)
        await ui(`document.querySelector('[data-subsection=tts] select').value = ${JSON.stringify(model)}; document.querySelector('[data-subsection=tts] select').dispatchEvent(new Event('change', { bubbles: true }))`)
        await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result => result.values.FISH_API_MODEL === ${JSON.stringify(model)})`), 'Fish model was not applied live')
      }
      await wait(() => ui('!!document.querySelector("[data-subsection=asr] .settings-field-row select")'), 'Recognition language missing')
      await ui('const el = document.querySelector("[data-subsection=asr] .settings-field-row select"); el.value = "en-US"; el.dispatchEvent(new Event("change", { bubbles: true }))')
      await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result =>
        result.values.voice_configuration.find(group => group.id === 'asr_local').fields[0].value === 'en-US')`), 'Recognition language snapshot did not update')
      await wait(() => ui('!!document.querySelector("[data-subsection=tts] .settings-field-row input[type=password]")'), 'Fish settings did not reopen')
      assert.equal(await ui('document.querySelector("[data-subsection=tts] select").value'), 's2.1-pro-free', 'The free model selection must survive reopening settings')
      await ui('document.querySelector("[data-subsection=tts] .settings-field-row button").click()')
      await wait(() => ui(`window.amadeusNext.request('system.get_config').then(result =>
        !result.values.voice_configuration.find(group => group.id === 'speech_synthesis').configured)`), 'Clearing the key was not applied live')
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      console.log('PASS: settings save, model/language changes and key clearing apply live without a backend restart')
      const events = (method, predicate = '() => true') => ui(`(window.__acceptanceEvents || []).filter(event => event.method === ${JSON.stringify(method)} && (${predicate})(event.params)).map(event => event.params)`)
      const chat = async (text, turnId) => {
        const result = await ui(`window.amadeusNext.request('chat.send', {text:${JSON.stringify(text)},turn_id:${JSON.stringify(turnId)}})`)
        assert.equal(result.ok, true)
        return wait(() => events('chat.complete', `params => params.turn_id === ${JSON.stringify(turnId)}`).then(list => list[0]?.full_text), 'Local Pi reply missing')
      }
      // 历史来自 worker（durable 条目），重启后与实时一致。
      const history = async () => {
        const current = (await ui('window.amadeusNext.request("session.list")')).current_session_id
        return (await ui(`window.amadeusNext.request("session.load", {session_id:${JSON.stringify(current)}})`)).messages
      }
      assert.equal(await chat('remember this', 'persist-first'), 'saved-marker')
      const durableSession = (await ui('window.amadeusNext.request("session.list")')).current_session_id
      assert.equal((await ui(`window.amadeusNext.request("session.load", {session_id:${JSON.stringify(durableSession)}})`)).ok, true)
      assert.deepEqual((await history()).map(message => [message.role, message.text]), [['user', 'remember this'], ['assistant', 'saved-marker']], 'the first turn is read back from the durable store')
      console.log('PASS: new turns persist in durable and read back as subtitles text')
      const models = await ui('window.amadeusNext.request("pi.models")')
      assert.equal(models.current, 'fixture/fixture-model')
      assert.equal((await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-alternate"})')).current, 'fixture/fixture-alternate')
      assert.equal((await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-alternate",thinkingLevel:"high"})')).thinkingLevel, 'high')
      await wait(() => ui('document.querySelector(\'[data-testid="scene-provider"]\')?.textContent === "fixture-alternate"'), 'The composer must show the model in use, not the runtime name')
      // Switching from the composer: the menu must be reachable (not clipped) and drive the real runtime.
      await wait(() => ui('!document.querySelector(\'[data-testid="scene-provider"]\')?.disabled'), 'The model control must be enabled while idle')
      await ui('document.querySelector(\'[data-testid="scene-provider"]\').click()')
      await wait(() => ui('!!document.querySelector(\'[data-model="fixture/fixture-model"]\')'), 'The model menu did not open')
      // A long list shows five options and scrolls instead of growing past the window.
      assert.deepEqual(await ui(`(() => {
        const menu = document.querySelector('[data-testid="scene-model-menu"]'), box = menu.getBoundingClientRect()
        const visible = [...menu.querySelectorAll('[data-model]')].filter(item => {
          const rect = item.getBoundingClientRect()
          return rect.top >= box.top && rect.bottom <= box.bottom
        }).length
        return { scrolls: menu.scrollHeight > menu.clientHeight, visible, inWindow: box.top >= 0 }
      })()`), { scrolls: true, visible: 5, inWindow: true }, 'A long model list must show five options and scroll')
      // The dock frame clips its overflow, so every option must be hit-testable from outside it.
      assert.equal(await ui(`(() => {
        const menu = document.querySelector('[data-testid="scene-model-menu"]')
        if (menu.parentElement !== document.body) return 'not portalled'
        for (const item of menu.querySelectorAll('[data-model]')) {
          item.scrollIntoView({ block: 'nearest' })
          const box = item.getBoundingClientRect()
          if (box.top < 0 || box.bottom > innerHeight) return 'outside the window: ' + item.dataset.model
          if (document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) !== item) return 'covered: ' + item.dataset.model
        }
        return 'ok'
      })()`), 'ok', 'The model menu must not be clipped or covered')
      await ui('document.querySelector(\'[data-model="fixture/fixture-model"]\').click()')
      await wait(() => ui('document.querySelector(\'[data-testid="scene-provider"]\')?.textContent === "fixture-model"'), 'Choosing a model in the composer did not update it')
      assert.equal((await ui('window.amadeusNext.request("pi.models")')).current, 'fixture/fixture-model', 'The runtime must be on the chosen model')
      await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-alternate"})')
      await wait(() => ui('document.querySelector(\'[data-testid="scene-provider"]\')?.textContent === "fixture-alternate"'), 'A model changed elsewhere must update the composer')
      await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-alternate",thinkingLevel:"high"})')
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      await wait(() => ui('document.querySelectorAll(".settings-main section[data-section]").length === 4'), 'Settings did not reopen')
      await wait(() => ui('document.querySelectorAll("[data-section=models] select").length === 4'), 'Model, thinking and subagent controls must remain available')
      assert.doesNotMatch(await ui('document.querySelector("[data-section=models]").textContent'), /当前模型连接|其他模型连接|高级模型角色|当前没有选中的活动连接|没有用户管理的连接设置/)
      assert.deepEqual(await ui('Array.from(document.querySelectorAll("[data-section=models] select"), select => select.value)'), ['fixture/fixture-alternate', 'high', '', 'true'])
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      const workerPids = () => app.getAppMetrics().filter(metric => metric.name === 'Amadeus Pi Runtime').map(metric => metric.pid)
      const before = workerPids()
      assert.equal(before.length, 1)
      const modelsFile = path.join(process.env.AMADEUS_PI_CREDENTIALS_DIR, 'models.json')
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
      assert.equal(mainRequests().length, 2, 'Restart must not replay requests')
      const pid = process.pid
      const oldUrl = frame.url
      await ui('document.querySelector(\'[data-testid="scene-open-more"]\').click()')
      await wait(() => ui('!!document.querySelector(".settings-page-shell")'), 'Settings did not reopen')
      assert.equal((await ui('window.amadeusNext.request("runtime.reload", {targets:["pi","scene"]})')).ok, true)
      await wait(() => ui('window.amadeusNext.request("runtime.status").then(result => result.status === "ready" || (result.status === "error" && Promise.reject(new Error(result.error))))'), 'Resource reload failed')
      frame = await wait(() => window.webContents.mainFrame.frames.find(f => (f.url.includes('index.html') || f.url.includes('wallpaper_engine.html')) && f.url !== oldUrl), 'Scene generation was not replaced')
      await wait(() => frame.executeJavaScript('!!window.__amadeusCharacter'), 'Character missing after reload')
      assert.equal(process.pid, pid, 'Resource reload must not restart the main process')
      assert.equal(await chat('still there?', 'persist-third'), 'context-retained')
      assert.equal(mainRequests().length, 3)
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
      assert.equal(mainRequests().length, 4)
      console.log('PASS: a real in-flight Pi reply drains before reload; new requests are rejected rather than replayed')
      // 委托 -> 子代理 -> 汇报：红莉栖先说一句，子代理在后台干活，话筒空闲时她主动汇报，汇报显示为卡片而不是用户气泡。
      assert.equal(await chat('please delegate-research this', 'delegate'), '好，我去查。')
      const task = await wait(() => events('task.graph', 'params => params.tasks.some(task => task.status === "done")').then(list => list.at(-1)?.tasks.find(task => task.status === 'done')), 'The delegated task never finished', 40000)
      assert.equal(task.title, '查资料')
      const reportCard = await wait(() => events('task.report').then(list => list[0]), 'The report was not delivered', 20000)
      assert.deepEqual([reportCard.taskId, reportCard.title, reportCard.status], [task.taskId, '查资料', 'done'])
      const spoken = await wait(() => events('chat.complete', 'params => params.kind === "report"').then(list => list[0]), 'The report was not spoken', 20000)
      assert.equal(spoken.full_text, 'report-spoken')
      assert.equal(spoken.turn_id, reportCard.turnId)
      const reportRequest = mainRequests().at(-1)
      assert.match(reportRequest.messages.findLast(message => message.role === 'user').content, /subagent-findings/, 'the subagent result reached the main conversation')
      const transcript = await history()
      assert.ok(transcript.some(message => message.role === 'card'), 'the report is rendered as a card in the history')
      assert.equal(transcript.some(message => message.role === 'user' && /amadeus_handoff_result/.test(message.text)), false, 'the fenced report is never shown as something the owner said')
      assert.equal(transcript.at(-1).text, 'report-spoken')
      for (const tokens of await events('chat.token')) assert.doesNotMatch(tokens.token, /amadeus_/, 'internal tags never reach the subtitles')
      assert.equal(mainRequests().length, 6, 'one request for the delegating turn and one for the report; nothing is replayed')
      console.log('PASS: delegation runs in the background and the report is spoken as its own turn, shown as a card')
      // 工作面板：列出这次委托，点进去能看到子代理的每一步。
      await ui('document.querySelector(\'[data-testid="scene-open-work"]\').click()')
      const row = `[data-testid="work-row"][data-task-id="${task.taskId}"]`
      await wait(() => ui(`document.querySelector('${row}')?.dataset.status === 'done'`), 'The work panel does not list the finished delegation')
      assert.match(await ui(`document.querySelector('${row}').textContent`), /查资料.*1 次工具调用/s)
      await ui(`document.querySelector('${row}').click()`)
      await wait(() => ui('[...document.querySelectorAll(\'[data-testid="work-event"][data-type="tool"]\')].some(item => /web_fetch.*fixture findings/.test(item.textContent))'), 'The trace does not show the subagent\'s fetch')
      assert.match(await ui('document.querySelector(\'[data-testid="work-timeline"]\').textContent'), /subagent-findings/)
      await ui('document.querySelector(\'[data-testid="work-back"]\').click()')
      await wait(() => ui('!!document.querySelector(\'[data-testid="work-list"]\')'), 'Back did not return to the list')
      await ui('document.querySelector(\'[data-testid="scene-open-work"]\').click()')
      console.log('PASS: the work panel lists the delegation and replays every subagent step')
      // worker 被强杀：主动退避重拉，对话和已投递的汇报都还在，也不会重放请求。
      const victim = workerPids()[0]
      process.kill(victim, 'SIGKILL')
      await wait(() => { const pids = workerPids(); return pids.length === 1 && pids[0] !== victim }, 'The killed worker was not restarted automatically', 30000)
      assert.equal(await chat('are you still there?', 'after-crash'), 'context-retained')
      assert.equal(mainRequests().length, 7, 'a crash replays nothing')
      assert.equal((await events('chat.error')).length, 0)
      assert.equal((await history()).filter(message => message.role === 'card').length, 1, 'the delivered report is not repeated after the restart')
      console.log('PASS: a killed worker is restarted automatically; the conversation and the delivered report survive without replay')
      await frame.executeJavaScript(`(() => {
        const NativeNode = window.AudioWorkletNode
        window.AudioWorkletNode = class extends NativeNode {
          constructor(...args) { super(...args); window.__acceptanceWorklet = this }
        }
      })()`)
      // Production IPC -> React MessageChannel -> real scene -> AudioWorklet.
      const key = { sessionId: 'acceptance', turnId: 'audio', generation: 1000 }
      const send = params => window.webContents.send('next.event', { method: 'voice.event', params: { ...key, ...params } })
      // 固定为 60 才能区分说话时的满帧与待机封顶；测试窗口未必有焦点，否则两者都会被失焦封顶在 15。
      window.webContents.send('next.event', { method: 'voice.event', params: { type: 'frame-rate', fps: 60 } })
      const frameRate = () => frame.executeJavaScript(`new Promise(resolve => {
        const ticker = window.renderApp.getPixiApp().ticker
        let frames = 0
        const count = () => frames++
        ticker.add(count)
        setTimeout(() => { ticker.remove(count); resolve(frames) }, 1000)
      })`)
      send({ type: 'begin', speech: true, calibration: { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 } })
      await frame.executeJavaScript(`(() => {
        window.__acceptanceSubtitles = []
        const native = window.wallpaperApp.setSubtitle.bind(window.wallpaperApp)
        window.wallpaperApp.setSubtitle = text => { window.__acceptanceSubtitles.push(text); return native(text) }
      })()`)
      send({ type: 'text', value: { text: 'Hello world', display: '你好世界', cues: [{ offset: 0, emotion: 'smile' }], subtitles: [{ offset: 0, text: '你好' }, { offset: 6, text: '世界' }] } })
      const pcm = new Uint8Array(24000 * 2 * 3)
      const view = new DataView(pcm.buffer)
      for (let i = 0; i < 72000; i++) view.setInt16(i * 2, Math.sin(i / 24000 * Math.PI * 440) * 1200, true)
      send({ type: 'audio', pcm, alignment: { chunk_seq: 0, content: 'Hello world', chunk_audio_offset_sec: 0, alignment: { segments: [{ text: 'Hello', start: 0, end: 1 }, { text: 'world', start: 1, end: 3 }] } } })
      send({ type: 'input-ended' })
      try {
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.status === "playing"'), 'Audio did not begin')
        await wait(() => frame.executeJavaScript('window.__amadeusEmote.player.getVariable("face_talk") > 0'), 'Audible PCM did not open the native mouth')
        const speakingRate = await frameRate()
        assert.ok(speakingRate > 40, `Speech must render at the configured rate for lip sync, got ${speakingRate} fps`)
        const state = await frame.executeJavaScript('window.__amadeusCharacter')
        assert.equal(state.emotion, 'smile')
        send({ type: 'calibration', calibration: { mouthGain: 12, silenceThreshold: 0.1, syncOffsetMs: 150 } })
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.calibration.mouthGain === 12'), 'Calibration did not update during playback')
        assert.equal(await frame.executeJavaScript('window.__amadeusPlayback.generation'), 1000)
        await writeFile('/tmp/amadeus-electron-speaking.png', (await window.webContents.capturePage()).toPNG())
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.status === "ended"'), 'Playback did not drain')
        assert.deepEqual(await frame.executeJavaScript('window.__acceptanceSubtitles.filter(Boolean)'), ['你好', '世界'], 'Subtitles must follow the utterance being spoken, in order')
        assert.equal(await frame.executeJavaScript('window.__amadeusEmote.player.getVariable("face_talk")'), 0, 'Drained audio must close the native mouth')
        await wait(() => frame.executeJavaScript('window.__amadeusCharacter.label === "表情_普通"'), 'Missing return to the native idle expression')
        const standbyRate = await frameRate()
        assert.ok(standbyRate >= 12 && standbyRate <= 18, `Standby must cap the scene at 15 fps, got ${standbyRate} fps`)
        send({ type: 'begin', generation: 1001, speech: true, calibration: { mouthGain: 8, silenceThreshold: 0.08, syncOffsetMs: 0 } })
        send({ type: 'audio', generation: 1001, pcm })
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.generation === 1001 && window.__amadeusPlayback.status === "playing"'), 'Second playback did not start')
        send({ type: 'reset', generation: 1002 })
        send({ type: 'audio', generation: 1001, pcm })
        await wait(() => frame.executeJavaScript('window.__amadeusPlayback.generation === 1002'), 'Reset not delivered')
        assert.equal(await frame.executeJavaScript('window.__amadeusCharacter.playback'), 'quiet')
        assert.equal(await frame.executeJavaScript('window.wallpaperApp.scene._speakingGate'), 0)
        console.log('PASS: production Electron bridge, real PCM playback, smile cue, drain, post-speech exit, stale generation, full-rate speech with a 15 fps standby cap')
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
        await hookEvents()
        await wait(() => ui('window.amadeusNext.request("runtime.status").then(result => result.status === "ready")'), 'Preload/window reload did not rebind the scene')
        assert.deepEqual(workerPids(), piBeforePreload)
        assert.equal((await history()).findLast(message => message.role === 'assistant').text, 'context-retained')
        assert.equal((await ui('window.amadeusNext.request("pi.models")')).current, 'fixture/fixture-alternate')
        console.log('PASS: preload/window replacement keeps the Pi process, selected model and conversation')
        // The GUI choice is global: what the user picked is what every session uses, and it is remembered.
        const composer = expected => wait(() => ui(`document.querySelector('[data-testid="scene-provider"]')?.textContent === ${JSON.stringify(expected)}`), `The composer must show ${expected}`)
        await composer('fixture-alternate')
        const originalSession = (await ui('window.amadeusNext.request("session.list")')).current_session_id
        await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-model"})')
        await composer('fixture-model')
        assert.equal(JSON.parse(readFileSync(path.join(process.env.AMADEUS_HOME, 'pi', 'settings.json'), 'utf8')).defaultModel, 'fixture-model', 'The chosen model must be remembered as the default')
        await ui('window.dispatchEvent(new Event("amadeus:new-session"))')
        await composer('fixture-model')
        assert.equal((await ui('window.amadeusNext.request("pi.models")')).current, 'fixture/fixture-model', 'A new session must use the chosen model')
        // Choosing again while on the new session, then reopening the old one: the old session follows the choice.
        await ui('window.amadeusNext.request("pi.model.set", {model:"fixture/fixture-alternate"})')
        await composer('fixture-alternate')
        await ui(`window.amadeusNext.request("session.load", {session_id:${JSON.stringify(originalSession)}})`)
        await composer('fixture-alternate')
        assert.equal((await ui('window.amadeusNext.request("pi.models")')).current, 'fixture/fixture-alternate', 'An opened session must follow the chosen model')
        console.log('PASS: the model chosen in the GUI is remembered and used by new and reopened sessions')
      } catch (error) {
        // Report the real failure first: the diagnostics below can themselves throw once the frame was replaced.
        console.error(error)
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
  writeFileSync(path.join(process.env.AMADEUS_PI_CREDENTIALS_DIR, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, models: [{ id: 'fixture-model' }, { id: 'fixture-alternate', reasoning: true }, ...Array.from({ length: 14 }, (_, index) => ({ id: `fixture-extra-${index}` }))],
  } } }))
  mkdirSync(path.join(process.env.AMADEUS_HOME, 'pi'), { recursive: true })
  writeFileSync(path.join(process.env.AMADEUS_HOME, 'pi', 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture-model', retry: { enabled: false } }))
  await import(pathToFileURL(path.join(project, 'dist/main/index.js')).href)
})
