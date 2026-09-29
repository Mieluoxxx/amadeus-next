import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('idle 轮播始终不透底，进入和退出仍保留整层渐变', async () => {
  class Container {
    children = []
    visible = true
    alpha = 1
    addChild(child) {
      const index = this.children.indexOf(child)
      if (index !== -1) this.children.splice(index, 1)
      this.children.push(child)
    }
  }
  class Sprite { visible = true; alpha = 1; texture = null }
  const urls = ['idle-a', 'idle-b', 'idle-c']
  const textures = new Map(urls.map(url => [url, { baseTexture: Object.assign(new EventEmitter(), { valid: true }) }]))
  const PIXI = { Container, Sprite, Texture: { from: url => textures.get(url) } }
  const app = { view: { addEventListener() {} }, stage: { getChildIndex: () => 0, addChildAt() {} } }
  const window = { PIXI, renderApp: { getPixiApp: () => app } }
  let advance
  vm.runInNewContext(await readFile(new URL('../resources/render/web/wallpaper_scene.js', import.meta.url), 'utf8'), {
    window, PIXI, console: { log() {} },
    setInterval(callback) { advance = callback; return 1 }, clearInterval() {},
  })
  const scene = window.wallpaperApp.scene
  scene.app = app
  scene.setIdleLoop(urls)
  assert.equal(scene.idleOpaque(), false)
  scene.tick(22.5)
  assert.equal(scene.idleLayer.alpha, 0.5)
  assert.equal(scene.idleOpaque(), false, '首次淡入时不能过早隐藏 E-mote')
  scene.tick(22.5)
  assert.equal(scene.idleOpaque(), true)

  // 连续轮换并跨过列表末尾，覆盖两个 Sprite 交替充当新图的顺序。
  for (let transition = 0; transition < 5; transition++) {
    advance()
    for (const delta of [0, 11.25, 11.25, 11.25, 11.25]) {
      scene.tick(delta)
      assert.equal(scene.idleOpaque(), true, '轮播过渡不能让 E-mote 重新可见')
      assert.equal(scene.idleLayer.children.at(-1), scene.idleA, '新图必须在旧图上方淡入')
      const leak = scene.idleLayer.children.reduce((remaining, sprite) => remaining * (sprite.visible ? 1 - sprite.alpha : 1), 1)
      assert.equal(leak, 0, '每一个过渡采样点都必须完全遮住底层')
      if (scene._idleFade) {
        assert.equal(scene._idleFade.outgoing.alpha, 1)
        assert.equal(scene.idleA.alpha, scene._idleFade.t)
      }
    }
    assert.equal(scene._idleFade, null)
    assert.equal(scene.idleB.visible, false)
  }

  const next = textures.get(urls[(scene._idleIndex + 1) % urls.length])
  const previous = scene.idleA
  next.baseTexture.valid = false
  advance()
  scene.tick(22.5)
  assert.equal(scene.idleA, previous, '下一张未加载时保留旧图')
  assert.equal(scene.idleOpaque(), true)
  next.baseTexture.valid = true
  next.baseTexture.emit('loaded')
  scene.tick(11.25)
  assert.equal(scene.idleOpaque(), true)

  scene.setIdleLoop(null)
  scene.tick(22.5)
  assert.equal(scene.idleLayer.alpha, 0.5)
  assert.equal(scene.idleOpaque(), false, '轮播中退出 idle 仍应恢复 E-mote')
  scene.tick(22.5)
  assert.equal(scene.idleLayer.visible, false)
  assert.equal(scene.idleA.texture, null)
  assert.equal(scene.idleB.texture, null)
  scene.setIdleLoop(urls)
  scene.tick(45)
  assert.equal(scene.idleOpaque(), true, '清理后再次进入 idle 仍应正常覆盖')
  scene.idleA.visible = false
  assert.equal(scene.idleOpaque(), false, '隐藏的 Sprite 不能算作覆盖')
  scene.idleA.visible = true
  scene.idleA.texture.baseTexture.valid = false
  assert.equal(scene.idleOpaque(), false, '失效贴图不能算作覆盖')
})
