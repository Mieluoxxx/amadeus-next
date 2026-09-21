export type Activity = 'idle' | 'listening' | 'thinking' | 'tool'
export type Emotion = 'neutral' | 'thinking' | 'serious' | 'smile' | 'sad' | 'shy' | 'surprise' | 'angry'

export type CharacterEvent =
  | { type: 'activity'; activity: Activity; random: number }
  | { type: 'cue'; emotion: Emotion; random: number }
  | { type: 'playback'; status: 'waiting' | 'playing' | 'buffering' | 'ended'; now: number; random?: number }
  | { type: 'cycle'; node: string; random: number }
  | { type: 'tick'; now: number; random: number }
  | { type: 'reset' }

const aliases: Record<string, Emotion> = {
  normal: 'neutral', neutral: 'neutral', happy: 'smile', smile: 'smile', '微笑': 'smile', '开心': 'smile',
  thinking: 'thinking', think: 'thinking', work: 'thinking', working: 'thinking', '思考': 'thinking',
  serious: 'serious', serious_speaking: 'serious', speaking_serious: 'serious', '严肃': 'serious',
  sad: 'sad', disappointed: 'sad', sadness: 'sad', '悲伤': 'sad', '失望': 'sad',
  shy: 'shy', blush: 'shy', '害羞': 'shy', surprise: 'surprise', surprised: 'surprise', '惊讶': 'surprise',
  angry: 'angry', mad: 'angry', furious: 'angry', '生气': 'angry',
}
export function normalizeEmotion(value: string): Emotion | undefined { return aliases[value.trim().toLowerCase()] }
