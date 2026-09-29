import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.resolve(import.meta.dirname, '..')
const binary = process.platform === 'win32' ? 'AmadeusEmoteLoader.exe' : 'AmadeusEmoteLoader'
const target = `${process.platform}-${process.arch}`
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** 日常 build/dev 只校验并复制本仓库产物，不访问上游、不运行 Cargo。 */
export async function prepareEmoteLoader(root = project, required = false) {
  const source = path.join(root, 'vendor/emote-loader', target)
  const output = path.join(root, 'dist/bin')
  const files = { [binary]: binary, 'manifest.json': 'AmadeusEmoteLoader.json', LICENSE: 'AmadeusEmoteLoader-LICENSE', 'THIRD_PARTY_NOTICES.txt': 'AmadeusEmoteLoader-NOTICES' }
  try {
    const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
    if (manifest.schema !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || !/^[a-f0-9]{40}$/.test(manifest.revision)) {
      throw new Error(`E-mote 加载器版本或平台不匹配：${source}`)
    }
    for (const name of Object.keys(files)) {
      if (!(await lstat(path.join(source, name))).isFile()) throw new Error(`加载器产物必须是普通文件：${name}`)
    }
    if (sha256(await readFile(path.join(source, binary))) !== manifest.sha256) throw new Error(`E-mote 加载器 SHA-256 校验失败：${source}`)
    await mkdir(output, { recursive: true })
    for (const [from, to] of Object.entries(files)) {
      const temporary = path.join(output, `${to}.${process.pid}.tmp`)
      try {
        await copyFile(path.join(source, from), temporary)
        if (from === binary) await chmod(temporary, 0o755)
        await rename(temporary, path.join(output, to))
      } finally { await rm(temporary, { force: true }) }
    }
  } catch (error) {
    // 不许意外沿用上一次构建留下的另一个版本。
    await Promise.all(Object.values(files).map(name => rm(path.join(output, name), { force: true })))
    if (error.code !== 'ENOENT') throw error
    const message = `缺少 ${target} E-mote 加载器；请运行 npm run emote:loader -- <源码仓库> <commit>`
    if (required) throw new Error(message)
    console.warn(message)
  }
}

/** electron-builder 也执行同一校验，防止绕过 npm 包装或误打另一架构。 */
export async function beforePack(context) {
  const { Arch } = await import('builder-util')
  if (context.electronPlatformName !== process.platform || Arch[context.arch] !== process.arch) {
    throw new Error('E-mote 加载器仅支持在目标系统/架构上打包；请先准备对应平台的独立产物')
  }
  await prepareEmoteLoader(context.packager.projectDir, true)
}

/** 显式升级：只从指定提交导出源码，绝不编译上游工作区的未提交改动。 */
async function importLoader(source, revision) {
  if (!source || !revision) throw new Error('用法：npm run emote:loader -- <源码仓库> <commit>')
  const git = args => execFileSync('git', ['-C', path.resolve(source), ...args], { maxBuffer: 32 * 1024 * 1024 })
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).toString().trim()
  const work = await mkdtemp(path.join(os.tmpdir(), 'amadeus-loader-'))
  const destination = path.join(project, 'vendor/emote-loader', target)
  const backup = `${destination}.previous-${randomUUID()}`
  let output
  try {
    execFileSync('tar', ['-xf', '-', '-C', work], { input: git(['archive', '--format=tar', commit]) })
    const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
    const architecture = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
    const system = { darwin: 'apple-darwin', linux: 'linux', win32: 'windows' }[process.platform]
    if (!architecture || !system || !host?.startsWith(architecture + '-') || !host.includes(system)) throw new Error('Rust 编译目标必须与当前 Node 平台和架构一致')
    execFileSync('cargo', ['build', '--release', '--locked', '--bin', 'emote-loader', '--target', host, '--target-dir', path.join(work, 'target')], { cwd: work, stdio: 'inherit' })
    const built = path.join(work, 'target', host, 'release', process.platform === 'win32' ? 'emote-loader.exe' : 'emote-loader')
    await mkdir(path.dirname(destination), { recursive: true })
    output = await mkdtemp(path.join(path.dirname(destination), '.import-'))
    await copyFile(built, path.join(output, binary))
    await chmod(path.join(output, binary), 0o755)
    await copyFile(path.join(work, 'LICENSE'), path.join(output, 'LICENSE'))
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', host], { cwd: work, maxBuffer: 16 * 1024 * 1024 }))
    const notices = []
    for (const pkg of metadata.packages.filter(pkg => pkg.source)) {
      const folder = path.dirname(pkg.manifest_path)
      const names = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice)([-_.]|$)/i.test(entry.name)).map(entry => entry.name)
      if (pkg.license_file && !names.includes(pkg.license_file)) names.push(pkg.license_file)
      if (!names.length) throw new Error(`依赖缺少许可正文，请手工审查：${pkg.name}@${pkg.version}`)
      notices.push(`\n===== ${pkg.name}@${pkg.version} (${pkg.license}) =====\n`)
      for (const name of names.sort()) notices.push(await readFile(path.join(folder, name), 'utf8'))
    }
    await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'))
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
      schema: 1, source: 'https://github.com/Mieluoxxx/amadeus-emote-loader', revision: commit,
      platform: process.platform, arch: process.arch, target: host,
      sha256: sha256(await readFile(built)), license: 'Apache-2.0',
    }, null, 2) + '\n')
    const moved = existsSync(destination)
    if (moved) await rename(destination, backup)
    try { await rename(output, destination) } catch (error) {
      if (moved) await rename(backup, destination)
      throw error
    }
    if (moved) await rm(backup, { recursive: true, force: true }).catch(() => {})
    await prepareEmoteLoader(project, true)
    console.log(`已导入 ${commit} → ${destination}；请一并提交二进制、manifest.json、LICENSE 和依赖许可。`)
  } finally {
    await rm(work, { recursive: true, force: true })
    if (output) await rm(output, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await importLoader(process.argv[2], process.argv[3])
}
