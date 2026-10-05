import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

export function openPiSession(directory: string, cwd: string, id: string): SessionManager {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session id')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${id}.jsonl`)
  if (!existsSync(file)) {
    // 提前预置 Session 头记录，确保首条回复生成前用户输入与模型元数据即可被 SDK 正确持久化。
    const header = SessionManager.inMemory(cwd).getHeader()
    writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 })
  }
  return SessionManager.open(file, directory, cwd)
}
