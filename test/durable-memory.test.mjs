import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { AssistantEntry, createRegistry, defineExtension, defineTask, Harness, MemoryStorage, section } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
  AmadeusMemory,
  isConversationIdle,
  isMemoryEntry,
  isMemoryMessage,
  itemsFromText,
  MemoryBaseline,
  plan,
  prepareMemory,
  renderSnapshot,
  renderUpdate,
} from '../src/main/durable/memory/index.ts'

const SOURCE_V1 = '- 偏好无糖黑咖啡，不加奶。\n- 希望你直呼其名，不用敬称。'
const SOURCE_V2 = '- 偏好无糖黑咖啡，不加奶。\n- 正在写毕业论文，课题是跨模态时间序列分析。'

const Role = defineExtension({
  name: 'amadeus-role',
  sections: [section('role', () => '你是牧瀬紅莉栖。', { tag: false })],
})

/** 一个脚本化的 Harness：每次发给 faux 模型的消息都被记下来，供断言请求的形状。 */
async function openRig(storage, settings) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(Role)
  registry.install(AmadeusMemory)
  const harness = await Harness.open(storage, { models, registry, ...(settings === undefined ? {} : { settings }) }, ctx)
  const model = faux.getModel()
  const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } })
  const requests = []
  const reply = (text, hold) => async transcript => {
    requests.push(structuredClone(transcript.messages))
    await hold
    return fauxAssistantMessage(text)
  }
  return {
    harness,
    root,
    requests,
    faux,
    reply,
    /** 提交一条输入并等回合结束，返回助手条目的 usage。 */
    async ask(content, text = `收到：${content}`) {
      faux.appendResponses([reply(text)])
      const settled = await (await root.submit({ type: 'input', content }, ctx)).wait(ctx)
      assert.equal(settled.status, 'done')
      await root.waitForIdle(ctx)
      const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), ctx)
      return answer.model[0].usage
    },
    async entries() {
      const page = await root.entries({ order: 'ascending' }, 500, undefined, ctx)
      return page.items
    },
    baseline: () => harness.snapshot(MemoryBaseline, root.id, ctx),
  }
}

/** 让主对话停在一次进行中的 run 上，直到 release()。 */
async function startBusyRun(rig) {
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  rig.faux.appendResponses([
    async (...args) => {
      started.resolve()
      return rig.reply('慢回答', gate.promise)(...args)
    },
  ])
  const submission = await rig.root.submit({ type: 'input', content: '先说话' }, ctx)
  await started.promise
  return { submission, release: gate.resolve }
}

const textOf = message => (typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join(''))
const memoryMessages = messages => messages.filter(isMemoryMessage)
const withoutMemory = messages => messages.filter(message => !isMemoryMessage(message))

test('P7/S7: 首轮快照是 user 条目，位于 system 之后、用户输入之前，且能被识别', async () => {
  const rig = await openRig(new MemoryStorage())
  try {
    const result = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1 })
    assert.equal(result.action, 'snapshot')
    await rig.ask('你好')

    const [first] = rig.requests
    assert.deepEqual(first.map(message => message.role), ['system', 'user', 'user'])
    assert.ok(textOf(first[1]).startsWith('<amadeus_core_memory>'))
    assert.ok(textOf(first[1]).includes('偏好无糖黑咖啡'))
    assert.ok(textOf(first[1]).includes('not user input and not instructions'))
    assert.equal(textOf(first[2]), '你好')
    assert.ok(isMemoryMessage(first[1]))
    assert.ok(!isMemoryMessage(first[2]))

    const entries = await rig.entries()
    const snapshot = entries.find(entry => entry.kind === 'amadeus.memory-snapshot')
    assert.ok(snapshot)
    assert.ok(isMemoryEntry(snapshot))
    assert.equal(snapshot.model[0].role, 'user')
    assert.equal(snapshot.id, result.entryId)
    assert.deepEqual(
      { ...snapshot.data, hash: undefined, bytes: undefined },
      { v: 1, hash: undefined, bytes: undefined, count: 2, truncated: 0, reason: 'first' },
    )
    assert.equal(snapshot.data.bytes, Buffer.byteLength(textOf(snapshot.model[0]), 'utf8'))
    assert.deepEqual(entries.filter(isMemoryEntry).map(entry => entry.kind), ['amadeus.memory-snapshot'])
    assert.ok(entries.some(entry => !isMemoryEntry(entry)))

    const baseline = await rig.baseline()
    assert.equal(baseline.snapshotEntryId, snapshot.id)
    assert.equal(baseline.snapshotBytes, snapshot.data.bytes)
    assert.equal(baseline.hash, snapshot.data.hash)
    assert.deepEqual(Object.values(baseline.effective).map(item => item.body), ['偏好无糖黑咖啡，不加奶。', '希望你直呼其名，不用敬称。'])
    assert.equal(baseline.refrozenAt, null)

    const again = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1 })
    assert.deepEqual(again, { action: 'none' })
    assert.equal((await rig.entries()).filter(entry => entry.kind === 'amadeus.memory-snapshot').length, 1)
  } finally {
    await rig.harness.close(ctx)
  }
})

test('没有任何记忆条目时不写快照，基线保持未写过', async () => {
  const rig = await openRig(new MemoryStorage())
  try {
    assert.deepEqual(await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => '\n  \n' }), { action: 'none' })
    await rig.ask('你好')
    assert.deepEqual(rig.requests[0].map(message => message.role), ['system', 'user'])
    assert.equal((await rig.baseline())?.snapshotEntryId ?? null, null)
  } finally {
    await rig.harness.close(ctx)
  }
})

test('P8: 增量超出 max(快照字节, 4096) 后重新冻结，请求里只剩新快照，旧快照与增量消失，其余前缀逐字节一致', async () => {
  const rig = await openRig(new MemoryStorage())
  try {
    // 第 2 轮换一条（小增量），第 9 轮一次加入 5000 字节（单次增量就超预算）
    const BIG = `- ${'很长的一条记忆'.repeat(250)}`
    const sources = [SOURCE_V1, SOURCE_V2, SOURCE_V2, SOURCE_V2, SOURCE_V2, SOURCE_V2, SOURCE_V2, SOURCE_V2, `${SOURCE_V2}\n${BIG}`, `${SOURCE_V2}\n${BIG}`, `${SOURCE_V2}\n${BIG}`]
    const actions = []
    const usages = []
    for (let turn = 1; turn <= 11; turn++) {
      const result = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => sources[turn - 1] })
      actions.push(result.action)
      usages.push(await rig.ask(`第 ${turn} 轮的输入，带一点长度让前缀看得出来。`, `第 ${turn} 轮的回答，也带一点长度。`))
    }
    assert.deepEqual(actions, ['snapshot', 'update', 'none', 'none', 'none', 'none', 'none', 'none', 'refreeze', 'none', 'none'])

    const [r1, r2] = rig.requests
    const [r8, r9, r10] = rig.requests.slice(7, 10)
    assert.equal(memoryMessages(r1).length, 1)
    // 第 2 轮：快照原样保留，后面追加一条增量
    assert.deepEqual(r2.slice(0, r1.length), r1)
    assert.equal(memoryMessages(r2).length, 2)
    assert.ok(textOf(memoryMessages(r2)[1]).startsWith('<amadeus_core_memory_update>'))
    assert.ok(textOf(memoryMessages(r2)[1]).includes('Added:\n- 正在写毕业论文'))
    assert.ok(textOf(memoryMessages(r2)[1]).includes('Removed:\n- 希望你直呼其名'))

    // 第 9 轮：只剩一份新快照，位置仍紧跟 system
    const frozen = memoryMessages(r9)
    assert.equal(frozen.length, 1)
    assert.equal(r9[1], frozen[0])
    assert.equal(textOf(frozen[0]), renderSnapshot(itemsFromText(`${SOURCE_V2}\n${BIG}`)))
    assert.ok(textOf(frozen[0]).includes('正在写毕业论文'))
    assert.ok(!textOf(frozen[0]).includes('直呼其名'))
    assert.ok(!r9.some(message => textOf(message).startsWith('<amadeus_core_memory_update>')))
    assert.equal(memoryMessages(r8).length, 2)
    // 对话本身的消息没有被动过
    assert.deepEqual(withoutMemory(r9).slice(0, withoutMemory(r8).length), withoutMemory(r8))

    // 第 10 轮起恢复只追加
    assert.deepEqual(r10.slice(0, r9.length), r9)

    // 缓存：只有重新冻结的那一轮重新计费，前后相邻两轮都很小（faux 按公共前缀估算 usage）
    assert.ok(usages[8].cacheWrite > usages[7].cacheWrite * 3, `refreeze turn should miss the cache: ${JSON.stringify(usages.map(u => u.cacheWrite))}`)
    assert.ok(usages[9].cacheWrite < usages[8].cacheWrite / 2, 'cache should recover on the next turn')

    const entries = await rig.entries()
    const refreeze = entries.find(entry => entry.kind === 'amadeus.memory-refreeze')
    const update = entries.find(entry => entry.kind === 'amadeus.memory-update')
    const snapshot = entries.find(entry => entry.kind === 'amadeus.memory-snapshot')
    assert.ok(refreeze && update && snapshot)
    assert.equal(refreeze.model, undefined)
    assert.ok(isMemoryEntry(refreeze) && isMemoryEntry(update))
    assert.deepEqual(refreeze.edits.map(edit => [edit.target, edit.action]), [[snapshot.id, 'replace'], [update.id, 'omit']])
    assert.deepEqual(refreeze.data.omitted, [update.id])
    assert.equal(refreeze.data.replaced, snapshot.id)
    assert.equal(update.data.added, 1)
    assert.equal(update.data.removed, 1)

    const baseline = await rig.baseline()
    assert.equal(baseline.snapshotEntryId, snapshot.id)
    assert.deepEqual(baseline.updateEntryIds, [])
    assert.equal(baseline.updateBytes, 0)
    assert.equal(baseline.hash, refreeze.data.hash)
    assert.equal(typeof baseline.refrozenAt, 'number')
    assert.deepEqual(Object.values(baseline.effective).map(item => item.body).length, 3)
  } finally {
    await rig.harness.close(ctx)
  }
})

test('对话忙时返回 skipped 且不写入，空闲后补上', async () => {
  const rig = await openRig(new MemoryStorage())
  const busy = await startBusyRun(rig)
  try {
    assert.equal(await isConversationIdle(rig.harness, rig.root.id, ctx), false)
    for (const idleWaitMs of [0, 30]) {
      const startedAt = performance.now()
      const result = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1, idleWaitMs })
      assert.deepEqual(result, { action: 'skipped', reason: 'busy' })
      assert.ok(performance.now() - startedAt < 1000, 'bounded idle wait must not hang on a busy conversation')
    }
    assert.deepEqual((await rig.entries()).filter(isMemoryEntry), [])
    assert.equal((await rig.baseline())?.snapshotEntryId ?? null, null)

    busy.release()
    assert.equal((await busy.submission.wait(ctx)).status, 'done')
    await rig.root.waitForIdle(ctx)
    const result = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1 })
    assert.equal(result.action, 'snapshot')
  } finally {
    // 断言失败时 faux 还卡在 gate 上，不放行的话 close() 会一直等
    busy.release()
    await rig.harness.close(ctx)
  }
})

test('inspect 与 commit 之间对话变忙时，commit 内的 pi.live.run 复核仍然拦住写入', async () => {
  const rig = await openRig(new MemoryStorage())
  const busy = await startBusyRun(rig)
  try {
    // 模拟竞争：外部检查看到的是空闲
    const stale = Object.create(rig.harness, { inspect: { value: async () => ({ scheduling: 'running', tasks: [], submissions: [] }) } })
    const result = await prepareMemory(stale, rig.root, ctx, { snapshotSource: () => SOURCE_V1, idleWaitMs: 0 })
    assert.deepEqual(result, { action: 'skipped', reason: 'busy' })
    assert.deepEqual((await rig.entries()).filter(isMemoryEntry), [])
  } finally {
    busy.release()
    await busy.submission.wait(ctx).catch(() => {})
    await rig.harness.close(ctx)
  }
})

test('后台任务及其名下的子任务不算忙，前台任务才算', async () => {
  const Sleeper = defineTask({
    name: 'test.sleeper',
    version: 1,
    initial: () => ({ phase: 'wait' }),
    phases: {
      wait: async (_task, runtime, context) => {
        await runtime.sleep(Number.MAX_SAFE_INTEGER, context)
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
    },
  })
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'test-sleeper', tasks: [Sleeper] }))
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx)
  try {
    const root = await harness.root(ctx)
    assert.equal(await isConversationIdle(harness, root.id, ctx), true)

    const background = await root.commit(tx => tx.createTask(Sleeper, {}, { ownership: { kind: 'conversation' }, background: true }), ctx)
    assert.equal(await isConversationIdle(harness, root.id, ctx), true, '后台任务不让对话保持忙碌')

    const child = await root.commit(tx => tx.createTask(Sleeper, {}, { ownership: { kind: 'task', taskId: background } }), ctx)
    assert.equal(await isConversationIdle(harness, root.id, ctx), true, '后台任务名下的子任务同样不算')

    // 只有后台任务时照常写入
    const source = { snapshotSource: () => SOURCE_V1, idleWaitMs: 0 }
    assert.equal((await prepareMemory(harness, root, ctx, source)).action, 'snapshot')

    const foreground = await root.commit(tx => tx.createTask(Sleeper, {}, { ownership: { kind: 'conversation' } }), ctx)
    assert.equal(await isConversationIdle(harness, root.id, ctx), false)
    // 前台任务不占 pi.live.run，只有外层的 inspect 判定拦得住
    assert.deepEqual(await prepareMemory(harness, root, ctx, { ...source, snapshotSource: () => SOURCE_V2 }), { action: 'skipped', reason: 'busy' })

    await harness.abortTask(foreground, ctx)
    await harness.waitForTask(foreground, ctx)
    assert.equal(await isConversationIdle(harness, root.id, ctx), true)
    for (const id of [child, background]) await harness.abortTask(id, ctx)
  } finally {
    await harness.close(ctx)
  }
})

test('空闲的对话被判定为空闲', async () => {
  const rig = await openRig(new MemoryStorage())
  try {
    assert.equal(await isConversationIdle(rig.harness, rig.root.id, ctx), true)
    await rig.ask('你好')
    assert.equal(await isConversationIdle(rig.harness, rig.root.id, ctx), true)
  } finally {
    await rig.harness.close(ctx)
  }
})

test('重开 sqlite 后不会重复写首轮快照，增量继续生效', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-memory-'))
  const file = path.join(dir, 'durable.sqlite')
  try {
    let rig = await openRig(await openNodeSqliteStorage(file))
    assert.equal((await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1 })).action, 'snapshot')
    await rig.ask('你好')
    await rig.harness.close(ctx)

    rig = await openRig(await openNodeSqliteStorage(file))
    try {
      assert.deepEqual(await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1 }), { action: 'none' })
      await rig.ask('我又回来了')
      assert.equal((await rig.entries()).filter(entry => entry.kind === 'amadeus.memory-snapshot').length, 1)
      assert.equal(memoryMessages(rig.requests[0]).length, 1)
      assert.deepEqual(rig.requests[0].map(message => message.role).slice(0, 3), ['system', 'user', 'user'])

      const next = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V2 })
      assert.equal(next.action, 'update')
      await rig.ask('现在呢')
      assert.equal(memoryMessages(rig.requests[1]).length, 2)
    } finally {
      await rig.harness.close(ctx)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重置上下文后快照落在范围外：追加新快照，旧快照与增量不再出现', async () => {
  const rig = await openRig(new MemoryStorage())
  try {
    await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1 })
    await rig.ask('一')
    await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V2 })
    await rig.ask('二')

    await rig.root.reset('我们刚才聊到毕业论文。', ctx)
    await rig.root.waitForIdle(ctx)
    const result = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V2 })
    assert.equal(result.action, 'snapshot')
    await rig.ask('三')

    const last = rig.requests.at(-1)
    const memory = memoryMessages(last)
    assert.equal(memory.length, 1)
    assert.equal(textOf(memory[0]), renderSnapshot(itemsFromText(SOURCE_V2)))
    assert.ok(!last.some(message => textOf(message).includes('直呼其名')))

    const snapshots = (await rig.entries()).filter(entry => entry.kind === 'amadeus.memory-snapshot')
    assert.deepEqual(snapshots.map(entry => entry.data.reason), ['first', 'compaction'])
    assert.equal((await rig.baseline()).snapshotEntryId, snapshots[1].id)
  } finally {
    await rig.harness.close(ctx)
  }
})

test('S8: 压缩后快照落在范围外，追加新快照并 omit 仍在范围内的增量', async () => {
  // keepRecentTokens 取小：压缩只会摘要掉最前面的快照条目，增量条目留在保留范围里，正好覆盖 omit 路径
  const rig = await openRig(new MemoryStorage(), { compaction: { keepRecentTokens: 70 } })
  try {
    await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V1 })
    for (const text of ['第一句话很长很长很长很长很长很长', '第二句话很长很长很长很长很长很长', '第三句话很长很长很长很长很长很长']) await rig.ask(text)
    const update = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V2 })
    assert.equal(update.action, 'update')
    await rig.ask('第四句')

    rig.faux.appendResponses([rig.reply('这是摘要')])
    const compaction = await rig.root.compact(undefined, ctx)
    const { outcome } = (await rig.harness.waitForTask(compaction, ctx)).state
    assert.equal(outcome.status, 'completed')
    assert.equal((await (await rig.harness.submission(outcome.result.submissionId, ctx)).wait(ctx)).status, 'done')
    await rig.root.waitForIdle(ctx)

    const before = await rig.baseline()
    const { head } = await rig.root.context(ctx)
    assert.ok(head.head > before.snapshotEntryId, 'precondition: compaction cut the snapshot off')
    assert.ok(update.entryId >= head.head, 'precondition: the update entry is still in range')

    const result = await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V2 })
    assert.equal(result.action, 'snapshot')
    await rig.ask('第五句')

    const entries = await rig.entries()
    const fresh = entries.find(entry => entry.id === result.entryId)
    assert.equal(fresh.data.reason, 'compaction')
    assert.deepEqual(fresh.edits, [{ target: update.entryId, action: 'omit' }])
    const last = memoryMessages(rig.requests.at(-1))
    assert.equal(last.length, 1)
    assert.equal(textOf(last[0]), renderSnapshot(itemsFromText(SOURCE_V2)))

    const baseline = await rig.baseline()
    assert.equal(baseline.snapshotEntryId, result.entryId)
    assert.deepEqual(baseline.updateEntryIds, [])
    // 压缩后无变化时不再重复写
    assert.deepEqual(await prepareMemory(rig.harness, rig.root, ctx, { snapshotSource: () => SOURCE_V2 }), { action: 'none' })
  } finally {
    await rig.harness.close(ctx)
  }
})

test('plan(): 文档 §4.3 判定表逐行', () => {
  const body = text => ({ id: `text-${text}`, type: 'text', body: text })
  const baseline = (overrides = {}) => ({
    snapshotEntryId: 10,
    snapshotBytes: 1000,
    hash: 'h',
    effective: { 'text-a': { type: 'text', body: 'a' } },
    updateEntryIds: [],
    updateBytes: 0,
    refrozenAt: null,
    ...overrides,
  })
  const run = (b, current, extra = {}) => plan({ baseline: b, current, activeHead: undefined, ...extra })

  // 1 / 2
  assert.deepEqual(run(baseline({ snapshotEntryId: null, effective: {} }), []), { kind: 'none' })
  assert.deepEqual(run(baseline({ snapshotEntryId: null, effective: {} }), [body('a')]), { kind: 'snapshot', reason: 'first', omit: [] })
  // 3：快照已在压缩头之前
  assert.deepEqual(run(baseline({ updateEntryIds: [8, 12, 14] }), [body('a')], { activeHead: 11 }), { kind: 'snapshot', reason: 'compaction', omit: [12, 14] })
  assert.deepEqual(run(baseline({ effective: {} }), [], { activeHead: 11 }), { kind: 'forget-snapshot' })
  assert.deepEqual(run(baseline(), [], { activeHead: 11 }), { kind: 'snapshot', reason: 'compaction', omit: [] })
  assert.deepEqual(run(baseline(), [body('a')], { activeHead: 10 }), { kind: 'none' }, '压缩头恰好指向快照时快照仍在范围内')
  // 4：正文集合一致（与顺序、id 无关）
  assert.deepEqual(run(baseline(), [{ id: 'renamed', type: 'other', body: 'a' }]), { kind: 'none' })
  // 5
  assert.deepEqual(run(baseline(), []), { kind: 'refreeze' })
  // 6：增量超预算
  const big = 'x'.repeat(5000)
  assert.deepEqual(run(baseline(), [body('a'), body(big)]), { kind: 'refreeze' })
  assert.deepEqual(run(baseline({ updateBytes: 4000 }), [body('a'), body('b')]), { kind: 'refreeze' })
  // 7
  const update = run(baseline(), [body('b')])
  assert.equal(update.kind, 'update')
  assert.deepEqual(update.added.map(item => item.body), ['b'])
  assert.deepEqual(update.removed.map(item => item.body), ['a'])
  assert.equal(update.text, renderUpdate(update.added, update.removed))
})

test('isMemoryEntry / isMemoryMessage 只认记忆条目，不误伤普通对话', () => {
  assert.ok(isMemoryEntry({ kind: 'amadeus.memory-snapshot' }))
  assert.ok(isMemoryEntry({ kind: 'amadeus.memory-update' }))
  assert.ok(isMemoryEntry({ kind: 'amadeus.memory-refreeze' }))
  assert.ok(isMemoryEntry({ kind: 'amadeus.episode' }))
  assert.ok(!isMemoryEntry({ kind: 'pi.user' }))
  assert.ok(!isMemoryEntry({ kind: 'app.outbox' }))
  assert.ok(!isMemoryEntry(undefined))
  assert.ok(isMemoryMessage({ role: 'user', content: '<amadeus_core_memory>\nx' }))
  assert.ok(isMemoryMessage({ role: 'user', content: [{ type: 'text', text: '<amadeus_core_memory_update>\nx' }] }))
  assert.ok(!isMemoryMessage({ role: 'assistant', content: '<amadeus_core_memory>' }))
  assert.ok(!isMemoryMessage({ role: 'user', content: '我想聊聊 <amadeus_core_memory>' }))
})
