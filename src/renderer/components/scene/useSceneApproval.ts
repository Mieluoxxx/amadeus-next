/**
 * Authoritative approval handling for the Amadeus scene shell.
 *
 * The scene must not invent its own approval flow: permission decisions are made
 * by the Work ledger, which requires the exact work item, attempt, projection
 * revision and request id it issued, and only accepts decisions the immutable
 * request actually offered. This hook reads that projection and sends the
 * ledger's own `work.permission.resolve`, so an in-window click is the same
 * decision a click in the Work surface would make.
 *
 * Two different things are surfaced and must not be conflated:
 *   - `attention` (a selection request) is the user picking an entity;
 *   - `pendingPermissionRequestId` is an authorization to run something.
 * Only the latter becomes an allow/deny action here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SceneSessionChange } from './useSceneSession'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

export const SCENE_WORK_SURFACE = 'wallpaper.slice'

export type SceneAuthorizationKind = 'permission' | 'export_recovery'

export type SceneAuthorization = {
  key: string
  kind: SceneAuthorizationKind
  workItemId: string
  attemptId: string
  requestId: string
  revision: string
  attention: string
  /** True only when the ledger's request actually offered that decision. */
  canAllow: boolean
  canDeny: boolean
  /** Why the ledger is asking, and what for. Empty when the projection omits it. */
  reason: string
  capability: string
  action: string
  scope: string[]
  surface: string
  /** The snapshot was complete enough to make a decision. */
  resolvable: boolean
  /** Decisions the ledger will accept. */
  allowAction: 'allow_once' | 'retry_export'
  denyAction: 'deny' | 'abandon_export'
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
 * Reads the selected work item out of a `work.list` / `work.updated` payload.
 *
 * The ledger's immutable request defines which decisions exist: a deny-only
 * request must never be shown an Allow button. `options` on the projection is
 * that contract; when it is absent the decision is reported as unresolvable
 * rather than guessed.
 */
export function authorizationFromSnapshot(payload: unknown): SceneAuthorization | null {
  const envelope = record(payload)
  const work = record(envelope.work && typeof envelope.work === 'object' ? envelope.work : envelope.projection ?? envelope)
  const selected = record(work.selected)
  const surface = text(work.surface || envelope.surface)
  if (surface && surface !== SCENE_WORK_SURFACE) return null
  const revision = text(work.revision)
  const workItemId = text(work.selectedWorkItemId || selected.id)
  const attemptId = text(selected.attemptId)
  if (!revision || !workItemId || !attemptId) return null

  const rawOptions = Array.isArray(selected.pendingPermissionOptions)
    ? selected.pendingPermissionOptions.map(text).filter(Boolean)
    : null

  const permissionRequestId = text(selected.pendingPermissionRequestId)
  if (permissionRequestId) {
    // An empty list is not a deny-only contract (that would contain "deny");
    // it is an incomplete legacy projection and must stay non-actionable.
    const offered = rawOptions === null || rawOptions.length === 0 ? null : new Set(rawOptions)
    return {
      key: `${workItemId}:${attemptId}:permission:${permissionRequestId}`,
      kind: 'permission',
      workItemId,
      attemptId,
      requestId: permissionRequestId,
      revision,
      attention: text(selected.attention),
      // Missing options are an incomplete contract, not permission to guess.
      // The card remains visible with details, but no decision can be submitted
      // until the ledger returns its immutable options.
      canAllow: offered !== null
        && (offered.has('allow_once') || offered.has('allow') || offered.has('approve_once')),
      canDeny: offered !== null && (offered.has('deny') || offered.has('reject')),
      reason: text(selected.pendingPermissionReason),
      capability: text(selected.pendingPermissionCapability),
      action: text(selected.pendingPermissionAction),
      scope: Array.isArray(selected.pendingPermissionScope)
        ? selected.pendingPermissionScope.map(text).filter(Boolean).slice(0, 8)
        : [],
      surface: surface || SCENE_WORK_SURFACE,
      resolvable: offered !== null,
      allowAction: 'allow_once',
      denyAction: 'deny',
    }
  }

  const exportRequestId = text(selected.recoverableExportRequestId)
  if (exportRequestId) {
    return {
      key: `${workItemId}:${attemptId}:export:${exportRequestId}`,
      kind: 'export_recovery',
      workItemId,
      attemptId,
      requestId: exportRequestId,
      revision,
      attention: text(selected.attention),
      canAllow: true,
      canDeny: true,
      reason: text(selected.recoverableExportReason),
      capability: '',
      action: '',
      scope: [],
      surface: surface || SCENE_WORK_SURFACE,
      resolvable: true,
      allowAction: 'retry_export',
      denyAction: 'abandon_export',
    }
  }
  return null
}

export function authorizationsFromSnapshot(payload: unknown): SceneAuthorization[] {
  const envelope = record(payload)
  const work = record(envelope.work && typeof envelope.work === 'object' ? envelope.work : envelope.projection ?? envelope)
  const surface = text(work.surface || envelope.surface)
  if (surface && surface !== SCENE_WORK_SURFACE) return []
  const revision = text(work.revision)
  const items = Array.isArray(work.items) ? work.items : []
  const candidates = [
    work.selected && typeof work.selected === 'object' ? work.selected : null,
    ...items,
  ]
  const seen = new Set<string>()
  return candidates.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const value = record(item)
    const id = text(value.id || value.workItemId || value.work_item_id)
    if (!id) return []
    const authorization = authorizationFromSnapshot({
      work: {
        ...work,
        revision,
        selectedWorkItemId: id,
        selected: value,
      },
    })
    if (!authorization || seen.has(authorization.key)) return []
    seen.add(authorization.key)
    return [authorization]
  })
}

/** Request payload for the ledger; exported so the contract is testable. */
export function authorizationRequest(
  authorization: SceneAuthorization,
  allow: boolean,
): Record<string, unknown> {
  return {
    work_item_id: authorization.workItemId,
    attempt_id: authorization.attemptId,
    revision: authorization.revision,
    permission_request_id: authorization.requestId,
    action: allow ? authorization.allowAction : authorization.denyAction,
  }
}

export function useSceneApproval({
  send,
  subscribe,
  connected,
  sessionChange,
}: {
  send: SendFn
  subscribe: SubscribeFn
  connected: boolean
  sessionChange?: SceneSessionChange | null
}) {
  const [authorization, setAuthorization] = useState<SceneAuthorization | null>(null)
  const [resolving, setResolving] = useState('')
  const [error, setError] = useState('')
  const [authorizations, setAuthorizations] = useState<SceneAuthorization[]>([])
  const currentKeyRef = useRef('')
  const currentRevisionRef = useRef('')
  const errorKeyRef = useRef('')
  const projectionVersionRef = useRef(0)
  const refreshRequestRef = useRef(0)

  const apply = useCallback((payload: unknown) => {
    const envelope = record(payload)
    const candidate = envelope.work && typeof envelope.work === 'object'
      ? envelope.work
      : envelope.projection && typeof envelope.projection === 'object'
        ? envelope.projection
        : null
    // A malformed/unrelated event must not clear the current request. A valid
    // projection with no pending request is different: that is a resolution.
    const work = record(candidate)
    if (!candidate || typeof work.revision !== 'string') return null
    const surface = text(work.surface || envelope.surface)
    if (surface && surface !== SCENE_WORK_SURFACE) return null
    const all = authorizationsFromSnapshot(payload)
    const next = authorizationFromSnapshot(payload)
    projectionVersionRef.current += 1
    const nextKey = next ? next.key : ''
    // A resolution arrives as a snapshot without the request; clear then. An
    // unrelated snapshot must not drop a still-pending request.
    const previousKey = currentKeyRef.current
    const previousRevision = currentRevisionRef.current
    currentKeyRef.current = nextKey
    currentRevisionRef.current = text(work.revision)
    if (previousKey !== nextKey || previousRevision !== currentRevisionRef.current) {
      if (nextKey || !errorKeyRef.current) {
        setError('')
        errorKeyRef.current = ''
      }
      setResolving(previous => previous && previous !== nextKey ? '' : previous)
    }
    setAuthorization(next)
    setAuthorizations(all)
    return next
  }, [])

  const refresh = useCallback(async () => {
    const request = ++refreshRequestRef.current
    const version = projectionVersionRef.current
    try {
      const response = await send('work.list', { surface: SCENE_WORK_SURFACE })
      if (response.ok === false) {
        if (request === refreshRequestRef.current && currentKeyRef.current) {
          setError(String(response.error || '授权状态刷新失败'))
        }
        return
      }
      if (request !== refreshRequestRef.current || version !== projectionVersionRef.current) return
      apply(response)
    } catch (failure) {
      // The ledger may not be up yet; keep the existing card and expose the
      // refresh failure instead of silently making the user guess.
      if (request === refreshRequestRef.current && currentKeyRef.current) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
  }, [send, apply])

  const resetAuthorization = useCallback(() => {
    currentKeyRef.current = ''
    currentRevisionRef.current = ''
    refreshRequestRef.current += 1
    projectionVersionRef.current += 1
    setAuthorization(null)
    setAuthorizations([])
    setResolving('')
    setError('')
    errorKeyRef.current = ''
  }, [])

  useEffect(() => {
    if (!connected) {
      resetAuthorization()
      return
    }
    void refresh()
    const unsubscribeWork = subscribe('work.updated', payload => apply(payload))
    return () => {
      unsubscribeWork()
    }
  }, [connected, refresh, subscribe, apply, resetAuthorization])

  useEffect(() => {
    if (!connected || !sessionChange) return
    resetAuthorization()
    void refresh()
  }, [connected, refresh, resetAuthorization, sessionChange?.sequence])

  const resolve = useCallback(async (allow: boolean) => {
    const target = authorization
    if (!target || resolving) return
    setResolving(target.key)
    setError('')
    if (!connected || !target.resolvable) {
      setError('当前授权信息不完整，请刷新后再试。')
      setResolving('')
      return
    }
    if ((allow && !target.canAllow) || (!allow && !target.canDeny)) {
      setError('该请求不提供此决策。')
      setResolving('')
      return
    }
    const version = projectionVersionRef.current
    try {
      const response = await send('work.permission.resolve', {
        ...authorizationRequest(target, allow),
        surface: SCENE_WORK_SURFACE,
      })
      if (response.ok !== true) {
        throw new Error(String(response.error || '授权未能提交'))
      }
      // The response carries the new projection; adopt it so the card clears
      // (or stays, if the ledger rejected the decision).
      // A live work.updated that arrived while the request was in flight is
      // newer than this response; never overwrite it with an older projection.
      if (
        projectionVersionRef.current === version
        && currentKeyRef.current === target.key
        && currentRevisionRef.current === target.revision
      ) {
        apply(response)
      } else if (connected) {
        void refresh()
      }
    } catch (failure) {
      if (
        connected
        && (currentKeyRef.current === target.key || currentKeyRef.current === '')
        && (currentKeyRef.current === '' || currentRevisionRef.current === target.revision)
      ) {
        errorKeyRef.current = target.key
        setError(failure instanceof Error ? failure.message : String(failure))
        void refresh()
      }
    } finally {
      setResolving(previous => previous === target.key ? '' : previous)
    }
  }, [authorization, resolving, send, apply, refresh])

  return useMemo(() => ({
    authorization,
    authorizations,
    resolving,
    error,
    refresh: () => { void refresh() },
    allow: () => resolve(true),
    deny: () => resolve(false),
  }), [authorization, authorizations, resolving, error, refresh, resolve])
}
