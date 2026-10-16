import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, MemoryStorage, ROOT_CONVERSATION_ID, createRegistry } from '@earendil-works/pi-durable'
import { HandoffsDoc, OutboxDoc, createHandoffExtensions, initHandoffDocs } from '../src/main/durable/handoff/index.ts'
import { TargetPool } from '../src/main/durable/remote/pool.ts'
import { executionEnvs } from '../src/main/durable/remote/route.ts'
import { serveRunner } from '../src/main/durable/remote/runner.ts'

const MODEL = { provider: 'faux', modelId: 'faux-1' }

const toolNames = context => context.messages.flatMap(message => (message.role === 'system' ? (message.toolsAdded ?? []).map(tool => tool.name) : []))
const textOf = content => (typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join(''))
const lastUserText = context => textOf(context.messages.findLast(each => each.role === 'user')?.content)
const calling = (...toolCalls) => fauxAssistantMessage([fauxText('好。'), ...toolCalls], { stopReason: 'toolUse' })
const answer = text => fauxAssistantMessage(text)
const aborted = () => fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'Request was aborted' })

async function until(check, label, timeout = 8000) {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

/** 回环连接器：每次连接起一个进程内 runner；`cut` 模拟断网，`down` 之后连不上。 */
function loopbackConnector() {
  const state = { links: [], down: false, connects: 0 }
  const connector = async () => {
    state.connects += 1
    if (state.down) throw new Error('ssh: connect to host dev port 22: Connection refused')
    const toRunner = new PassThrough()
    const fromRunner = new PassThrough()
    void serveRunner({ input: toRunner, output: fromRunner, log: () => {} })
    const link = { input: fromRunner, output: toRunner, close: () => { toRunner.end(); fromRunner.end() } }
    state.links.push(link)
    return link
  }
  const cut = () => { for (const link of state.links) link.close() }
  return { connector, state, cut }
}

function remoteLayout() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'amadeus-remote-handoff-')))
  const workspace = path.join(base, 'remote-home', 'work')
  const project = path.join(workspace, 'demo')
  const taskRoot = path.join(base, 'userData', 'sessions', 's1', 'handoff')
  for (const dir of [project, taskRoot]) mkdirSync(dir, { recursive: true })
  return { base, workspace, project, taskRoot }
}

async function open({ dirs, pool, child, limits = {} }) {
  const faux = fauxProvider()
  const calls = { main: [], child: [] }
  const router = (context, options) => {
    if (toolNames(context).includes('handoff')) {
      calls.main.push(context)
      const last = context.messages.at(-1)
      if (last?.role === 'toolResult') return answer('<zh>好。</zh>')
      const match = lastUserText(context).match(/^DELEGATE (.*)$/s)
      return match ? calling(fauxToolCall('handoff', JSON.parse(match[1]))) : answer('嗯。')
    }
    calls.child.push(context)
    return child(context, options)
  }
  faux.setResponses(Array.from({ length: 200 }, () => router))
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  const extensions = createHandoffExtensions({ limits: { tickMs: 20, ...limits }, remote: pool })
  for (const extension of extensions) registry.install(extension)
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { extensions: [], progress: { partialIntervalMs: 5, outputIntervalMs: 5 }, retry: { enabled: false, maxRetries: 0 } },
      env: executionEnvs((target, cwd) => pool.env(target, cwd)),
    },
    ctx,
  )
  const root = await harness.root(ctx, {
    agent: { model: MODEL, extensions: [extensions[0]] },
    init: (tx, id) => initHandoffDocs(tx, id, { taskRoot: dirs.taskRoot }),
  })
  return { harness, root, extensions, calls, close: () => harness.close(ctx) }
}

const delegate = async (t, args) => (await (await t.root.submit({ type: 'input', content: `DELEGATE ${JSON.stringify(args)}` }, ctx)).wait(ctx))
const itemOf = async harness => (await harness.snapshot(HandoffsDoc, ROOT_CONVERSATION_ID, ctx))?.items.find(item => item.taskId === 't_01')
const reportOf = harness => until(async () => (await harness.snapshot(OutboxDoc, ROOT_CONVERSATION_ID, ctx)).pending.find(item => item.id === 't_01'), 'report of t_01')
const lastToolResult = context => context.messages.findLast(message => message.role === 'toolResult')
const handoffResult = t => textOf(lastToolResult(t.calls.main.at(-1))?.content)

/** 子对话脚本：按已收到的工具结果个数取第几步。 */
const script = (...steps) => (context, options) => {
  const index = context.messages.filter(message => message.role === 'toolResult').length
  return steps[Math.min(index, steps.length - 1)](context, options)
}

async function withRemote(run, options = {}) {
  const dirs = remoteLayout()
  const loop = loopbackConnector()
  const pool = new TargetPool({ targets: [{ name: 'dev', ssh: 'dev', workspace: dirs.workspace, node: 'node' }], connector: loop.connector, log: () => {}, waitMs: 2000, ...options })
  try {
    await run({ dirs, pool, loop })
  } finally {
    pool.close()
    rmSync(dirs.base, { recursive: true, force: true })
  }
}

test('without remote targets the handoff schema has no target or workdir and remote is not offered', async () => {
  const [main] = createHandoffExtensions({})
  const handoff = main.tools.find(tool => tool.name === 'handoff')
  assert.deepEqual(Object.keys(handoff.parameters.properties), ['kind', 'title', 'paths', 'brief'])
  assert.deepEqual(handoff.parameters.properties.kind.enum, ['research', 'files', 'task'])
  assert.doesNotMatch(handoff.description, /remote/)
})

test('with remote targets the schema offers the remote kind and names the machines', () => withRemote(async ({ pool }) => {
  const [main, ...kinds] = createHandoffExtensions({ remote: pool })
  const handoff = main.tools.find(tool => tool.name === 'handoff')
  assert.deepEqual(Object.keys(handoff.parameters.properties), ['kind', 'title', 'paths', 'target', 'workdir', 'brief'])
  assert.deepEqual(handoff.parameters.properties.kind.enum, ['research', 'files', 'task', 'remote'])
  assert.deepEqual(handoff.parameters.properties.target.enum, ['dev'])
  assert.match(handoff.parameters.properties.target.description, /dev \(default workdir .*work\)/)
  assert.match(handoff.description, /- remote: /)
  const remote = kinds.find(extension => extension.name === 'amadeus-remote')
  assert.deepEqual(remote.tools.map(tool => tool.name).sort(), ['bash', 'edit', 'read', 'report_progress', 'write'])
}))

test('a remote task runs its tools in the remote workdir, is pinned to its target and reports back', () => withRemote(async ({ dirs, pool }) => {
  const t = await open({
    dirs,
    pool,
    child: script(
      () => calling(fauxToolCall('bash', { command: 'pwd && echo built > made.txt' })),
      () => calling(fauxToolCall('read', { path: 'made.txt' })),
      () => answer('Done: wrote made.txt\nResult: built\nOpen issues: none'),
    ),
  })
  try {
    await delegate(t, { kind: 'remote', title: '远程构建', target: 'dev', workdir: dirs.project, brief: 'Build the demo project on the server and tell me the result.' })
    assert.match(handoffResult(t), /Accepted as t_01/)
    const item = await itemOf(t.harness)
    assert.equal(item.kind, 'remote')
    assert.equal(item.target, 'dev')
    assert.equal(item.cwd, dirs.project)
    assert.deepEqual(item.paths, [])
    const report = await reportOf(t.harness)
    assert.equal(report.status, 'done')
    assert.match(report.text, /Result: built/)
    assert.equal(readFileSync(path.join(dirs.project, 'made.txt'), 'utf8'), 'built\n')
    // 远程任务的 cwd 不在本机的任务目录里，Reporter 不该在本机建它。
    assert.equal(existsSync(path.join(dirs.taskRoot, 't_01')), false)
    const childContext = t.calls.child.at(-1)
    const results = childContext.messages.filter(message => message.role === 'toolResult').map(message => textOf(message.content))
    assert.match(results[0], new RegExp(dirs.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(results[1], /built/)
    const agent = await (await t.harness.conversation(item.child, ctx)).agent(ctx)
    assert.deepEqual(agent.extensions.map(extension => extension.name), ['amadeus-remote'])
    assert.equal(agent.cwd, dirs.project)
    assert.match(agent.instructions, /You work on a remote machine/)
    assert.ok(agent.instructions.endsWith(`Remote machine: "dev". Working directory: ${JSON.stringify(dirs.project)}.`))
  } finally {
    await t.close()
  }
}))

test('remote handoffs are refused without a target, outside the remote kind, or for a missing workdir', () => withRemote(async ({ dirs, pool }) => {
  const t = await open({ dirs, pool, child: () => answer('done') })
  try {
    await delegate(t, { kind: 'remote', title: 'x', brief: 'Build the demo project on the server.' })
    assert.match(handoffResult(t), /needs target, one of: dev/)
    await delegate(t, { kind: 'research', title: 'x', target: 'dev', brief: 'Look up the release notes please.' })
    assert.match(handoffResult(t), /only apply to the remote kind/)
    await delegate(t, { kind: 'remote', title: 'x', target: 'dev', workdir: path.join(dirs.workspace, 'nope'), brief: 'Build the demo project on the server.' })
    assert.match(handoffResult(t), /does not exist on dev/)
    assert.equal(await itemOf(t.harness), undefined)
  } finally {
    await t.close()
  }
}))

test('the default workdir is the target workspace', () => withRemote(async ({ dirs, pool }) => {
  const t = await open({ dirs, pool, child: () => answer('Done: nothing\nResult: ok\nOpen issues: none') })
  try {
    await delegate(t, { kind: 'remote', title: 'x', target: 'dev', brief: 'Look at the workspace and say what is there.' })
    assert.equal((await itemOf(t.harness)).cwd, dirs.workspace)
  } finally {
    await t.close()
  }
}))

test('an unreachable target is refused at acceptance', () => withRemote(async ({ dirs, pool, loop }) => {
  loop.state.down = true
  const t = await open({ dirs, pool, child: () => answer('done') })
  try {
    await delegate(t, { kind: 'remote', title: 'x', target: 'dev', brief: 'Build the demo project on the server.' })
    assert.match(handoffResult(t), /cannot be reached right now \(.*Connection refused/)
    assert.equal(await itemOf(t.harness), undefined)
  } finally {
    await t.close()
  }
}))

test('a target that stays offline fails the running task with target_offline', () => withRemote(async ({ dirs, pool, loop }) => {
  let started = false
  const t = await open({
    dirs,
    pool,
    limits: { remote: { offlineMs: 100 } },
    child: async (_context, options) => {
      started = true
      await new Promise(resolve => options?.signal?.addEventListener('abort', resolve, { once: true }))
      return aborted()
    },
  })
  try {
    await delegate(t, { kind: 'remote', title: 'x', target: 'dev', brief: 'Build the demo project on the server.' })
    await until(() => started, 'the subagent to start')
    loop.state.down = true
    loop.cut()
    const report = await reportOf(t.harness)
    assert.equal(report.status, 'failed')
    assert.match(report.text, /remote machine stayed unreachable/)
    const item = await itemOf(t.harness)
    assert.equal(item.failure.reason, 'target_offline')
    assert.match(item.failure.detail, /disconnected/)
  } finally {
    await t.close()
  }
}))

test('a short outage reconnects and later tool calls use the new connection', () => withRemote(async ({ dirs, pool, loop }) => {
  const env1 = await pool.env('dev', dirs.project)
  assert.equal((await env1.writeFile('a.txt', 'one', ctx)).ok, true)
  loop.cut()
  await until(() => pool.offlineSince('dev') !== undefined, 'the drop to be noticed')
  // 旧 env 绑在断掉的连接上：不重放、不换连接，直接失败。
  const stale = await env1.writeFile('b.txt', 'two', ctx)
  assert.equal(stale.ok, false)
  assert.equal(existsSync(path.join(dirs.project, 'b.txt')), false)
  const env2 = await pool.env('dev', dirs.project)
  assert.equal((await env2.writeFile('c.txt', 'three', ctx)).ok, true)
  assert.equal(pool.offlineSince('dev'), undefined)
  assert.ok(loop.state.connects >= 2)
}))

test('reconfiguring the pool keeps unchanged machines connected and drops removed or edited ones', () => withRemote(async ({ dirs, pool, loop }) => {
  const dev = { name: 'dev', ssh: 'dev', workspace: dirs.workspace, node: 'node' }
  const other = { name: 'other', ssh: 'other', workspace: dirs.workspace, node: 'node' }
  pool.configure([dev, other])
  await pool.env('dev', dirs.workspace)
  await pool.env('other', dirs.workspace)
  assert.equal(loop.state.connects, 2)
  pool.configure([{ ...other, node: '/opt/node' }, dev])
  assert.deepEqual(pool.targets.map(target => target.name), ['other', 'dev'], 'the order follows the settings')
  await pool.env('dev', dirs.workspace)
  assert.equal(loop.state.connects, 2, 'an unchanged machine keeps its connection')
  await pool.env('other', dirs.workspace)
  assert.equal(loop.state.connects, 3, 'an edited machine reconnects with its new settings')
  pool.configure([dev])
  assert.equal(pool.has('other'), false)
  assert.match((await pool.checkDir('other', undefined)).detail, /not configured/)
}))
