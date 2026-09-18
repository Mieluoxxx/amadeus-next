export type Activity = 'idle' | 'listening' | 'thinking' | 'tool'
export type Emotion = 'neutral' | 'thinking' | 'serious' | 'smile' | 'sad' | 'shy' | 'surprise' | 'angry'
export type Clip = { frames: string[]; frameIntervalMs: number; loopMode: 'loop' | 'once_then_hold' }
export type CharacterNode = { label: string; kind: 'ambient' | 'entry' | 'speech' | 'post'; behavior?: string }
export type CharacterDefinition = {
  root: string
  nodes: Record<string, CharacterNode>
  edges: Record<string, { to: string; weight: number }[]>
  clips: Record<string, Clip>
  mouths: Record<string, Record<string, unknown>>
  entries: Record<string, string[]>
  exits: Record<string, string>
  closedEyeEligible: string[]
  diagnostics: string[]
}

// One character-specific description; the state machine only sees node metadata.
export const performances: Record<string, { entry: string[]; speech: string[]; post?: string }> = {
  neutral: { entry: ['speaking_short'], speech: ['speaking_short', 'speaking_med', 'speaking_long'] },
  serious: { entry: ['speaking_trans', 'thinking_to_serious'], speech: ['speaking_loop1', 'speaking_loop2'] },
  thinking: { entry: ['thinking_trans', 'thinking_to_key_point', 'serious_to_thinking'], speech: ['thinking_speaking1', 'thinking_speaking2', 'key_point_speaking'] },
  closedEye: { entry: ['closed_eye_trans'], speech: ['speaking_closed_eye_1', 'speaking_closed_eye_2'] },
  smile: { entry: ['trans_smile'], speech: ['smile_speaking'], post: 'smile' },
  sad: { entry: ['sad_trans'], speech: ['sad_speaking'], post: 'sad' },
  shy: { entry: ['shy_trans'], speech: ['shy_speaking1', 'shy_speaking2'] },
  surprise: { entry: ['surprise_trans'], speech: ['surprise_speaking'] },
  angry: { entry: ['angry_trans'], speech: ['angry_speaking'] },
}

const aliases: Record<string, Emotion> = {
  normal: 'neutral', neutral: 'neutral', happy: 'smile', smile: 'smile', '微笑': 'smile', '开心': 'smile',
  thinking: 'thinking', think: 'thinking', work: 'thinking', working: 'thinking', '思考': 'thinking',
  serious: 'serious', serious_speaking: 'serious', speaking_serious: 'serious', '严肃': 'serious',
  sad: 'sad', disappointed: 'sad', sadness: 'sad', '悲伤': 'sad', '失望': 'sad',
  shy: 'shy', blush: 'shy', '害羞': 'shy', surprise: 'surprise', surprised: 'surprise', '惊讶': 'surprise',
  angry: 'angry', mad: 'angry', furious: 'angry', '生气': 'angry',
}
export function normalizeEmotion(value: string): Emotion | undefined { return aliases[value.trim().toLowerCase()] }

export type CharacterState = {
  node: string
  activity: Activity
  emotion: Emotion
  playback: 'quiet' | 'waiting' | 'playing' | 'buffering'
  phase: 'active' | 'waiting' | 'holding' | 'post'
  route: string[]
  holdUntil: number
  exit: string
}
export type CharacterEvent =
  | { type: 'activity'; activity: Activity; random: number }
  | { type: 'cue'; emotion: Emotion; random: number }
  | { type: 'playback'; status: 'waiting' | 'playing' | 'buffering' | 'ended'; now: number; random?: number }
  | { type: 'cycle'; node: string; random: number }
  | { type: 'tick'; now: number; random: number }
  | { type: 'reset' }
export type CharacterEffect = { type: 'play'; label: string } | { type: 'hold'; closed: boolean } | { type: 'speaking'; value: boolean }

export function initialCharacterState(definition: CharacterDefinition): CharacterState {
  return { node: definition.root, activity: 'idle', emotion: 'neutral', playback: 'quiet', phase: 'active', route: [], holdUntil: 0, exit: '' }
}

function weightedNext(definition: CharacterDefinition, node: string, random: number): string {
  const edges = (definition.edges[node] || []).filter(edge => edge.weight > 0)
  let value = Math.min(0.999999, Math.max(0, random)) * edges.reduce((sum, edge) => sum + edge.weight, 0)
  for (const edge of edges) { value -= edge.weight; if (value < 0) return edge.to }
  return node
}

function routeTo(definition: CharacterDefinition, start: string, target: string): string[] {
  if (start === target) return [target]
  const queue = [{ node: start, route: [] as string[] }]
  const seen = new Set([start])
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    for (const edge of definition.edges[current.node] || []) {
      if (edge.weight === 0 && current.node !== start) continue
      const route = [...current.route, edge.to]
      if (edge.to === target) return route
      if (!seen.has(edge.to)) { seen.add(edge.to); queue.push({ node: edge.to, route }) }
    }
  }
  return [target] // Authored manual expressions may be entered from any posture.
}

/** Pure graph decision. The caller supplies time and randomness; only the driver performs effects. */
export function transition(previous: CharacterState, event: CharacterEvent, definition: CharacterDefinition): { state: CharacterState; effects: CharacterEffect[] } {
  let state = { ...previous, route: [...previous.route] }
  const effects: CharacterEffect[] = []
  const play = (node: string) => {
    if (!definition.nodes[node] || !definition.clips[definition.nodes[node].label]) node = definition.root
    state.node = node
    state.phase = definition.nodes[node]?.kind === 'post' ? 'post' : 'active'
    state.holdUntil = 0
    effects.push({ type: 'play', label: definition.nodes[node].label })
  }
  const enter = (behavior: string, random: number) => {
    let entries = definition.entries[behavior] || []
    if (behavior === 'thinking') entries = [definition.entries.serious?.[0], entries[0]].filter(Boolean)
    const target = entries[Math.min(entries.length - 1, Math.floor(random * entries.length))] || definition.root
    state.route = routeTo(definition, state.node, target)
    play(state.route.shift() || target)
  }
  const base = (random: number) => {
    state.route = []
    state.emotion = 'neutral'
    if (state.activity === 'thinking' || state.activity === 'tool') enter('thinking', random)
    else play(definition.root)
  }
  if (event.type === 'reset') {
    state = initialCharacterState(definition)
    effects.push({ type: 'speaking', value: false })
    play(definition.root)
  } else if (event.type === 'activity') {
    if (state.activity === event.activity) return { state: previous, effects }
    state.activity = event.activity
    if ((state.playback === 'quiet' || (state.playback === 'waiting' && event.activity !== 'idle')) && state.phase !== 'holding' && state.phase !== 'post') base(event.random)
  } else if (event.type === 'cue') {
    state.emotion = event.emotion
    enter(event.emotion, event.random)
  } else if (event.type === 'playback') {
    if (event.status === 'waiting') {
      state.playback = 'waiting'
    } else if (event.status === 'ended') {
      if (state.playback === 'quiet') return { state: previous, effects }
      if (state.playback === 'waiting') {
        state.playback = 'quiet'
        base(event.random ?? 0)
        return { state, effects }
      }
      state.playback = 'quiet'
      state.route = []
      state.phase = 'holding'
      state.holdUntil = event.now + 1000
      state.exit = definition.exits[definition.nodes[state.node]?.behavior || state.emotion] || ''
      effects.push({ type: 'speaking', value: false }, { type: 'hold', closed: true })
    } else {
      const started = state.playback === 'quiet' || state.playback === 'waiting'
      state.playback = event.status
      // Buffer starvation closes the mouth in the audio driver, without ending this performance.
      if (started) {
        effects.push({ type: 'speaking', value: true })
        if (state.phase === 'waiting') play(weightedNext(definition, state.node, event.random ?? 0))
        else if (state.phase === 'holding' || definition.nodes[state.node]?.kind === 'ambient' || definition.nodes[state.node]?.kind === 'post') {
          const closedEye = state.emotion === 'neutral' && definition.closedEyeEligible.includes(state.node) && (event.random ?? 1) < 0.18
          enter(closedEye ? 'closedEye' : state.emotion, 0)
        }
      }
    }
  } else if (event.type === 'cycle') {
    if (event.node !== state.node || state.phase === 'holding' || state.phase === 'waiting') return { state: previous, effects }
    if (state.route.length) play(state.route.shift()!)
    else if (state.phase === 'post') base(event.random)
    else if (definition.nodes[state.node]?.kind === 'entry' && (state.playback === 'quiet' || state.playback === 'waiting')) {
      state.phase = 'waiting'
      effects.push({ type: 'hold', closed: false })
    } else play(weightedNext(definition, state.node, event.random))
  } else if (event.type === 'tick' && state.phase === 'holding' && event.now >= state.holdUntil) {
    if (state.exit && state.activity !== 'thinking' && state.activity !== 'tool') play(state.exit)
    else base(event.random)
  }
  return { state, effects }
}
