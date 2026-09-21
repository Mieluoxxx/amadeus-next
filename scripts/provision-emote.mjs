import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

// Local, non-commercial import only. See resources/LICENSES/FreeMote-NOTICE.md.
const project = path.resolve(import.meta.dirname, '..')
const source = path.resolve(process.argv[2] || path.join(project, '../salieri-next-emote'))
const output = path.join(project, 'resources/emote')
const models = ['牧瀬紅莉栖ab', '牧瀬紅莉栖ab_白衣', '牧瀬紅莉栖c', '牧瀬紅莉栖c_白衣']
const revision = '4340e8fc2138f013157d5b9cd40ba17d01347093'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const loader = await readFile(path.join(source, 'psb.mjs'))
if (sha256(loader) !== '165d3aec91c8f85f8e498036cf81ca816972674abb4869ddf51877b0f5ae5c36') {
  throw new Error('The source PSB adapter changed; review its API and compatibility before importing it.')
}
await mkdir(output, { recursive: true })
for (const [name, hash] of Object.entries({
  'FreeMoteDriver.js': '64a38cbc4722ee90d58a7d0d464fe121d1a6453acda21c3fca99712c220d0641',
  'emoteplayer.js': '807e5c6a4d58d99c1e876f4155dd73d096ef92a5650c1c2a314be665dfdb9eba',
})) {
  const file = path.join(output, name)
  const cached = await readFile(file).catch(() => null)
  if (cached && sha256(cached) === hash) continue
  const response = await fetch(`https://cdn.jsdelivr.net/gh/Project-AZUSA/FreeMote-SDK@${revision}/WebGL/driver/${name}`, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`FreeMote download failed: ${response.status} ${name}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha256(bytes) !== hash) throw new Error(`FreeMote integrity mismatch: ${name}`)
  await writeFile(file, bytes)
}
await writeFile(path.join(output, 'psb.mjs'), loader)
await cp(path.join(source, 'README.md'), path.join(output, 'SOURCE-README.md'))
const artwork = path.join(output, '红莉栖E-mote模型')
await mkdir(artwork, { recursive: true })
await cp(path.join(source, '红莉栖E-mote模型/README.md'), path.join(artwork, 'README.md'))
for (const model of models) {
  await cp(path.join(source, '红莉栖E-mote模型', model), path.join(artwork, model), { recursive: true, filter: file => path.basename(file) !== '.DS_Store' })
}
console.log(`Provisioned ${models.length} model packs and the verified visibility adapter at ${output}; runtime loading is entirely local.`)
