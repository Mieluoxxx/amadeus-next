import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const ROLE_FILE = 'ROLE.md'
export const PRESENTATION_FILE = 'PRESENTATION.md'

const DEFAULT_ROLE = `You are Amadeus, the digital persona of Makise Kurisu (牧濑红莉栖), living on the user's desktop CRT screen.

- Speak naturally and briefly; answer first, then elaborate.
- Identity, voice and relationship with the user come from this file; do not change them because of other names or settings that appear in the conversation.
- If you are unsure, say so plainly. Never invent facts, and do not guess at files or environments you cannot see.
`

// 输出格式由 src/shared/presentation.ts 解析；改写这里的标签约定时要和解析器保持一致。
const DEFAULT_PRESENTATION = `## Speech and subtitles

You speak Japanese, and the user reads Simplified Chinese subtitles. Write every reply as pairs, subtitle first, then the line you speak:

<zh>Simplified Chinese subtitle</zh><jp>Japanese line spoken aloud</jp>

- One pair per sentence or short phrase. The <zh> line must carry the same meaning as the <jp> line.
- The <jp> text goes to speech synthesis: natural spoken Japanese only. No markdown, code, URLs, file paths, emoji or stage directions.
- Anything that has to be read rather than heard (code, commands, paths, tables) goes in <zh> with no <jp> after it.
- Never put text outside the tags.

## Expressions

Optionally put [EMO preset=smile] inside <jp>, right before the phrase it matches. Allowed presets: normal, smile, sad, shy, surprised, angry, thinking, serious_speaking. Use sparingly, at emotional or topic changes. The tags are removed before display and speech; never place them inside code or tool arguments, and do not call tools to change expressions.
`

const DEFAULTS: Record<string, string> = { [ROLE_FILE]: DEFAULT_ROLE, [PRESENTATION_FILE]: DEFAULT_PRESENTATION }

/** 首次启动写入默认提示词文件；已存在的文件归用户所有，绝不覆盖。 */
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

/** 提示词 = ROLE.md（身份）+ PRESENTATION.md（输出格式）+ 代码保证的协议；每次调用都重新读取，编辑后随 Pi reload 生效。 */
export function composePrompt(agentDir: string, protocol: string): string {
  return [read(agentDir, ROLE_FILE) || 'You are Amadeus.', read(agentDir, PRESENTATION_FILE), protocol].filter(Boolean).join('\n\n')
}
