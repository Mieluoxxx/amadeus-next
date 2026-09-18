import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRestartScheduler,
  providerCredentialDecision,
} from '../src/renderer/components/settingsStartupApply.ts'

test('a stored credential the process is missing asks for a restart', () => {
  // The reported bug: the key was saved after the backend had already spawned.
  assert.equal(
    providerCredentialDecision({
      secretKey: 'OPENAI_API_KEY',
      configuredInProcess: false,
      storedSecret: true,
    }),
    'restart',
  )
})

test('a provider the running process already holds needs nothing', () => {
  // The switch itself is applied live by system.set_config.
  assert.equal(
    providerCredentialDecision({
      secretKey: 'OPENAI_API_KEY',
      configuredInProcess: true,
      storedSecret: true,
    }),
    'live',
  )
  // Stored nowhere, yet present in the process: environment-provided.
  assert.equal(
    providerCredentialDecision({
      secretKey: 'OPENAI_API_KEY',
      configuredInProcess: true,
      storedSecret: false,
    }),
    'live',
  )
})

test('an unconfigured provider reports a missing key instead of restarting', () => {
  // Restarting could not conjure a credential nobody entered, so it would be
  // pure disruption; the user needs to be told to enter one.
  assert.equal(
    providerCredentialDecision({
      secretKey: 'GEMINI_API_KEY',
      configuredInProcess: false,
      storedSecret: false,
    }),
    'needs_key',
  )
})

test('providers without a single store secret are left to their live switch', () => {
  for (const secretKey of [undefined, '']) {
    assert.equal(
      providerCredentialDecision({
        secretKey,
        configuredInProcess: false,
        storedSecret: false,
      }),
      'live',
      'bedrock and local must not be classified as needing a credential',
    )
  }
})

test('a burst of saves collapses into one restart', async () => {
  let restarts = 0
  const scheduler = createRestartScheduler(() => { restarts += 1 }, 5)

  scheduler.schedule()
  scheduler.schedule()
  scheduler.schedule()
  assert.equal(restarts, 0, 'nothing restarts before the burst settles')

  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(restarts, 1, 'three saves must not produce three restarts')
})

test('a save arriving after the restart starts its own', async () => {
  let restarts = 0
  const scheduler = createRestartScheduler(() => { restarts += 1 }, 5)

  scheduler.schedule()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(restarts, 1)

  // The backend reads the store when it spawns, so a save that lands after the
  // spawn would otherwise be silently left out of the running process.
  scheduler.schedule()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(restarts, 2)
})

test('a cancelled burst never restarts', async () => {
  let restarts = 0
  const scheduler = createRestartScheduler(() => { restarts += 1 }, 5)

  scheduler.schedule()
  scheduler.cancel()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(restarts, 0)
})
