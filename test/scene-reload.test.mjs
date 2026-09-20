import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SceneHost } from '../src/main/sceneHost.ts'

test('scene resources reload on the same host and invalid geometry leaves the last snapshot usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'salieri-scene-reload-'))
  const host = new SceneHost(root, root)
  const config = { img_size: [100, 200], crt_corners: [[0, 0], [0, 10], [10, 10], [10, 0]] }
  const file = path.join(root, 'wallpaper/crt_config.json')
  try {
    await mkdir(path.dirname(file))
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
