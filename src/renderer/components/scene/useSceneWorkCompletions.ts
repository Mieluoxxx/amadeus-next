/**
 * Work-item completion notices for the Amadeus scene shell.
 *
 * D7/P1 asks for a notice when **a task is finished**, so this reads the
 * authoritative Work ledger projection (`work.list` / `work.updated`) instead of
 * inferring from Provider events:
 *
 *   - `completion` is the completion *assessment* attached to the latest
 *     attempt (`server/work_read_model.py`); only the verified value `complete`
 *     counts. `partial` / `incomplete` / `unknown` are not a finished task.
 *   - the notice identity is `workItemId:attemptId`, so a re-run of the same
 *     task is a new completion while a replayed snapshot of the same attempt is
 *     the same one.
 *   - work items that are already complete when the projection first loads are
 *     history, not news: they are seeded into the seen-set without notifying.
 *
 * WorkItem acceptance (`state === 'accepted'`) is a separate decision the user
 * makes later and is deliberately not what this notices.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

export const COMPLETE_ASSESSMENT = 'complete'
export const SCENE_WORK_SURFACE = 'wallpaper.slice'

export type WorkCompletion = {
  key: string
  workItemId: string
  attemptId: string
  title: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

/**
 * Reads the items array out of a `work.list` / `work.updated` payload.
 *
 * `null` means the payload had no items array at all (malformed or a different
 * envelope), which is not the same as an empty projection: an empty projection
 * is a valid baseline and must initialize tracking.
 */
export function workItemsFromSnapshot(payload: unknown): Array<Record<string, unknown>> | null {
  const envelope = record(payload)
  const candidate = envelope.work && typeof envelope.work === 'object'
    ? envelope.work
    : envelope.projection ?? envelope
  const work = record(candidate)
  if (!Array.isArray(work.items)) return null
  return work.items.map(record)
}

export function workSurfaceFromSnapshot(payload: unknown): string | null {
  const envelope = record(payload)
  const candidate = envelope.work && typeof envelope.work === 'object'
    ? envelope.work
    : envelope.projection ?? envelope
  const work = record(candidate)
  return typeof (work.surface || envelope.surface) === 'string'
    ? String(work.surface || envelope.surface)
    : null
}

/** The completion identity of an item, or `null` when it is not a finished task. */
export function completionOf(item: Record<string, unknown>): WorkCompletion | null {
  if (text(item.completion) !== COMPLETE_ASSESSMENT) return null
  const workItemId = text(item.workItemId || item.id)
  const attemptId = text(item.attemptId)
  if (!workItemId || !attemptId) return null
  return {
    key: `${workItemId}:${attemptId}`,
    workItemId,
    attemptId,
    title: text(item.title || item.goal) || workItemId,
  }
}

/**
 * Splits a projection into completions that are news and completions that are
 * history. `seed` means "record these without telling the user".
 */
export function classifyCompletions(
  items: Array<Record<string, unknown>>,
  seen: ReadonlySet<string>,
  seed: boolean,
): { announce: WorkCompletion[]; remember: WorkCompletion[] } {
  const announce: WorkCompletion[] = []
  const remember: WorkCompletion[] = []
  for (const item of items) {
    const completion = completionOf(item)
    if (!completion || seen.has(completion.key)) continue
    if (seed) remember.push(completion)
    else announce.push(completion)
  }
  return { announce, remember }
}

export function useSceneWorkCompletions({
  send,
  subscribe,
  connected,
}: {
  send: SendFn
  subscribe: SubscribeFn
  connected: boolean
}) {
  const [announcements, setAnnouncements] = useState<WorkCompletion[]>([])
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set())
  const seenRef = useRef<Set<string>>(new Set())
  const loadedRef = useRef(false)

  const apply = useCallback((payload: unknown) => {
    const surface = workSurfaceFromSnapshot(payload)
    if (surface && surface !== SCENE_WORK_SURFACE) return
    const items = workItemsFromSnapshot(payload)
    // A malformed payload is ignored; an empty one is a real baseline.
    if (items === null) return
    const seeding = !loadedRef.current
    loadedRef.current = true
    const { announce, remember } = classifyCompletions(items, seenRef.current, seeding)
    for (const completion of remember) seenRef.current.add(completion.key)
    if (announce.length === 0) return
    for (const completion of announce) seenRef.current.add(completion.key)
    setAnnouncements(previous => [...previous, ...announce])
  }, [])

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    void (async () => {
      try {
        const response = await send('work.list', { surface: SCENE_WORK_SURFACE })
        if (!cancelled && response.ok !== false) apply(response)
      } catch {
        // The ledger may still be starting; the subscription delivers it later.
      }
    })()
    const unsubscribe = subscribe('work.updated', payload => apply(payload))
    return () => { cancelled = true; unsubscribe() }
  }, [connected, send, subscribe, apply])

  /**
   * Announcements not yet acknowledged. Acknowledgement is state, not a ref, so
   * a re-render cannot re-derive and re-dispatch an already-raised notice.
   */
  const pending = useMemo(
    () => announcements.filter(completion => !acknowledged.has(completion.key)),
    [announcements, acknowledged],
  )
  const markAnnounced = useCallback((key: string) => {
    setAcknowledged(previous => {
      if (previous.has(key)) return previous
      const next = new Set(previous)
      next.add(key)
      return next
    })
  }, [])

  return { announcements, pending, markAnnounced }
}
