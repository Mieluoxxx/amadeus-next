import { normalizeEmotion, type Emotion } from './character.ts'

/** 设置页的 translation_model（`provider/model`，空 = 与对话模型相同）经这个环境变量传给 worker，变化经 config.apply 热更新。 */
export const TRANSLATION_MODEL_ENV = 'AMADEUS_TRANSLATION_MODEL'

/** 主进程发给 worker `voice.direct` 的一批台词：主模型写好的中文，按序号配成日语。 */
export type DirectionRequest = {
  lines: { id: number; zh: string }[]
  /** 这批之前刚说过的几句，只给导演保持语气连贯，不再配音。 */
  context: { zh: string; jp?: string }[]
  /** 主人这一轮说的话；汇报回合没有。 */
  heard?: string
}

export type DirectedLine = { id: number; jp: string; emotion?: Emotion; voice?: string }

/** 给导演看的表情名沿用旧提示词里的叫法，经 normalizeEmotion 落到场景的 Emotion。 */
export const EMOTION_PRESETS = ['normal', 'smile', 'thinking', 'serious', 'sad', 'shy', 'surprised', 'angry'] as const

// Fish S2 把方括号里的短英文当作演绎描述；只放行这几种，导演写出别的就当没写，避免把奇怪的指令送进合成。
export const VOICE_CUES = ['sigh', 'whisper', 'laugh', 'chuckle', 'gasp', 'emphasis', 'pause', 'soft tone', 'laughing nervously'] as const

const text = (value: unknown): string => typeof value === 'string' ? value : ''

// 导演偶尔会把舞台说明或标签写进台词；这些不该被念出来。
const UNSPOKEN = /\[[^\]\n]*\]|<[^>\n]*>|[*_`#]/g

/**
 * 解析导演的回复：容忍代码围栏和前后废话，只取第一个 `{` 到最后一个 `}`。
 * 只认请求里有的 id；台词为空、重复的 id 都丢掉，缺的那几句由调用方降级处理。
 */
export function parseDirection(reply: string, ids: readonly number[]): DirectedLine[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let value: unknown
  try { value = JSON.parse(reply.slice(start, end + 1)) } catch { return [] }
  const lines = value && typeof value === 'object' ? (value as { lines?: unknown }).lines : undefined
  if (!Array.isArray(lines)) return []
  const wanted = new Set(ids)
  const result: DirectedLine[] = []
  for (const item of lines) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const id = Number(entry.id)
    if (!wanted.has(id)) continue
    const jp = text(entry.jp).replace(UNSPOKEN, '').replace(/\s+/g, ' ').trim()
    if (!jp) continue
    wanted.delete(id)
    const emotion = normalizeEmotion(text(entry.emotion))
    const cue = text(entry.voice).trim().toLowerCase().replace(/^\[|\]$/g, '')
    const voice = (VOICE_CUES as readonly string[]).includes(cue) ? cue : undefined
    result.push({ id, jp, ...(emotion ? { emotion } : {}), ...(voice ? { voice } : {}) })
  }
  return result
}
