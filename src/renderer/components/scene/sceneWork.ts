/**
 * Derived signals for the Amadeus scene shell.
 *
 * Pure helpers over the existing chat / work activity projections so the shell
 * never forks its own state model: the scene reads the same
 * `ChatWorkActivityRun` records the chat page uses.
 *
 * Completion wording matters here. `chatWorkActivity` tracks a Provider
 * *attempt*; WorkItem completion and acceptance are separate (see
 * `work/workState.ts`). Nothing in this module may report attempt success as
 * task acceptance.
 */

import type { ChatWorkActivityEntry, ChatWorkActivityRun } from '../chatWorkActivity'

export type SceneNoticeTone = 'attention' | 'error'

export type SceneNotice = {
  key: string
  tone: SceneNoticeTone
  /** What the notice is about; the shell localizes the wording. */
  kind: 'permission' | 'failure'
  detail: string
}

export type ScenePermission = {
  key: string
  /** The authoritative permission request id, kept so the workflow can resolve it. */
  requestId: string
  title: string
  detail: string
}

export function isPermissionEntry(entry: ChatWorkActivityEntry): boolean {
  return entry.kind === 'permission' || /permission|approval|authorize|授权/i.test(entry.title)
}

/** Entries replaced by a resolution leave the entry list, so this only sees open ones. */
export function pendingPermissions(runs: ChatWorkActivityRun[]): ScenePermission[] {
  const permissions: ScenePermission[] = []
  for (const run of runs) {
    for (const entry of run.entries) {
      if (!isPermissionEntry(entry) || entry.state !== 'attention') continue
      permissions.push({
        key: `${run.runId}:${entry.id}`,
        requestId: entry.id.startsWith('permission:') ? entry.id.slice('permission:'.length) : entry.id,
        title: entry.title,
        detail: entry.detail || runLabel(run),
      })
    }
  }
  return permissions
}

/**
 * Work attempts that ended successfully *while this window was watching*.
 * The caller supplies what it has already announced; nothing here reports
 * WorkItem completion or acceptance.
 */
export function runsToAnnounce(
  completions: Array<{ runId: string; task: string; provider: string }>,
  announced: ReadonlySet<string>,
): Array<{ runId: string; task: string; provider: string }> {
  return completions.filter(completion => !announced.has(completion.runId))
}

/**
 * In-app notices for the lightweight status area. Permission requests and
 * failures stay discoverable while the transcript and work log are collapsed;
 * this never replaces the approval flow.
 */
export function sceneNotices(runs: ChatWorkActivityRun[]): SceneNotice[] {
  const notices: SceneNotice[] = []
  for (const permission of pendingPermissions(runs)) {
    notices.push({
      key: permission.key,
      tone: 'attention',
      kind: 'permission',
      detail: permission.title,
    })
  }
  for (const run of runs) {
    if (run.status !== 'failed') continue
    const failure = run.entries.find(entry => entry.state === 'failed')
    notices.push({
      key: `${run.runId}:failed`,
      tone: 'error',
      kind: 'failure',
      detail: failure?.detail || failure?.title || runLabel(run),
    })
  }
  return notices
}

/** Compact label for a work activity run row. */
export function runLabel(run: Pick<ChatWorkActivityRun, 'task' | 'provider'>): string {
  const task = (run.task || '').replace(/\s+/g, ' ').trim()
  return task || run.provider
}
