import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type StoredMessage ={ role: 'user' | 'assistant'; text: string; turn_id?: string }
export type StoredSession = { id: string; title: string; messages: StoredMessage[] }

export class SessionStore {
  private readonly file: string
  sessions: StoredSession[] = []
  currentId = ''

  constructor(file: string) {
    this.file = file
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(value)) this.sessions = value as StoredSession[]
      else if (Array.isArray(value?.sessions)) {
        this.sessions = value.sessions
        this.currentId = typeof value.currentId === 'string' ? value.currentId : ''
      }
    } catch {
      this.sessions = []
    }
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ currentId: this.currentId, sessions: this.sessions }, null, 2), 'utf8')
  }
}
