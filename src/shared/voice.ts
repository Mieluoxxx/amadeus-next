import type { Activity } from './character.ts'
import type { AlignmentChunk, PresentedText } from './presentation.ts'

export type TurnKey = { sessionId: string; turnId: string; generation: number }
export type Calibration = { mouthGain: number; silenceThreshold: number; syncOffsetMs: number }
export type FishDiagnostic = {
  provider: 'fish'
  phase: 'configuration' | 'handshake' | 'synthesis' | 'completion'
  code: string
  httpStatus?: number
  networkCode?: string
  closeCode?: number
  retryAfterSeconds?: number
  event?: 'start' | 'text' | 'stop' | 'audio' | 'finish' | 'error'
  detail?: string
}
export type VoiceEvent = TurnKey & (
  | { type: 'begin'; speech: boolean; calibration: Calibration }
  | { type: 'calibration'; calibration: Calibration }
  | { type: 'activity'; activity: Activity }
  | { type: 'text'; value: PresentedText }
  | { type: 'audio'; pcm: Uint8Array; alignment: AlignmentChunk | null }
  | { type: 'input-ended' }
  | { type: 'reset' }
  | { type: 'error'; error: string; diagnostic?: FishDiagnostic }
)
export type PlaybackEvent = TurnKey & { type: 'playing' | 'buffering' | 'ended' | 'error'; error?: string }
export type SceneInitialization = { character: { renderer: 'emote'; model: 'kurisu_ab_white' }; scene: Record<string, unknown> }
export type ConversationIdleEvent = { type: 'conversation-idle'; active: boolean }
export function sameTurn(a: TurnKey | null, b: TurnKey): boolean {
  return !!a && a.generation === b.generation && a.sessionId === b.sessionId && a.turnId === b.turnId
}
export function isTurnKey(value: unknown): value is TurnKey {
  if (!value || typeof value !== 'object') return false
  const key = value as TurnKey
  return typeof key.sessionId === 'string' && typeof key.turnId === 'string' && Number.isSafeInteger(key.generation) && key.generation >= 0
}
