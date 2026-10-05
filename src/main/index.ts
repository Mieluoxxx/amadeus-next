import { app, BrowserWindow, dialog, ipcMain, safeStorage, utilityProcess } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { AppRuntime } from './appRuntime.ts'
import { systemClock } from './clock.ts'
import { SceneHost } from './sceneHost.ts'
import { ensureBakedModel, importEmoteAssets, verifyEmoteRuntime } from './emoteBake.ts'
import { FishTts } from './fishTts.ts'
import { PiHost } from './piHost.ts'
import { ensurePromptFiles } from './role.ts'
import { SessionStore } from './sessionStore.ts'
import { SpeechBridge, systemSpeechOptions } from './speechBridge.ts'

type Json = Record<string, unknown>

const DEV_SERVER_URL = process.env.AMADEUS_NEXT_DEV_URL || 'http://127.0.0.1:5199'
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 会话标题附带时间戳，避免默认同名冲突并便于按时间回溯。 */
function timestampedSessionTitle(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `新对话-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`
}

function projectRoot(): string {
  if (process.env.AMADEUS_NEXT_PROJECT_ROOT) return process.env.AMADEUS_NEXT_PROJECT_ROOT
  const bundledAssets = path.join(process.resourcesPath || '', 'amadeus-assets')
  if (existsSync(path.join(bundledAssets, 'scene/stage/index.html')) || existsSync(path.join(bundledAssets, 'render/web/wallpaper_engine.html'))) return bundledAssets
  return path.resolve(MODULE_DIR, '../../resources')
}

function jsonFile(file: string, fallback: Json): Json {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch {
    return fallback
  }
}

// 设置文件独立于应用目录（~/.amadeus），便于用户直接维护与版本迁移；敏感凭据仍由系统安全存储加密。
function amadeusHome(): string {
  return process.env.AMADEUS_HOME || path.join(os.homedir(), '.amadeus')
}

function settingsPath(): string {
  return path.join(amadeusHome(), 'settings.yaml')
}

// 运行环境与宿主开发机隔离，防止外部扩展与技能污染角色设定，仅共享凭据与模型定义。
function piHome(): { agentDir: string; cwd: string; authPath: string; modelsPath: string } {
  const agentDir = path.join(amadeusHome(), 'pi')
  const shared = process.env.AMADEUS_PI_CREDENTIALS_DIR || path.join(os.homedir(), '.pi', 'agent')
  const cwd = path.join(amadeusHome(), 'workspace')
  mkdirSync(cwd, { recursive: true })
  ensurePromptFiles(agentDir)
  const settings = path.join(agentDir, 'settings.json')
  if (!existsSync(settings)) {
    // 初次初始化仅继承默认模型，防止环境隔离后回退到不可用的随机模型。
    const source = jsonFile(path.join(shared, 'settings.json'), {})
    const seed = Object.fromEntries(['defaultProvider', 'defaultModel', 'defaultThinkingLevel'].filter(key => key in source).map(key => [key, source[key]]))
    writeFileSync(settings, JSON.stringify(seed, null, 2), 'utf8')
  }
  return { agentDir, cwd, authPath: path.join(shared, 'auth.json'), modelsPath: path.join(shared, 'models.json') }
}

function readYaml(file: string): Json {
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : {}
  } catch {
    return {}
  }
}

function writeYaml(file: string, data: Json): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, stringifyYaml(data), { encoding: 'utf8', mode: 0o600 })
}

/** 兼容平滑迁移旧版文件命名，无冲突时接管历史数据。 */
function adoptLegacyFile(file: string): string {
  const legacy = path.join(path.dirname(file), path.basename(file).replace(/^amadeus-next-/, 'salieri-next-'))
  try {
    if (!existsSync(file) && existsSync(legacy)) renameSync(legacy, file)
  } catch {
    // 迁移失败时回退为空存储，避免阻断应用启动。
  }
  return file
}

function createRuntime(): AppRuntime {
  const root = projectRoot()
  const userData = app.getPath('userData')
  const settingsFile = settingsPath()
  return new AppRuntime({
    env: process.env,
    root,
    moduleDir: MODULE_DIR,
    userData,
    clock: systemClock,
    store: new SessionStore(adoptLegacyFile(path.join(userData, 'amadeus-next-sessions.json'))),
    settings: { read: () => readYaml(settingsFile), write: data => writeYaml(settingsFile, data) },
    safeStorage,
    dialog,
    exit: code => app.exit(code),
    timestampedSessionTitle,
    verifyEmoteRuntime,
    ensureBakedModel,
    importEmoteAssets,
    createScene: cacheDir => new SceneHost(root, path.join(MODULE_DIR, '../scene'), cacheDir),
    createPi: piEnv => new PiHost(() => {
      const home = piHome()
      return utilityProcess.fork(path.join(MODULE_DIR, 'pi-worker.js'), [], {
        cwd: home.cwd,
        env: {
          ...process.env, ...piEnv(),
          PI_CODING_AGENT_DIR: home.agentDir, AMADEUS_NEXT_PI_CWD: home.cwd,
          AMADEUS_NEXT_PI_AUTH: home.authPath, AMADEUS_NEXT_PI_MODELS: home.modelsPath,
          AMADEUS_NEXT_PI_SESSIONS: path.join(userData, 'pi-sessions'),
        },
        serviceName: 'Amadeus Pi Runtime',
        stdio: 'ignore',
      })
    }),
    createSpeech: emit => new SpeechBridge(emit, systemSpeechOptions(MODULE_DIR)),
    createTts: (config, emit) => new FishTts(config, emit),
  })
}

let runtime: AppRuntime

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#05070b',
    webPreferences: {
      preload: path.join(MODULE_DIR, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  runtime.attach(window)
  if (process.env.AMADEUS_NEXT_DEV === '1') await window.loadURL(DEV_SERVER_URL)
  else await window.loadFile(path.join(MODULE_DIR, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  runtime = createRuntime()
  await runtime.init()
  ipcMain.handle('next.request', (event, method: string, params: Json) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Only the application frame can call the runtime')
    return runtime.request(method, params || {})
  })
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => runtime?.dispose())
