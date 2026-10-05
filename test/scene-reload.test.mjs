import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SceneHost } from '../src/main/sceneHost.ts'

test('scene resources reload on the same host and invalid geometry leaves the last snapshot usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-scene-reload-'))
  const host = new SceneHost(root, root)
  const config = { img_size: [100, 200], crt_corners: [[0, 0], [0, 10], [10, 10], [10, 0]] }
  const file = path.join(root, 'scene/room/crt_config.json')
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(config))
    await host.start()
    const url = `${host.origin}/next/init`
    assert.deepEqual((await (await fetch(url)).json()).scene.crtConfig, config)
    config.img_size = [200, 300]
    await writeFile(file, JSON.stringify(config))
    host.reload()
    assert.deepEqual((await (await fetch(url)).json()).scene.crtConfig, config)
    await writeFile(file, '{}')
    assert.throws(() => host.reload(), /Invalid CRT geometry/)
    assert.deepEqual((await (await fetch(url)).json()).scene.crtConfig, config)
    await writeFile(file, '{')
    assert.throws(() => host.reload(), SyntaxError)
    assert.deepEqual((await (await fetch(url)).json()).scene.crtConfig, config)
  } finally {
    host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('scene URLs pin a cache generation so PSB and metadata cannot cross during reload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'amadeus-scene-generation-'))
  const cache = path.join(root, 'cache')
  const host = new SceneHost(root, root, cache)
  try {
    for (const generation of ['first', 'second']) {
      await mkdir(path.join(cache, generation), { recursive: true })
      await writeFile(path.join(cache, generation, 'kurisu_ab_white.meta.json'), JSON.stringify({ generation }))
    }
    await host.start()
    host.setEmoteAssets(path.join(root, 'imported'), path.join(cache, 'first'))
    const first = (await (await fetch(host.origin + '/next/init')).json()).character
    host.setEmoteAssets(path.join(root, 'imported'), path.join(cache, 'second'))
    const second = (await (await fetch(host.origin + '/next/init')).json()).character
    assert.notEqual(first.psbUrl, second.psbUrl)
    assert.equal((await (await fetch(host.origin + first.metaUrl)).json()).generation, 'first')
    assert.equal((await (await fetch(host.origin + second.metaUrl)).json()).generation, 'second')
    assert.throws(() => host.setEmoteAssets(root, path.join(root, 'outside')), /outside/)
  } finally { host.close(); await rm(root, { recursive: true, force: true }) }
})
