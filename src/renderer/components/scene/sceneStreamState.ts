/**
 * Pure stream-state helpers for the scene conversation.
 *
 * These encode behaviours the chat page already had and the scene must not
 * lose: an interrupted turn stops accepting the rest of its stream, an
 * observer note is appended once per decision, and a wake-origin recognition is
 * an already-submitted utterance rather than a draft the user still has to send.
 * Keeping them pure makes the rules testable without a live backend.
 */

export type SceneDraftOutcome = {
  /** Text to put in the draft box, or `null` to leave the draft untouched. */
  draft: string | null
  /** True when the utterance was already sent by the wake pipeline. */
  alreadySubmitted: boolean
}

/**
 * How a final ASR transcript joins the conversation.
 *
 * - `wake`: the wake pipeline already submitted the utterance, so it becomes a
 *   user message and must NOT also sit in the draft waiting to be re-sent.
 * - `vn_player`: not part of the chat conversation at all.
 * - anything else: the user's own speech, appended to the draft for review.
 */
export function asrDraftOutcome(
  source: string,
  text: string,
  currentDraft: string,
): SceneDraftOutcome {
  const speech = text.trim()
  if (!speech) return { draft: null, alreadySubmitted: false }
  if (source === 'vn_player') return { draft: null, alreadySubmitted: false }
  if (source === 'wake') return { draft: currentDraft, alreadySubmitted: true }
  return {
    draft: currentDraft ? `${currentDraft} ${speech}` : speech,
    alreadySubmitted: false,
  }
}

/** True when a streaming/completion event belongs to a turn the user stopped. */
export function isStaleTurn(turnId: string, interrupted: ReadonlySet<string>): boolean {
  return Boolean(turnId) && interrupted.has(turnId)
}

/**
 * Records the turn ids that must be ignored from now on. The active turn is
 * included because an interrupt without a turn id still has to silence the
 * stream that was running.
 */
export function interruptedTurns(
  eventTurnId: string,
  activeTurnId: string,
  previous: ReadonlySet<string>,
): Set<string> {
  const next = new Set(previous)
  // An explicit id is authoritative. Only an interrupt without an id falls
  // back to the currently active turn; adding both would let an old interrupt
  // silence a newer turn.
  const target = eventTurnId || activeTurnId
  if (target) next.add(target)
  return next
}

export type SceneObserverNote = {
  turnId: string
  text: string
  identity: string
}

/**
 * Observer decisions only enter the main conversation when the backend says so,
 * and only for the session currently on screen. A repeated decision with the
 * same identity is the same note, not a second one.
 */
export function observerNote(
  params: Record<string, unknown>,
  activeSessionId: string,
  seen: ReadonlySet<string>,
): SceneObserverNote | null {
  if (params.append_to_main_chat !== true) return null
  const sessionId = String(params.session_id ?? '')
  if (!sessionId || sessionId !== activeSessionId) return null
  const text = String(params.main_chat_entry ?? '').trim()
  if (!text) return null
  const identity = String(
    params.message_id || params.attempt_id || params.run_id || params.work_item_id || '',
  )
  if (!identity) return null
  const action = String(params.action || 'update')
  const noteCount = String(params.note_count || '')
  const noteIdentity = `${identity}:${action}:${noteCount}`
  if (seen.has(noteIdentity)) return null
  return { turnId: `work-observer:${noteIdentity}`, text, identity: noteIdentity }
}

/**
 * Identity of a session payload that may be applied. A stale `session.load`
 * response must not overwrite the messages of a session the user has already
 * switched away from.
 */
export function mayApplySession(
  requestedId: string,
  activeId: string,
  failed: boolean,
): boolean {
  if (failed) return false
  if (!requestedId) return true
  return requestedId === activeId
}
