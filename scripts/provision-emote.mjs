import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

// 仅用于本地非商业导入，详见 resources/LICENSES/FreeMote-NOTICE.md。
const project = path.resolve(import.meta.dirname, '..')
if (!process.argv[2]) throw new Error('用法：npm run assets:emote -- <素材来源目录>；不再隐式依赖相邻仓库')
const source = path.resolve(process.argv[2])
const destination = path.join(project, 'resources/character/emote')
const output = await mkdtemp(path.join(project, 'resources/.emote-import-'))
const backup = `${destination}.previous-${randomUUID()}`
// 上游模型包使用日文目录名；此处映射为纯 ASCII 目录以避免环回场景 URL 在解析非 ASCII 字符时异常。
const models = {
  '牧瀬紅莉栖ab': 'kurisu_ab',
  '牧瀬紅莉栖ab_白衣': 'kurisu_ab_white',
  '牧瀬紅莉栖c': 'kurisu_c',
  '牧瀬紅莉栖c_白衣': 'kurisu_c_white',
}
const revision = '4340e8fc2138f013157d5b9cd40ba17d01347093'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// 兼容适配与 PSB 编码由随应用交付的解析器负责，
// 这里不再导入 psb.mjs：渲染端只消费烘焙产物。
try {
  for (const [name, hash] of Object.entries({
    'FreeMoteDriver.js': '64a38cbc4722ee90d58a7d0d464fe121d1a6453acda21c3fca99712c220d0641',
    'emoteplayer.js': '807e5c6a4d58d99c1e876f4155dd73d096ef92a5650c1c2a314be665dfdb9eba',
  })) {
    const file = path.join(output, name)
    const cached = await readFile(path.join(destination, name)).catch(() => null)
    if (cached && sha256(cached) === hash) { await writeFile(file, cached); continue }
    const response = await fetch(`https://cdn.jsdelivr.net/gh/Project-AZUSA/FreeMote-SDK@${revision}/WebGL/driver/${name}`, { signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error(`FreeMote download failed: ${response.status} ${name}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (sha256(bytes) !== hash) throw new Error(`FreeMote integrity mismatch: ${name}`)
    await writeFile(file, bytes)
  }
  await cp(path.join(source, 'README.md'), path.join(output, 'SOURCE-README.md'))
  const artwork = path.join(output, 'models')
  await mkdir(artwork, { recursive: true })
  await cp(path.join(source, '红莉栖E-mote模型/README.md'), path.join(artwork, 'README.md'))
  for (const [name, ascii] of Object.entries(models)) {
    const folder = path.join(artwork, ascii)
    await cp(path.join(source, '红莉栖E-mote模型', name), folder, { recursive: true, dereference: true, filter: file => path.basename(file) !== '.DS_Store' })
    for (const entry of await readdir(folder)) {
      if (!entry.startsWith(name)) continue
      await rename(path.join(folder, entry), path.join(folder, `${ascii}${entry.slice(name.length)}`))
    }
    const index = path.join(folder, `${ascii}.psb.m.resx.json`)
    const text = await readFile(index, 'utf8')
    if (!text.includes(name)) throw new Error(`The resource index for ${name} does not reference its own pack.`)
    await writeFile(index, text.replaceAll(name, ascii))
  }
  const moved = existsSync(destination)
  if (moved) await rename(destination, backup)
  try { await rename(output, destination) } catch (error) {
    if (moved) await rename(backup, destination)
    throw error
  }
  if (moved) await rm(backup, { recursive: true, force: true })
  console.log(`Provisioned ${Object.keys(models).length} independent model packs and the pinned FreeMote runtime at ${destination}. The packaged app can import this directory without retaining its source path.`)
} finally { await rm(output, { recursive: true, force: true }) }
