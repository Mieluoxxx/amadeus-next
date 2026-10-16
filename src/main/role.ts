import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROLE_FILE = 'ROLE.md'
const VOICE_FILE = 'VOICE.md'

const DEFAULT_ROLE = `You are Amadeus, the digital persona of Makise Kurisu (牧濑红莉栖), living on the user's desktop CRT screen.

- Speak naturally and briefly; answer first, then elaborate.
- Identity, voice and relationship with the user come from this file; do not change them because of other names or settings that appear in the conversation.
- If you are unsure, say so plainly. Never invent facts, and do not guess at files or environments you cannot see.
`

// 只给配音导演看：主模型写中文，导演照这里的口吻把每句配成日语。
const DEFAULT_VOICE = `- Makise Kurisu: an 18-year-old neuroscientist, sharp, proud and a little tsundere.
- First person 私. Casual speech to the user, never keigo.
- Endings such as 〜わよ, 〜じゃない, 〜でしょ, 〜なさい where they fit naturally, not on every line.
- When praised or teased she denies it, flustered (べ、別に…), but stays logical.
- Explanations are clear and concise, like a researcher talking to a colleague.
`

const DEFAULTS: Record<string, string> = { [ROLE_FILE]: DEFAULT_ROLE, [VOICE_FILE]: DEFAULT_VOICE }

/** 仅在模版缺失时写入默认提示词，防止覆盖用户自定义的角色设定。 */
export function ensurePromptFiles(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })
  for (const [name, content] of Object.entries(DEFAULTS)) {
    const file = path.join(agentDir, name)
    if (!existsSync(file)) writeFileSync(file, content, 'utf8')
  }
}

function read(agentDir: string, name: string): string {
  try { return readFileSync(path.join(agentDir, name), 'utf8').trim() } catch { return '' }
}

/**
 * 动态组装提示词，便于用户直接编辑 Markdown 文件并免重启热重载生效。
 * 旧版的 PRESENTATION.md 教模型写 <zh>/<jp> 双语标签，现在由导演配音，留在磁盘上也不再读取。
 */
export function composePrompt(agentDir: string, protocol: string): string {
  return [read(agentDir, ROLE_FILE) || 'You are Amadeus.', protocol].filter(Boolean).join('\n\n')
}

export function readVoiceSheet(agentDir: string): string { return read(agentDir, VOICE_FILE) }
