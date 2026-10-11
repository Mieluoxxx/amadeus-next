import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ActivityLog, labelOf } from '../src/main/durable/childActivity.ts'
import { WorkLedger } from '../src/main/durable/workLedger.ts'

const assistant = (id, content, timestamp = 10) => ({ id, conversationId: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content, timestamp }] })
const result = (id, toolCallId, toolName, text, isError = false) => ({
  id, conversationId: 2, kind: 'pi.tool-result',
  model: [{ role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError, timestamp: 20, durationMs: 7 }],
})
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })

test('labelOf picks the argument that says what the step does', () => {
  assert.equal(labelOf('bash', { command: 'npm   test\n--watch' }), 'npm test --watch')
  assert.equal(labelOf('read', { path: '/a/b.md', offset: 3 }), '/a/b.md')
  assert.equal(labelOf('web_search', { query: '东京' }), '东京')
  assert.equal(labelOf('custom', { a: 1 }), '{"a":1}')
  assert.equal(labelOf('custom', {}), '')
  assert.equal(labelOf('bash', { command: 'x'.repeat(400) }).length, 160)
})

test('ActivityLog turns calls and results into one action per step, in order', () => {
  const log = new ActivityLog()
  log.entry({ id: 1, conversationId: 2, kind: 'pi.user', model: [{ role: 'user', content: '查天气', timestamp: 1 }] })
  log.entry(assistant(2, [{ type: 'text', text: '先读文件。' }, call('a', 'read', { path: 'notes.md' }), call('p', 'report_progress', { note: '读完一半' })]))
  assert.deepEqual(log.actions().map(action => [action.type, action.status ?? action.text]), [['brief', '查天气'], ['text', '先读文件。'], ['tool', 'running'], ['progress', '读完一半']])
  log.entry(result(3, 'a', 'read', 'hello'))
  log.entry(result(4, 'p', 'report_progress', 'ok'))
  const tool = log.actions()[2]
  assert.deepEqual([tool.status, tool.durationMs, tool.output, tool.label], ['ok', 7, 'hello', 'notes.md'])
  assert.equal(log.toolUses, 1, 'report_progress is not a tool use')
  assert.equal(log.recent(3).length, 2)
})

test('ActivityLog keeps a result that arrives before its call, marks faulted tools, and only hands out what changed', () => {
  const log = new ActivityLog()
  log.apply([{ type: 'snapshot', entries: [result(3, 'b', 'bash', 'boom', true), assistant(2, [call('b', 'bash', { command: 'ls' })])], tools: [], compactions: [], inbox: [], agent: {}, usage: { models: { 'x/y': { totalTokens: 120 } }, tools: {} } }])
  assert.deepEqual(log.actions().map(action => [action.tool, action.label, action.status]), [['bash', 'ls', 'error']])
  assert.deepEqual([log.toolUses, log.tokens], [1, 120])
  assert.equal(log.take().length, 1)
  assert.equal(log.pending, false)
  log.apply([{ type: 'message_end', entry: assistant(5, [call('c', 'bash', { command: 'sleep 9' })]) }])
  log.apply([{ type: 'tool_execution_end', toolCallId: 'c', toolName: 'bash' }])
  const changed = log.take()
  assert.deepEqual(changed.map(action => [action.label, action.status]), [['sleep 9', 'error']], 'a tool that ended without a result is not left spinning')
  log.apply([{ type: 'message_end', entry: assistant(5, [call('c', 'bash', { command: 'sleep 9' })]) }])
  assert.equal(log.pending, false, 'replaying the same entry changes nothing')
})

test('ActivityLog drops the oldest actions past its limit', () => {
  const log = new ActivityLog(3)
  for (let index = 0; index < 5; index++) log.entry(assistant(index, [call(`t${index}`, 'read', { path: `f${index}` })]))
  assert.deepEqual(log.actions().map(action => action.label), ['f2', 'f3', 'f4'])
  assert.equal(log.toolUses, 5, 'the count covers every call, not just the retained ones')
})

test('WorkLedger keeps counts across syncs, survives a reload, and drops sessions', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-work-'))
  try {
    const ledger = new WorkLedger(dir)
    ledger.load()
    ledger.sync('one', [{ taskId: 't_01', kind: 'research', title: '天气', status: 'running', round: 1, createdAt: 1, startedAt: 2, progress: { text: 'x', at: 3 } }])
    ledger.count('one', 't_01', { toolUses: 4, tokens: 900 })
    ledger.sync('one', [{ taskId: 't_01', kind: 'research', title: '天气', status: 'done', round: 1, createdAt: 1, startedAt: 2, endedAt: 5 }])
    ledger.close()
    const reloaded = new WorkLedger(dir)
    reloaded.load()
    assert.deepEqual(reloaded.get('one'), [{ taskId: 't_01', kind: 'research', title: '天气', status: 'done', round: 1, createdAt: 1, startedAt: 2, endedAt: 5, toolUses: 4, tokens: 900 }])
    reloaded.remove('one')
    const emptied = new WorkLedger(dir)
    emptied.load()
    assert.deepEqual(emptied.entries(), [])
    writeFileSync(path.join(dir, 'work.json'), '{broken')
    const broken = new WorkLedger(dir)
    broken.load()
    assert.deepEqual(broken.entries(), [], 'a corrupt ledger starts empty instead of failing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

import { applyWorkEvent, elapsedOf, formatElapsed, mergeActions, normalizeWorkList, sortWork } from '../src/renderer/components/scene/workTypes.ts'

const tool = (id, status = 'running') => ({ id, type: 'tool', tool: 'read', label: id, status, at: 1 })

test('mergeActions replaces by id in place and appends new ones in arrival order', () => {
  const merged = mergeActions([tool('a'), tool('b')], [tool('b', 'ok'), tool('c')])
  assert.deepEqual(merged.map(action => [action.id, action.status]), [['a', 'running'], ['b', 'ok'], ['c', 'running']])
})

test('normalizeWorkList flattens sessions and drops what it cannot read', () => {
  const tasks = normalizeWorkList({ sessions: [
    { sessionId: 'one', title: '天气', tasks: [{ taskId: 't_01', kind: 'research', title: '查', status: 'running', round: 1, createdAt: 5, startedAt: 6, toolUses: 2, recent: [tool('a'), { id: 'x', type: 'weird' }] }, { title: 'no id' }] },
    { title: 'no session id', tasks: [{ taskId: 't_02' }] },
  ] })
  assert.equal(tasks.length, 1)
  assert.deepEqual([tasks[0].sessionId, tasks[0].sessionTitle, tasks[0].toolUses, tasks[0].recent.length], ['one', '天气', 2, 1])
  assert.deepEqual(normalizeWorkList(null), [])
})

test('events replayed over a late baseline keep the newer state, and task.graph keeps the counts it does not carry', () => {
  const baseline = normalizeWorkList({ sessions: [{ sessionId: 'one', title: '天气', tasks: [{ taskId: 't_01', status: 'running', startedAt: 1, toolUses: 1 }] }] })
  // 请求在途时先后到达：子代理又调了一次工具，然后任务结束。
  const replay = [
    { type: 'activity', sessionId: 'one', taskId: 't_01', actions: [tool('a', 'ok')], toolUses: 2, tokens: 300 },
    { type: 'graph', sessionId: 'one', tasks: [{ taskId: 't_01', status: 'done', startedAt: 1, endedAt: 9 }] },
  ]
  const [task] = replay.reduce(applyWorkEvent, baseline)
  assert.deepEqual([task.status, task.toolUses, task.tokens, task.recent.map(action => action.id)], ['done', 2, 300, ['a']])
  assert.equal(task.sessionTitle, '天气', 'the graph event has no title, so the known one stays')
  const other = applyWorkEvent([task], { type: 'graph', sessionId: 'two', tasks: [{ taskId: 't_01', status: 'running' }] })
  assert.deepEqual(other.map(each => [each.sessionId, each.status]), [['one', 'done'], ['two', 'running']], 'same task id in another session is a different task')
})

test('elapsed time ticks while running, waits while queued, and freezes when the round ends', () => {
  assert.equal(elapsedOf({ status: 'running', createdAt: 0, startedAt: 1000 }, 61_000), 60_000)
  assert.equal(elapsedOf({ status: 'done', createdAt: 0, startedAt: 1000, endedAt: 3000 }, 99_000), 2000)
  assert.equal(elapsedOf({ status: 'queued', createdAt: 500 }, 2500), 2000)
  assert.equal(elapsedOf({ status: 'needs_input', createdAt: 0, startedAt: 1000 }, 99_000), undefined, 'a paused task does not keep counting')
  assert.deepEqual([formatElapsed(42_000), formatElapsed(185_000), formatElapsed(3_900_000)], ['42s', '3m 5s', '1h 5m'])
})

test('sortWork puts open tasks first, newest on top, then finished ones by end time', () => {
  const base = { sessionId: 's', sessionTitle: '', kind: 'research', title: '', round: 1, toolUses: 0, tokens: 0, recent: [] }
  const { open, finished } = sortWork([
    { ...base, taskId: 'a', status: 'done', createdAt: 1, endedAt: 5 },
    { ...base, taskId: 'b', status: 'running', createdAt: 2, startedAt: 3 },
    { ...base, taskId: 'c', status: 'needs_input', createdAt: 4, startedAt: 6 },
    { ...base, taskId: 'd', status: 'failed', createdAt: 1, endedAt: 8 },
  ])
  assert.deepEqual([open.map(task => task.taskId), finished.map(task => task.taskId)], [['c', 'b'], ['d', 'a']])
})
