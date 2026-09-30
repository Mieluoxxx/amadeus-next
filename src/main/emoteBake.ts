import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// 只执行应用自己的副本；打包后优先用 asar 外的 extraResources。
function emoteLoaderPath(moduleDir: string): string {
  const name = process.platform === 'win32' ? 'AmadeusEmoteLoader.exe' : 'AmadeusEmoteLoader'
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, name),
    path.resolve(moduleDir, '../bin', name),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('应用缺少 E-mote 加载器，请重新安装完整应用；开发环境请先运行 npm run emote:loader，再运行 npm run build')
}

type BakedModel = { psb: string; meta: string }
type BakeOptions = { moduleDir: string; modelRoot: string; cacheDir: string; timeoutMs?: number }
const pending = new Map<string, Promise<BakedModel>>()

const EMOTE_RUNTIME = {
  'FreeMoteDriver.js': '64a38cbc4722ee90d58a7d0d464fe121d1a6453acda21c3fca99712c220d0641',
  'emoteplayer.js': '807e5c6a4d58d99c1e876f4155dd73d096ef92a5650c1c2a314be665dfdb9eba',
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** 导入的 JS 会在场景中执行，因此只允许已经核验的运行时版本。 */
export async function verifyEmoteRuntime(root: string): Promise<void> {
  for (const [name, hash] of Object.entries(EMOTE_RUNTIME)) {
    const file = path.join(root, name)
    if (!existsSync(file)) throw new Error(`缺少 E-mote 运行时资源 ${name}，请导入包含运行时和 models/ 的 emote 目录`)
    if (!(await lstat(file)).isFile() || sha256(await readFile(file)) !== hash) throw new Error(`E-mote 运行时校验失败：${name}`)
  }
}

/** 只接受普通目录和文件，不把软链接或设备文件带入应用。 */
async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const file = path.join(root, relative)
  const info = await lstat(file)
  if (info.isFile()) return [relative]
  if (!info.isDirectory()) throw new Error(`资源必须是普通文件或目录，不能使用软链接：${file}`)
  const files: string[] = []
  for (const name of (await readdir(file)).sort()) files.push(...await filesUnder(root, path.join(relative, name)))
  return files
}

async function fingerprint(model: string, folder: string, loader: string): Promise<string> {
  const files = await filesUnder(folder)
  const index = JSON.parse(await readFile(path.join(folder, `${model}.psb.m.resx.json`), 'utf8'))
  for (const group of [index.Resources, index.ExtraResources]) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('模型资源索引格式无效')
    for (const value of Object.values(group)) {
      if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes(':')) throw new Error('模型资源路径无效')
      const relative = path.relative(folder, path.resolve(folder, value))
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`模型资源路径越界：${value}`)
      if (!files.includes(relative)) throw new Error(`缺少模型资源：${value}`)
    }
  }
  const hash = createHash('sha256').update('amadeus-emote-cache-v2\0').update(await readFile(loader))
  for (const file of files) {
    const bytes = await readFile(path.join(folder, file))
    hash.update(JSON.stringify([file, bytes.length])).update(bytes)
  }
  return hash.digest('hex')
}

async function complete(baked: BakedModel, published = true): Promise<boolean> {
  try {
    const psbInfo = await lstat(baked.psb), metaInfo = await lstat(baked.meta)
    if (!psbInfo.isFile() || !metaInfo.isFile()) return false
    if (published) {
      const sizes = JSON.parse(await readFile(path.join(path.dirname(baked.psb), 'complete.json'), 'utf8'))
      if (sizes.psb !== psbInfo.size || sizes.meta !== metaInfo.size) return false
    }
    const handle = await open(baked.psb, 'r')
    try {
      const header = Buffer.alloc(4)
      await handle.read(header, 0, 4, 0)
      if ((await handle.stat()).size < 56 || header.toString('latin1') !== 'PSB\0') return false
    } finally { await handle.close() }
    const { metadata, parts, snaps } = JSON.parse(await readFile(baked.meta, 'utf8'))
    return Array.isArray(metadata?.variableMetaInfoList) && Array.isArray(metadata?.eyeControl) && Array.isArray(metadata?.customSelectorList)
      && Array.isArray(parts) && !!snaps && typeof snaps === 'object' && !Array.isArray(snaps)
  } catch { return false }
}

async function bake(model: string, options: BakeOptions): Promise<BakedModel> {
  const folder = path.resolve(options.modelRoot, model)
  const source = path.join(folder, `${model}.psb.m.json`)
  if (!existsSync(source)) throw new Error(`缺少模型包：${source}`)
  const loader = emoteLoaderPath(options.moduleDir)
  const key = await fingerprint(model, folder, loader)
  const parent = path.join(options.cacheDir, model)
  const destination = path.join(parent, key)
  const paths = (directory: string): BakedModel => ({ psb: path.join(directory, `${model}.psb`), meta: path.join(directory, `${model}.meta.json`) })
  const baked = paths(destination)
  if (await complete(baked)) return baked
  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(path.join(parent, '.bake-'))
  try {
    await run(loader, ['bake', '--model', folder, '--out', paths(temporary).psb], {
      timeout: options.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024,
    })
    if (!await complete(paths(temporary), false)) throw new Error('E-mote 烘焙产物不完整或格式无效')
    if (await fingerprint(model, folder, loader) !== key) throw new Error('烘焙期间模型或加载器发生变化，请重试')
    await writeFile(path.join(temporary, 'complete.json'), JSON.stringify({ psb: (await lstat(paths(temporary).psb)).size, meta: (await lstat(paths(temporary).meta)).size }))
    // 另一个进程可能已发布相同输入的完整产物；绝不覆盖仍在服务的有效世代。
    if (!await complete(baked)) {
      await rm(destination, { recursive: true, force: true })
      try { await rename(temporary, destination) } catch (error) {
        if (!await complete(baked)) throw error
      }
    }
    // ponytail: 保留旧世代以保护仍在加载的场景；模型频繁更新时再增加显式缓存清理。
    return baked
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/** 合并同一模型的并发请求，失败后允许重新尝试。 */
export async function ensureBakedModel(model: string, options: BakeOptions): Promise<BakedModel> {
  if (!/^[a-z][a-z0-9_]*$/.test(model)) throw new Error('无效的模型名')
  const key = JSON.stringify([model, path.resolve(options.modelRoot), path.resolve(options.cacheDir), options.moduleDir])
  const existing = pending.get(key)
  if (existing) return existing
  const task = bake(model, options).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

/** 先校验、复制并试烘焙，再替换应用自己的资源目录；失败不破坏旧资源。 */
export async function importEmoteAssets(source: string, destination: string, options: Omit<BakeOptions, 'modelRoot'>): Promise<BakedModel> {
  await verifyEmoteRuntime(source)
  await filesUnder(source)
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = await mkdtemp(path.join(path.dirname(destination), '.emote-import-'))
  const backup = `${destination}.previous-${randomUUID()}`
  let moved = false
  try {
    await cp(source, temporary, { recursive: true, dereference: false })
    await filesUnder(temporary)
    await verifyEmoteRuntime(temporary)
    const baked = await ensureBakedModel('kurisu_ab_white', { ...options, modelRoot: path.join(temporary, 'models') })
    if (existsSync(destination)) { await rename(destination, backup); moved = true }
    try { await rename(temporary, destination) } catch (error) {
      if (moved) await rename(backup, destination)
      throw error
    }
    if (moved) await rm(backup, { recursive: true, force: true }).catch(() => {}) // 清理失败不把已完成的导入报告为失败。
    return baked
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
