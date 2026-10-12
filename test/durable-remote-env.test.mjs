import assert from 'node:assert/strict'
import { deepEqual as looseDeepEqual } from 'node:assert'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as ctx, withCancel } from '@earendil-works/chord/context'
import { createEnvConformance } from '@earendil-works/pi-durable/testing'
import { RemoteConnection, RemoteExecutionEnv } from '../src/main/durable/remote/client.ts'
import { serveRunner } from '../src/main/durable/remote/runner.ts'

/** 回环：两条 PassThrough 当作 ssh 的 stdin / stdout。 */
function loopback() {
  const toRunner = new PassThrough()
  const fromRunner = new PassThrough()
  const served = serveRunner({ input: toRunner, output: fromRunner, log: () => {} })
  const connection = new RemoteConnection(fromRunner, toRunner)
  // 模拟链路断开：两个方向同时结束，runner 收到 EOF 后收尾。
  const cut = () => { toRunner.end(); fromRunner.end() }
  return { connection, served, cut }
}

// Jest 的 toEqual / toMatchObject 语义：忽略值为 undefined 的属性，不比较类型（Buffer 与 Uint8Array 视为相同）。
const strip = value => {
  if (Array.isArray(value)) return value.map(strip)
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof Error)) {
    return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined).map(([key, each]) => [key, strip(each)]))
  }
  return value
}

function partial(actual, expected, at = '$') {
  if (expected === null || typeof expected !== 'object' || ArrayBuffer.isView(expected)) return looseDeepEqual(strip(actual), strip(expected), at)
  assert.ok(actual !== null && typeof actual === 'object', `${at} is not an object`)
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${at} is not an array`)
    assert.equal(actual.length, expected.length, `${at} length`)
  }
  for (const [key, value] of Object.entries(expected)) partial(actual[key], value, `${at}.${key}`)
}

const assertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.equal(actual, expected),
  deepEqual: (actual, expected) => looseDeepEqual(strip(actual), strip(expected)),
  partialDeepEqual: (actual, expected) => partial(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: async (operation, messageIncludes) => {
    await assert.rejects(operation, error => String(error?.message ?? error).includes(messageIncludes))
  },
}

const shared = loopback()
test.after(() => shared.cut())

const withEnv = async use => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-remote-'))
  try {
    await use(new RemoteExecutionEnv({ name: 'loop', connection: shared.connection, cwd: dir }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const each of createEnvConformance({ assertions, withEnv })) {
  test(`conformance: ${each.name}`, { timeout: each.timeoutMs ?? 20_000 }, () => each.run())
}

test('hello reports the runner platform', async () => {
  const hello = await shared.connection.hello
  assert.equal(hello.protocol, 1)
  assert.equal(hello.os, process.platform)
  assert.equal(hello.home, os.homedir())
})

test('disconnect fails the running command, kills it and never replays', async () => {
  const { connection, served, cut } = loopback()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-remote-'))
  try {
    const env = new RemoteExecutionEnv({ name: 'loop', connection, cwd: dir })
    let pid
    const running = env.exec('echo $$; sleep 30', { onOutput: text => { pid ??= Number(text.trim().split('\n')[0]) } }, ctx)
    while (pid === undefined) await sleep(10)
    assert.doesNotThrow(() => process.kill(pid, 0))
    cut()
    const result = await running
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unknown')
    assert.match(result.error.message, /not reachable/)
    await served
    // runner 收尾时 cleanup 杀掉进程树；给内核一点时间回收。
    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await sleep(20) } catch { alive = false }
    }
    assert.equal(alive, false, 'remote command must be killed on disconnect')
    // 之后的调用立即失败，不会排队等待也不会在新连接上重放。
    const after = await env.writeFile('x.txt', 'late', ctx)
    assert.equal(after.ok, false)
    assert.equal(after.error.code, 'unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cancelling the caller context aborts the remote command', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-remote-'))
  try {
    const env = new RemoteExecutionEnv({ name: 'loop', connection: shared.connection, cwd: dir })
    const { context, cancel } = withCancel(ctx)
    const started = Date.now()
    const running = env.exec('sleep 30', undefined, context)
    await sleep(100)
    cancel()
    const result = await running
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'aborted')
    assert.ok(Date.now() - started < 5_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a throwing output callback ends the command with callback_error', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-remote-'))
  try {
    const env = new RemoteExecutionEnv({ name: 'loop', connection: shared.connection, cwd: dir })
    const result = await env.exec('echo hi; sleep 30', { onOutput: () => { throw new Error('boom') } }, ctx)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'callback_error')
    assert.equal(result.error.message, 'boom')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
