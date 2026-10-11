import { readFileSync } from 'node:fs'

type StoredMessage = { role: 'user' | 'assistant'; text: string; turn_id?: string }
export type StoredSession = { id: string; title: string; messages: StoredMessage[] }

/** 迁移前的会话历史。durable 接手后只读：可看不可续，也不再写回（architecture §12 #2）。 */
export class SessionStore {
  readonly sessions: StoredSession[] = []

  constructor(file: string) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      const sessions = Array.isArray(value) ? value : value?.sessions
      if (Array.isArray(sessions)) this.sessions = sessions as StoredSession[]
    } catch {
      // 没有旧历史或文件损坏都按空处理，不影响启动。
    }
  }
}
