/**
 * Applying saved startup values to the running backend.
 *
 * Startup values (API keys, base URLs, models) are read by the backend process
 * when it spawns, so a save only takes effect after a restart. Two decisions
 * here are easy to get wrong, so they live outside the component:
 *
 * - Which provider switches need a restart at all, and
 * - how a burst of saves collapses into one restart.
 */

export type ProviderCredentialDecision = 'live' | 'restart' | 'needs_key'

/**
 * What to do after Main Chat's provider was switched in the GUI.
 *
 * The switch itself is already live, so nothing is needed when the running
 * process holds that provider's credential. A restart only helps when a
 * credential is stored but missing from this process -- the backend reads the
 * store when it spawns. Restarting for a provider nobody configured would be
 * pure disruption, so that case is reported instead.
 */
export function providerCredentialDecision(input: {
  /** Desktop-store secret backing this provider, when it has exactly one. */
  secretKey?: string
  /** The running backend's live config for this provider. */
  configuredInProcess: boolean
  /** Whether the desktop store holds that secret. */
  storedSecret: boolean
}): ProviderCredentialDecision {
  if (!input.secretKey || input.configuredInProcess) return 'live'
  return input.storedSecret ? 'restart' : 'needs_key'
}

export interface RestartScheduler {
  schedule: () => void
  cancel: () => void
}

/**
 * Collapse a burst of saves into one restart.
 *
 * A connection card saves field by field, and each save would otherwise
 * restart the backend on its own; the last save wins because the backend reads
 * the store when it spawns, so one restart applies every field.
 */
export function createRestartScheduler(
  restart: () => void | Promise<void>,
  delayMs: number,
): RestartScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void restart()
      }, delayMs)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
