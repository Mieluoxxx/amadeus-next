import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { ApprovalsDoc, HandoffsDoc, OutboxDoc, renderReport } from '../src/main/durable/handoff/index.ts'
import { AnchorTask } from '../src/main/durable/handoff/reporter.ts'
import { ProcessLock, processStartTime } from '../src/main/durable/processLock.ts'
import { DurableRuntime } from '../src/main/durable/runtime.ts'
import { TagScrubber } from '../src/main/durable/scrub.ts'
import { SessionIndex } from '../src/main/durable/sessionIndex.ts'

const ctx = BACKGROUND_CONTEXT
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(done => (resolve = done)); return { promise, resolve } }

/** 记忆服务的替身：记录 prepare / afterTurn / handle / close 的调用，必要时往对话里写记忆条目。 */
function fakeMemory(log, behavior = {}) {
  return ({ post, enabled, recall }) => {
    const extension = defineExtension({ name: 'amadeus-memory' })
    log.push({ call: 'create', enabled, recall })
    return {
      extensions: [extension],
      mainExtension: extension,
      async prepare(harness, conversation, context, options) {
        log.push({ call: 'prepare', turn: options.turn, input: options.input, report: options.report, sessionId: options.sessionId })
        await behavior.prepare?.({ harness, conversation, context, options })
      },
      async afterTurn(_harness, _conversation, _context, options) { log.push({ call: 'afterTurn', sessionId: options?.sessionId }) },
      async handle(command, params) {
        log.push({ call: 'handle', command, params })
        if (command === 'memory.write') post({ type: 'event', name: 'memory.changed', reason: 'manual' })
        return behavior.handle ? behavior.handle(command, params) : { ok: true, items: [] }
      },
      async close() { log.push({ call: 'close' }) },
    }
  }
}

function fixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'amadeus-durable-'))
  const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 0, ...(options.fauxModels ? { models: options.fauxModels } : {}) })
  const models = createModels()
  models.setProvider(faux.provider)
  const agentDir = path.join(root, 'agent')
  const sessionsDir = path.join(root, 'sessions')
  const messages = []
  const memoryLog = []
  const runtimes = []
  let sequence = 0
  const f = {
    root, faux, models, agentDir, sessionsDir, messages, memoryLog,
    async create(overrides = {}) {
      const runtime = new DurableRuntime({
        models, agentDir, sessionsDir,
        memoryDir: path.join(root, 'memory'),
        post: message => messages.push(message),
        createMemory: options.realMemory ? undefined : fakeMemory(memoryLog, options.memory),
        log: () => {},
        lockWaitMs: 0,
        checkpointGraceMs: 50,
        ...options.runtime,
        ...overrides,
      })
      await runtime.start()
      runtimes.push(runtime)
      return runtime
    },
    /** 发一条命令并取它的终止应答；顺带断言"每条命令恰好一条终止应答"。 */
    async call(runtime, command, params = {}) {
      const id = `c${++sequence}`
      // 封包用嵌套的 params：report.deliver 的 id、memory.* 的 id 与封包 id 同名，平铺会撞车。
      await runtime.handle({ id, command, params })
      const replies = messages.filter(message => message.id === id)
      assert.equal(replies.length, 1, `${command} must get exactly one terminal reply, got ${JSON.stringify(replies)}`)
      assert.ok(['done', 'error', 'aborted'].includes(replies[0].type))
      return replies[0]
    },
    events(name, filter = () => true) {
      return messages.filter(message => message.type === 'event' && message.name === name && filter(message))
    },
    turn(turnId) {
      return messages.filter(message => message.type === 'event' && message.name.startsWith('turn.') && message.turnId === turnId)
    },
    async until(predicate, ms = 8000) {
      const started = Date.now()
      while (!predicate()) {
        if (Date.now() - started > ms) throw new Error(`condition not met within ${ms}ms`)
        await sleep(5)
      }
    },
    async settled(turnId) {
      await f.until(() => f.turn(turnId).some(event => ['turn.done', 'turn.error', 'turn.aborted'].includes(event.name)))
      return f.turn(turnId)
    },
    async cleanup() {
      for (const runtime of runtimes) await runtime.handle({ id: 'cleanup', command: 'checkpoint' }).catch(() => {})
      rmSync(root, { recursive: true, force: true })
    },
    /** 建会话并发第一条消息，回合结束后返回。 */
    async chat(runtime, sessionId, turnId, text) {
      const accepted = await f.call(runtime, 'chat.submit', { sessionId, turnId, text })
      assert.equal(accepted.type, 'done', JSON.stringify(accepted))
      return f.settled(turnId)
    },
  }
  return f
}

/** 挂起直到请求被中止，模拟慢模型或崩溃时在途的请求。 */
const hang = calls => (_context, options) => new Promise((_resolve, reject) => {
  calls.push(Date.now())
  options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
})

const indexOf = f => JSON.parse(readFileSync(path.join(f.sessionsDir, 'index.json'), 'utf8'))

test('chat.submit returns once the input is admitted; the turn streams as turn.* events and settles once', async () => {
  const f = fixture({ tokensPerSecond: 200 })
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: 'First' })
    f.faux.setResponses([fauxAssistantMessage('<zh>你好</zh><jp>こんにちは</jp>')])
    const accepted = await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 't1', text: 'hello' })
    assert.equal(accepted.type, 'done')
    assert.equal(accepted.requestId, 'turn:t1')
    const events = await f.settled('t1')
    const names = events.map(event => event.name)
    assert.equal(names.at(-1), 'turn.done')
    assert.equal(names.filter(name => name !== 'turn.text').length, 1, 'Exactly one terminal event')
    assert.ok(names.indexOf('turn.done') > names.lastIndexOf('turn.text'), 'Text precedes the terminal event')
    for (const event of events) {
      assert.equal(event.type, 'event')
      assert.equal(event.sessionId, 'one')
      assert.equal(event.kind, 'user')
      assert.equal(event.id, undefined, 'Events carry no command id')
    }
    const streamed = events.filter(event => event.name === 'turn.text').map(event => event.delta).join('')
    assert.equal(streamed, '<zh>你好</zh><jp>こんにちは</jp>')
    assert.equal(events.at(-1).text, streamed)
    assert.deepEqual(f.memoryLog.filter(entry => entry.call === 'prepare'), [{ call: 'prepare', turn: 1, input: 'hello', report: undefined, sessionId: 'one' }])
    await f.until(() => f.memoryLog.some(entry => entry.call === 'afterTurn'))
    assert.deepEqual(f.memoryLog.filter(entry => entry.call === 'afterTurn'), [{ call: 'afterTurn', sessionId: 'one' }])
  } finally { await f.cleanup() }
})

test('amadeus_* fences echoed by the model never reach the subtitle stream', async () => {
  const f = fixture({ tokensPerSecond: 400 })
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([fauxAssistantMessage('<zh>好的</zh><amadeus_core_memory>主人喜欢咖啡</amadeus_core_memory><jp>うん</jp></amadeus_handoff_result>')])
    const events = await f.chat(runtime, 'one', 't1', 'hi')
    const streamed = events.filter(event => event.name === 'turn.text').map(event => event.delta).join('')
    assert.equal(streamed, '<zh>好的</zh><jp>うん</jp>')
    assert.equal(events.at(-1).text, streamed)
    assert.doesNotMatch(JSON.stringify(events), /amadeus_|咖啡/)
  } finally { await f.cleanup() }
})

test('the scrubber handles tags split across chunks and unterminated fences', () => {
  const run = chunks => { const scrubber = new TagScrubber(); return chunks.map(chunk => scrubber.push(chunk)).join('') + scrubber.push('', true) }
  assert.equal(run(['a <ama', 'deus_core_memory>sec', 'ret</amadeus_core', '_memory> b']), 'a  b')
  assert.equal(run(['hello <zh>你好</zh>']), 'hello <zh>你好</zh>')
  assert.equal(run(['1 < 2 and <am']), '1 < 2 and <am', 'A held prefix that never becomes a tag is released at the end')
  assert.equal(run(['a <amadeus_x>never closed']), 'a ', 'An unterminated fence is dropped rather than leaked')
  assert.equal(run(['a </amadeus_x> b <amadeus_y/> c']), 'a  b  c')
  assert.equal(run(['x<amadeus_handoff_result task_id="t_01">r</AMADEUS_HANDOFF_RESULT>y']), 'xy')
  // 标签名本来就不分大小写，入口的前缀判断也必须一致。
  assert.equal(run(['a <AMADEUS_memory>secret</AMADEUS_memory> b']), 'a  b')
  assert.equal(run(['a <Amadeus_Core_Memory>secret</amadeus_core_memory> b']), 'a  b')
  assert.equal(run(['a <AMA', 'DEUS_x>sec', 'ret</AMADEUS_', 'X> b']), 'a  b', 'A mixed-case tag split across chunks')
  assert.equal(run(['a </AMADEUS_x> b']), 'a  b')
  assert.equal(run(['1 < 2 and <AM']), '1 < 2 and <AM', 'An upper-case held prefix that never becomes a tag is released at the end')
  assert.equal(run(['x <ÅMADEUS_y>keep</ÅMADEUS_y>']), 'x <ÅMADEUS_y>keep</ÅMADEUS_y>', 'Only ASCII case folding: look-alike letters are not the fence')
})

test('chat.abort ends the turn as aborted and leaves the conversation usable', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    const calls = []
    f.faux.setResponses([hang(calls)])
    await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 't1', text: 'hello' })
    await f.until(() => calls.length > 0)
    const midTurn = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(midTurn.messages.map(message => [message.role, message.turnId]), [['user', 't1']], 'The in-flight turn is identified by its turnId, history entries are not')
    const aborted = await f.call(runtime, 'chat.abort', { sessionId: 'one' })
    assert.equal(aborted.type, 'aborted')
    const events = await f.settled('t1')
    assert.equal(events.at(-1).name, 'turn.aborted')
    assert.equal(events.at(-1).kind, 'user')
    assert.equal(events.some(event => event.name === 'turn.error'), false)
    // 幂等：没有 run、会话未打开时同样成功。
    assert.equal((await f.call(runtime, 'chat.abort', { sessionId: 'one' })).type, 'aborted')
    assert.equal((await f.call(runtime, 'chat.abort', { sessionId: 'never-opened' })).type, 'aborted')
    f.faux.setResponses([fauxAssistantMessage('again')])
    assert.equal((await f.chat(runtime, 'one', 't2', 'next')).at(-1).text, 'again')
  } finally { await f.cleanup() }
})

test('an abort withdraws queued submits before they start (epoch)', async () => {
  const gate = deferred()
  const f = fixture({ memory: { prepare: async ({ options }) => { if (options.turn === 1) await gate.promise } } })
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([fauxAssistantMessage('should not be asked')])
    const first = runtime.handle({ id: 's1', command: 'chat.submit', sessionId: 'one', turnId: 'a', text: 'one' })
    await f.until(() => f.memoryLog.some(entry => entry.call === 'prepare'))
    const second = runtime.handle({ id: 's2', command: 'chat.submit', sessionId: 'one', turnId: 'b', text: 'two' })
    await runtime.handle({ id: 'ab', command: 'chat.abort', sessionId: 'one' })
    gate.resolve()
    await Promise.all([first, second])
    const reply = id => f.messages.filter(message => message.id === id)
    assert.deepEqual(reply('ab').map(message => message.type), ['aborted'])
    assert.deepEqual(reply('s1').map(message => message.type), ['aborted'], 'The submit that was already running notices the abort before submitting')
    assert.deepEqual(reply('s2').map(message => message.type), ['aborted'], 'The queued submit never starts')
    assert.equal(f.faux.state.callCount, 0, 'No model request was made')
    assert.equal(f.turn('a').length + f.turn('b').length, 0)
    f.faux.setResponses([fauxAssistantMessage('fine')])
    assert.equal((await f.chat(runtime, 'one', 'c', 'three')).at(-1).name, 'turn.done')
  } finally { gate.resolve(); await f.cleanup() }
})

test('a turn interrupted by a crash is aborted on reopen instead of replayed', async () => {
  const f = fixture()
  const first = await f.create()
  const calls = []
  try {
    await f.call(first, 'session.create', { sessionId: 'one', title: 'T' })
    f.faux.setResponses([hang(calls)])
    await f.call(first, 'chat.submit', { sessionId: 'one', turnId: 't1', text: 'do not replay' })
    await f.until(() => calls.length > 0)
    // checkpoint 关库时会中止在途请求、任务保持 pending，与进程被杀后的库状态相同。
    await f.call(first, 'checkpoint')
    assert.equal(f.turn('t1').at(-1).name, 'turn.error', 'The caller is told the reply will never finish')
    assert.equal(f.turn('t1').at(-1).code, 'closed')
    f.faux.setResponses([hang(calls)])
    const second = await f.create()
    await second.warm()
    await sleep(50)
    assert.equal(calls.length, 1, 'Reopening must not send the interrupted request again')
    f.faux.setResponses([fauxAssistantMessage('fresh')])
    assert.equal((await f.chat(second, 'one', 't2', 'next')).at(-1).text, 'fresh')
    const loaded = await f.call(second, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.messages.map(message => [message.role, message.text]), [['user', 'do not replay'], ['user', 'next'], ['assistant', 'fresh']], 'The interrupted half answer is not in the history')
  } finally { await f.cleanup() }
})

test('sessions are created lazily, indexed atomically and survive a restart', async () => {
  const f = fixture()
  const first = await f.create()
  try {
    const created = await f.call(first, 'session.create', { sessionId: 'one', title: '新会话' })
    assert.equal(created.session.id, 'one')
    assert.equal(created.session.title, '新会话')
    assert.equal(existsSync(path.join(f.sessionsDir, 'one')), false, 'An empty session has no directory')
    assert.equal(indexOf(f).sessions[0].empty, true)
    assert.equal((await f.call(first, 'session.create', { sessionId: 'one', title: 'ignored' })).session.title, '新会话', 'Creating twice is idempotent')
    const listed = await f.call(first, 'session.list')
    assert.equal(listed.currentId, 'one')
    assert.deepEqual(Object.keys(listed.sessions[0]).sort(), ['createdAt', 'hasActive', 'id', 'pendingReports', 'title', 'updatedAt'])
    const loadedEmpty = await f.call(first, 'session.load', { sessionId: 'one' })
    assert.deepEqual([loadedEmpty.messages, loadedEmpty.tasks, loadedEmpty.pendingReports], [[], [], []])
    assert.equal(existsSync(path.join(f.sessionsDir, 'one')), false, 'Loading an empty session does not create it either')

    f.faux.setResponses([fauxAssistantMessage('hi')])
    await f.chat(first, 'one', 't1', 'hello')
    assert.ok(existsSync(path.join(f.sessionsDir, 'one', 'durable.sqlite')))
    assert.equal(indexOf(f).sessions[0].empty, undefined)
    await f.call(first, 'session.create', { sessionId: 'two', title: 'Other' })
    await f.call(first, 'session.create', { sessionId: 'three', title: 'Current' })
    await f.call(first, 'checkpoint')

    const second = await f.create()
    const after = await f.call(second, 'session.list')
    assert.deepEqual(after.sessions.map(session => session.id).sort(), ['one', 'three'], 'Empty sessions other than the current one are dropped on startup')
    assert.equal(after.currentId, 'three')
  } finally { await f.cleanup() }
})

test('the index is rebuilt from the stores when it is missing or corrupt, and stale entries are dropped', async () => {
  const f = fixture()
  const first = await f.create()
  try {
    await f.call(first, 'session.create', { sessionId: 'one', title: 'Alpha' })
    f.faux.setResponses([fauxAssistantMessage('a'), fauxAssistantMessage('b')])
    await f.chat(first, 'one', 't1', 'hello')
    await f.call(first, 'session.create', { sessionId: 'two', title: 'Beta' })
    await f.chat(first, 'two', 't2', 'hello')
    assert.equal((await f.call(first, 'session.rename', { sessionId: 'two', title: 'Beta renamed' })).type, 'done')
    await f.call(first, 'checkpoint')

    rmSync(path.join(f.sessionsDir, 'index.json'))
    const second = await f.create()
    const rebuilt = await f.call(second, 'session.list')
    assert.deepEqual(rebuilt.sessions.map(session => [session.id, session.title]).sort(), [['one', 'Alpha'], ['two', 'Beta renamed']], 'Titles come back from app.session')
    assert.ok(rebuilt.currentId)
    await f.call(second, 'checkpoint')

    writeFileSync(path.join(f.sessionsDir, 'index.json'), '{ not json')
    const third = await f.create()
    assert.equal((await f.call(third, 'session.list')).sessions.length, 2)
    await f.call(third, 'checkpoint')

    // 指向不存在目录的条目被丢弃；.trash 里的残留被清空。
    const stored = indexOf(f)
    stored.sessions.push({ id: 'ghost', title: 'Ghost', createdAt: 1, updatedAt: 1, hasActive: false, pendingReports: 0 })
    writeFileSync(path.join(f.sessionsDir, 'index.json'), JSON.stringify(stored))
    mkdirSync(path.join(f.sessionsDir, '.trash', 'old-1'), { recursive: true })
    const fourth = await f.create()
    assert.deepEqual((await f.call(fourth, 'session.list')).sessions.map(session => session.id).sort(), ['one', 'two'])
    assert.deepEqual(readdirSync(path.join(f.sessionsDir, '.trash')), [])
  } finally { await f.cleanup() }
})

test('session.rename updates the index and the stored title, for open and closed sessions', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: 'Old' })
    assert.equal((await f.call(runtime, 'session.rename', { sessionId: 'one', title: 'Empty renamed' })).type, 'done', 'A session without a store only changes the index')
    f.faux.setResponses([fauxAssistantMessage('hi')])
    await f.chat(runtime, 'one', 't1', 'hello')
    assert.equal((await f.call(runtime, 'session.rename', { sessionId: 'one', title: 'New' })).type, 'done')
    assert.equal(f.events('session.updated', event => event.title === 'New').length, 1)
    assert.equal((await f.call(runtime, 'session.list')).sessions[0].title, 'New')
    assert.equal((await f.call(runtime, 'session.rename', { sessionId: 'one', title: '   ' })).code, 'invalid')
    assert.equal((await f.call(runtime, 'session.rename', { sessionId: 'nope', title: 'x' })).code, 'not_found')
  } finally { await f.cleanup() }
})

test('a handoff ends the turn at once, then its report is announced and delivered as its own turn', async () => {
  const f = fixture()
  const runtime = await f.create()
  const isChild = context => context.messages.some(message => message.role === 'system' && (message.toolsAdded ?? []).some(tool => tool.name === 'web_search'))
  const isReport = context => JSON.stringify(context.messages.at(-1)?.content ?? '').includes('amadeus_handoff_result')
  const release = deferred()
  const router = async context => {
    if (isChild(context)) { await release.promise; return fauxAssistantMessage('东京明天晴，最高 24 度。') }
    if (isReport(context)) return fauxAssistantMessage('<zh>查到了：明天晴。</zh><jp>明日は晴れだって。</jp>')
    const asked = JSON.stringify(context.messages.at(-1)?.content ?? '')
    if (asked.includes('天气')) return fauxAssistantMessage([fauxText('<zh>我让人去查。</zh><jp>調べてもらうわ。</jp>'), fauxToolCall('handoff', { kind: 'research', title: '东京天气', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
    return fauxAssistantMessage('<zh>嗯。</zh><jp>うん。</jp>')
  }
  f.faux.setResponses(Array.from({ length: 20 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    const handoffTurn = await f.chat(runtime, 'one', 't1', '帮我查一下东京明天的天气')
    assert.equal(handoffTurn.at(-1).name, 'turn.done', 'The handoff turn ends without waiting for the subagent')
    assert.deepEqual(handoffTurn.filter(event => event.name === 'turn.tool').map(event => [event.tool, event.kind, event.done]), [['handoff', 'user', false], ['handoff', 'user', true]], 'The tool name rides in `tool`: the packet\'s own name is the event name')
    const graph = f.events('task.graph').at(-1)
    assert.deepEqual(graph.tasks.map(task => [task.kind, task.title]), [['research', '东京天气']])
    assert.ok(['queued', 'running'].includes(graph.tasks[0].status))
    assert.equal(f.events('session.updated', event => event.hasActive === true).length > 0, true, 'The index is marked active')
    assert.equal((await f.chat(runtime, 'one', 't2', '谢谢')).at(-1).text, '<zh>嗯。</zh><jp>うん。</jp>', 'The user keeps chatting while the subagent works')

    release.resolve()
    await f.until(() => f.events('task.report-ready').length > 0)
    const ready = f.events('task.report-ready')[0]
    assert.deepEqual([ready.sessionId, ready.title, ready.status], ['one', '东京天气', 'done'])
    assert.equal(f.events('task.graph').at(-1).tasks[0].status, 'done')
    assert.equal((await f.call(runtime, 'session.list')).sessions[0].pendingReports, 1)
    const pending = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(pending.pendingReports, [{ id: ready.id, title: '东京天气' }])
    assert.equal(pending.tasks[0].status, 'done')

    const delivered = await f.call(runtime, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r1' })
    assert.equal(delivered.status, 'started')
    assert.equal(delivered.card.title, '东京天气')
    assert.match(delivered.card.summary, /东京明天晴/)
    const events = await f.settled('r1')
    assert.equal(events.at(-1).name, 'turn.done')
    assert.ok(events.every(event => event.kind === 'report'))
    assert.equal(events.at(-1).text, '<zh>查到了：明天晴。</zh><jp>明日は晴れだって。</jp>')
    assert.equal((await f.call(runtime, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r2' })).status, 'already', 'A report is delivered once')
    await runtime.handle({ id: 'flat', command: 'report.deliver', sessionId: 'one', outboxId: ready.id, turnId: 'r2b' })
    assert.deepEqual(f.messages.filter(message => message.id === 'flat').map(message => [message.type, message.status]), [['done', 'already']], 'The flat form takes outboxId in place of the clashing id')
    assert.equal((await f.call(runtime, 'report.deliver', { sessionId: 'one', id: 'nope', turnId: 'r3' })).status, 'missing')
    await f.until(() => indexOf(f).sessions[0].pendingReports === 0)

    const loaded = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.messages.map(message => [message.role, message.text]), [
      ['user', '帮我查一下东京明天的天气'],
      ['assistant', '我让人去查。'],
      ['user', '谢谢'],
      ['assistant', '嗯。'],
      ['card', loaded.messages[4].text],
      ['assistant', '查到了：明天晴。'],
    ], 'The report input shows as a card, never as a user bubble; assistant text is the display channel')
    assert.equal(loaded.messages[4].card.taskId, ready.id)
    assert.deepEqual(loaded.pendingReports, [])
  } finally { release.resolve(); await f.cleanup() }
})

test('report.deliver never aborts another run: it answers busy, and the report stays pending', async () => {
  const f = fixture()
  const runtime = await f.create()
  const calls = []
  const isChild = context => context.messages.some(message => message.role === 'system' && (message.toolsAdded ?? []).some(tool => tool.name === 'web_search'))
  const isReport = context => JSON.stringify(context.messages.at(-1)?.content ?? '').includes('amadeus_handoff_result')
  const router = async (context, options) => {
    if (isChild(context)) return fauxAssistantMessage('结论：已完成。')
    if (isReport(context)) return fauxAssistantMessage('<zh>汇报。</zh><jp>報告。</jp>')
    const asked = JSON.stringify(context.messages.at(-1)?.content ?? '')
    if (asked.includes('委托')) return fauxAssistantMessage([fauxText('好。'), fauxToolCall('handoff', { kind: 'research', title: '查资料', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
    return hang(calls)(context, options)
  }
  f.faux.setResponses(Array.from({ length: 20 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '请委托')
    await f.until(() => f.events('task.report-ready').length > 0)
    const ready = f.events('task.report-ready')[0]
    await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 't2', text: '慢慢想' })
    await f.until(() => calls.length > 0)
    const busy = await f.call(runtime, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r1' })
    assert.equal(busy.type, 'error')
    assert.equal(busy.code, 'busy')
    assert.equal(f.turn('t2').some(event => event.name === 'turn.aborted'), false, 'The running turn was left alone')
    assert.equal((await f.call(runtime, 'session.list')).sessions[0].pendingReports, 1, 'The report stays pending')
    await f.call(runtime, 'chat.abort', { sessionId: 'one' })
    await f.settled('t2')
    const retry = await f.call(runtime, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r2' })
    assert.equal(retry.status, 'started')
    assert.equal((await f.settled('r2')).at(-1).name, 'turn.done')
  } finally { await f.cleanup() }
})

test('a new chat.submit takes priority over a leftover report turn', async () => {
  const f = fixture()
  const runtime = await f.create()
  const calls = []
  const isChild = context => context.messages.some(message => message.role === 'system' && (message.toolsAdded ?? []).some(tool => tool.name === 'web_search'))
  const isReport = context => JSON.stringify(context.messages.at(-1)?.content ?? '').includes('amadeus_handoff_result')
  const router = async (context, options) => {
    if (isChild(context)) return fauxAssistantMessage('结论：已完成。')
    if (isReport(context)) return hang(calls)(context, options)
    const asked = JSON.stringify(context.messages.at(-1)?.content ?? '')
    if (asked.includes('委托')) return fauxAssistantMessage([fauxText('好。'), fauxToolCall('handoff', { kind: 'research', title: '查资料', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
    return fauxAssistantMessage('<zh>在。</zh><jp>いるよ。</jp>')
  }
  f.faux.setResponses(Array.from({ length: 20 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '请委托')
    await f.until(() => f.events('task.report-ready').length > 0)
    const ready = f.events('task.report-ready')[0]
    assert.equal((await f.call(runtime, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r1' })).status, 'started')
    await f.until(() => calls.length > 0)
    const events = await f.chat(runtime, 'one', 't2', '在吗')
    assert.equal(events.at(-1).name, 'turn.done')
    assert.equal((await f.settled('r1')).at(-1).name, 'turn.aborted', 'The interrupted report turn is not redelivered')
    assert.equal(f.turn('r1').at(-1).kind, 'report')
  } finally { await f.cleanup() }
})

test('session.load rebuilds the history: user, display-channel assistant, no memory entries, no interrupted answers', async () => {
  const f = fixture({
    memory: {
      // 与真实记忆服务一致：围栏文本以自定义 kind 的 user 条目写进根对话。
      prepare: async ({ conversation, context, options }) => {
        if (options.turn !== 1) return
        await conversation.commit(tx => tx.appendEntry(conversation.id, {
          kind: 'amadeus.memory-snapshot',
          model: [{ role: 'user', content: '<amadeus_core_memory>主人喜欢咖啡</amadeus_core_memory>', timestamp: Date.now() }],
          data: { v: 1 },
        }), context)
      },
    },
  })
  const runtime = await f.create()
  const calls = []
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([
      fauxAssistantMessage('[EMO preset=smile]<zh>你好呀</zh><jp>こんにちは</jp>'),
      hang(calls),
      fauxAssistantMessage('<zh>第二句</zh><jp>にばんめ</jp>'),
    ])
    await f.chat(runtime, 'one', 't1', '早上好')
    await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 't2', text: '会被打断的问题' })
    await f.until(() => calls.length > 0)
    await f.call(runtime, 'chat.abort', { sessionId: 'one' })
    await f.settled('t2')
    await f.chat(runtime, 'one', 't3', '继续')
    const loaded = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.messages.map(message => [message.role, message.text]), [
      ['user', '早上好'],
      ['assistant', '你好呀'],
      ['user', '会被打断的问题'],
      ['user', '继续'],
      ['assistant', '第二句'],
    ])
    assert.ok(loaded.messages.every(message => typeof message.id === 'string' && message.id))
    assert.equal(new Set(loaded.messages.map(message => message.id)).size, loaded.messages.length)
    assert.ok(loaded.messages.every(message => message.turnId === undefined), 'History entries carry no turnId')
    assert.doesNotMatch(JSON.stringify(loaded), /咖啡|amadeus_/)
    assert.equal(loaded.session.id, 'one')
  } finally { await f.cleanup() }
})

test('only one process may hold the session storage, and checkpoint hands it over', async () => {
  const f = fixture()
  const first = await f.create()
  try {
    const lock = path.join(f.sessionsDir, '.lock')
    const held = JSON.parse(readFileSync(lock, 'utf8'))
    assert.equal(held.pid, process.pid)
    await f.call(first, 'checkpoint')
    assert.equal(existsSync(lock), false, 'checkpoint releases the lock')
    assert.equal((await f.call(first, 'checkpoint')).type, 'done', 'checkpoint is idempotent')

    // 存活的其它进程持有锁：不开库、启动失败。
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))
    const blocked = new DurableRuntime({ models: f.models, agentDir: f.agentDir, sessionsDir: f.sessionsDir, post() {}, lockWaitMs: 60, log() {}, createMemory: fakeMemory([]) })
    await assert.rejects(blocked.start(), /held by process/)
    assert.equal(existsSync(path.join(f.sessionsDir, 'index.json')), existsSync(path.join(f.sessionsDir, 'index.json')))
    rmSync(lock)

    // closed 状态只认 checkpoint 与 resume。
    const closed = await f.call(first, 'chat.submit', { sessionId: 'one', turnId: 't1', text: 'hi' })
    assert.deepEqual([closed.type, closed.code], ['error', 'closed'])
    assert.equal((await f.call(first, 'session.list')).code, 'closed')
    assert.equal((await f.call(first, 'memory.list')).code, 'closed')
    assert.equal((await f.call(first, 'chat.abort', { sessionId: 'one' })).type, 'aborted')
    assert.equal((await f.call(first, 'resume')).type, 'done')
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid, 'resume takes the lock again')
    await f.call(first, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([fauxAssistantMessage('back')])
    assert.equal((await f.chat(first, 'one', 't2', 'hi')).at(-1).text, 'back')
    assert.equal((await f.call(first, 'resume')).type, 'done', 'resume while running is a no-op')
  } finally { await f.cleanup() }
})

test('resume fails while a live process still holds the lock, and a stale lock is reclaimed', async () => {
  const f = fixture()
  const first = await f.create()
  try {
    await f.call(first, 'checkpoint')
    const lock = path.join(f.sessionsDir, '.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))
    const failed = await f.call(first, 'resume')
    assert.deepEqual([failed.type, failed.code], ['error', 'failed'])
    assert.match(failed.error, /held by process/)
    writeFileSync(lock, '999999')
    assert.equal((await f.call(first, 'resume')).type, 'done', 'A lock left by a dead process (plain pid format too) is reclaimed')
    await f.call(first, 'checkpoint')
    writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: 1 }))
    const second = await f.create()
    await f.call(second, 'checkpoint')
  } finally { await f.cleanup() }
})

test('memory.* is forwarded to the memory lane, and checkpoint closes the service while resume builds a new one', async () => {
  const f = fixture({ memory: { handle: async (command, params) => command === 'memory.reject' ? { ok: false, code: 'not_found', error: '没有这条记忆' } : { ok: true, echoed: params } } })
  const runtime = await f.create()
  try {
    const ok = await f.call(runtime, 'memory.write', { sessionId: 'one', body: '喜欢咖啡' })
    assert.deepEqual([ok.type, ok.ok, ok.echoed], ['done', true, { sessionId: 'one', body: '喜欢咖啡' }], 'The command envelope is stripped from the params')
    assert.equal(ok.id !== undefined, true)
    assert.equal(f.events('memory.changed').length, 1, 'The service posts its own events')
    const rejected = await f.call(runtime, 'memory.reject', { id: 'x' })
    assert.deepEqual([rejected.type, rejected.ok, rejected.code], ['done', false, 'not_found'], 'Business failures stay a done reply')
    assert.deepEqual(f.memoryLog.filter(entry => entry.call === 'handle').map(entry => entry.command), ['memory.write', 'memory.reject'])
    await f.call(runtime, 'checkpoint')
    assert.equal(f.memoryLog.filter(entry => entry.call === 'close').length, 1)
    await f.call(runtime, 'resume')
    assert.equal(f.memoryLog.filter(entry => entry.call === 'create').length, 2)
    assert.equal((await f.call(runtime, 'memory.list')).type, 'done')
  } finally { await f.cleanup() }
})

test('deleting a session removes its directory and it does not come back', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: 'Doomed' })
    await f.call(runtime, 'session.create', { sessionId: 'two', title: 'Kept' })
    f.faux.setResponses([fauxAssistantMessage('hi'), fauxAssistantMessage('hi')])
    await f.chat(runtime, 'one', 't1', 'hello')
    await f.chat(runtime, 'two', 't2', 'hello')
    await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.ok(existsSync(path.join(f.sessionsDir, 'one', 'durable.sqlite')))
    const deleted = await f.call(runtime, 'session.delete', { sessionId: 'one' })
    assert.equal(deleted.type, 'done')
    assert.equal(existsSync(path.join(f.sessionsDir, 'one')), false)
    assert.deepEqual(readdirSync(path.join(f.sessionsDir, '.trash')), [], 'The trash is cleaned right after')
    assert.equal(f.events('session.updated', event => event.sessionId === 'one' && event.deleted === true).length, 1)
    const listed = await f.call(runtime, 'session.list')
    assert.deepEqual(listed.sessions.map(session => session.id), ['two'])
    assert.equal(listed.currentId, 'two', 'The current session moves to the next one')
    assert.equal((await f.call(runtime, 'session.delete', { sessionId: 'one' })).code, 'not_found')
    assert.equal((await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 'x', text: 'again' })).code, 'not_found', 'A deleted session is not recreated by a late submit')
    assert.equal(existsSync(path.join(f.sessionsDir, 'one')), false)
    await f.call(runtime, 'checkpoint')
    const reopened = await f.create()
    assert.deepEqual((await f.call(reopened, 'session.list')).sessions.map(session => session.id), ['two'])
  } finally { await f.cleanup() }
})

test('a kill in the middle of a delete never resurrects the session', async () => {
  const f = fixture()
  const first = await f.create()
  try {
    await f.call(first, 'session.create', { sessionId: 'one', title: 'A' })
    await f.call(first, 'session.create', { sessionId: 'two', title: 'B' })
    f.faux.setResponses([fauxAssistantMessage('a'), fauxAssistantMessage('b')])
    await f.chat(first, 'one', 't1', 'hello')
    await f.chat(first, 'two', 't2', 'hello')
    await f.call(first, 'checkpoint')
    // 3 与 4 之间被杀：目录已进 .trash，索引还指着它。
    mkdirSync(path.join(f.sessionsDir, '.trash'), { recursive: true })
    const fs = await import('node:fs')
    fs.renameSync(path.join(f.sessionsDir, 'one'), path.join(f.sessionsDir, '.trash', 'one-1'))
    const second = await f.create()
    assert.deepEqual((await f.call(second, 'session.list')).sessions.map(session => session.id), ['two'])
    assert.deepEqual(readdirSync(path.join(f.sessionsDir, '.trash')), [])
    await f.call(second, 'checkpoint')
    // 4 之后被杀：只剩 .trash。
    mkdirSync(path.join(f.sessionsDir, '.trash', 'three-2'), { recursive: true })
    const third = await f.create()
    assert.deepEqual(readdirSync(path.join(f.sessionsDir, '.trash')), [])
    assert.equal((await f.call(third, 'session.list')).sessions.length, 1)
  } finally { await f.cleanup() }
})

test('deleting a session aborts its running subagent and removes the directory', async () => {
  const f = fixture()
  const runtime = await f.create()
  const isChild = context => context.messages.some(message => message.role === 'system' && (message.toolsAdded ?? []).some(tool => tool.name === 'web_search'))
  const childCalls = []
  const router = async (context, options) => {
    if (isChild(context)) return hang(childCalls)(context, options)
    return fauxAssistantMessage([fauxText('好。'), fauxToolCall('handoff', { kind: 'research', title: '查资料', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
  }
  f.faux.setResponses(Array.from({ length: 10 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '请委托')
    await f.until(() => childCalls.length > 0)
    assert.equal((await f.call(runtime, 'session.list')).sessions[0].hasActive, true)
    const started = Date.now()
    assert.equal((await f.call(runtime, 'session.delete', { sessionId: 'one' })).type, 'done')
    assert.ok(Date.now() - started < 9000, 'The running subagent is aborted instead of waited for')
    assert.equal(existsSync(path.join(f.sessionsDir, 'one')), false)
    assert.deepEqual((await f.call(runtime, 'session.list')).sessions, [])
  } finally { await f.cleanup() }
})

test('model.list and model.set read and write the three default-model keys of settings.json', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    const model = f.faux.getModel()
    const set = await f.call(runtime, 'model.set', { model: `${model.provider}/${model.id}` })
    assert.equal(set.type, 'done')
    assert.equal(set.current, `${model.provider}/${model.id}`)
    assert.ok(set.models.some(entry => entry.value === set.current))
    assert.ok(Array.isArray(set.thinkingLevels))
    const stored = JSON.parse(readFileSync(path.join(f.agentDir, 'settings.json'), 'utf8'))
    assert.equal(stored.defaultProvider, model.provider)
    assert.equal(stored.defaultModel, model.id)
    const level = set.thinkingLevels.find(each => each !== set.thinkingLevel)
    if (level) {
      const changed = await f.call(runtime, 'model.set', { model: `${model.provider}/${model.id}`, thinkingLevel: level })
      assert.equal(changed.thinkingLevel, level)
      assert.equal(JSON.parse(readFileSync(path.join(f.agentDir, 'settings.json'), 'utf8')).defaultThinkingLevel, level)
    }
    const listed = await f.call(runtime, 'model.list', {})
    assert.equal(listed.current, set.current)
    const unknown = await f.call(runtime, 'model.set', { model: 'missing/none' })
    assert.deepEqual([unknown.type, unknown.code], ['error', 'invalid'])
    assert.match(unknown.error, /Unknown model/)
    assert.equal((await f.call(runtime, 'model.set', { model: `${model.provider}/${model.id}`, thinkingLevel: 'nope' })).code, 'invalid')
    assert.equal((await f.call(runtime, 'reload')).type, 'done')
  } finally { await f.cleanup() }
})

test('the selected model reaches the conversation on the next submit', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([fauxAssistantMessage('a')])
    await f.chat(runtime, 'one', 't1', 'hello')
    const model = f.faux.getModel()
    await f.call(runtime, 'model.set', { model: `${model.provider}/${model.id}` })
    const level = (await f.call(runtime, 'model.list', {})).thinkingLevels.find(each => each !== 'medium')
    if (!level) return
    await f.call(runtime, 'model.set', { model: `${model.provider}/${model.id}`, thinkingLevel: level })
    f.faux.setResponses([fauxAssistantMessage('b')])
    await f.chat(runtime, 'one', 't2', 'again')
    const open = runtime.host.peek('one')
    assert.equal((await open.root.agent(ctx)).thinkingLevel, level)
  } finally { await f.cleanup() }
})

test('invalid and unknown targets get a precise error code before touching the file system', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    const escape = await f.call(runtime, 'chat.submit', { sessionId: '../escape', turnId: 't1', text: 'hi' })
    assert.deepEqual([escape.type, escape.code], ['error', 'invalid'])
    assert.equal(existsSync(path.join(f.root, 'escape')), false)
    assert.equal((await f.call(runtime, 'session.create', { sessionId: 'a/b', title: '' })).code, 'invalid')
    assert.equal((await f.call(runtime, 'session.delete', { sessionId: '..' })).code, 'invalid')
    assert.equal((await f.call(runtime, 'chat.submit', { sessionId: 'ghost', turnId: 't1', text: 'hi' })).code, 'not_found')
    assert.equal((await f.call(runtime, 'session.load', { sessionId: 'ghost' })).code, 'not_found')
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    assert.equal((await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: '', text: 'hi' })).code, 'invalid')
    assert.equal((await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 't', text: '' })).code, 'invalid')
    assert.equal((await f.call(runtime, 'prompt', { sessionId: 'one', text: 'hi' })).code, 'invalid', 'The pre-A1 command names are gone')
    assert.equal((await f.call(runtime, 'task.cancel', { sessionId: 'one', taskId: 't_01' })).code, 'not_found', 'An empty session has no store and no tasks')
    assert.equal(existsSync(path.join(f.sessionsDir, 'one')), false, 'Task commands do not create the store of an empty session')
    f.faux.setResponses([fauxAssistantMessage('hi')])
    await f.chat(runtime, 'one', 't1', 'hi')
    assert.equal((await f.call(runtime, 'task.cancel', { sessionId: 'one', taskId: 't_99' })).code, 'not_found')
    assert.equal((await f.call(runtime, 'task.approve', { sessionId: 'one', taskId: 't_99', approvalId: '1', allow: true })).code, 'not_found')
    assert.equal((await f.call(runtime, 'task.approve', { sessionId: 'one', taskId: 't_99', approvalId: '1' })).code, 'invalid')
  } finally { await f.cleanup() }
})

test('task.cancel stops a running subagent: the card turns cancelled and no report is left', async () => {
  const f = fixture()
  const runtime = await f.create()
  const isChild = context => context.messages.some(message => message.role === 'system' && (message.toolsAdded ?? []).some(tool => tool.name === 'web_search'))
  const childCalls = []
  const router = async (context, options) => {
    if (isChild(context)) return hang(childCalls)(context, options)
    return fauxAssistantMessage([fauxText('好。'), fauxToolCall('handoff', { kind: 'research', title: '查资料', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
  }
  f.faux.setResponses(Array.from({ length: 10 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '请委托')
    await f.until(() => childCalls.length > 0)
    const taskId = f.events('task.graph').at(-1).tasks[0].taskId
    const cancelled = await f.call(runtime, 'task.cancel', { sessionId: 'one', taskId })
    assert.deepEqual([cancelled.type, cancelled.status], ['done', 'cancelling'])
    await f.until(() => f.events('task.graph').at(-1).tasks[0].status === 'cancelled')
    assert.equal(f.events('task.report-ready').length, 0, 'Cancelling produces no report')
    assert.equal((await f.call(runtime, 'task.cancel', { sessionId: 'one', taskId })).status, 'terminal')
    await f.until(() => indexOf(f).sessions[0].hasActive === false)
  } finally { await f.cleanup() }
})

test('idle sessions are closed and reopen with their history; the current and active ones stay open', async () => {
  const f = fixture({ runtime: { idleCloseMs: 40, sweepMs: 15 } })
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: 'One' })
    f.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    await f.chat(runtime, 'one', 't1', 'hello')
    await f.call(runtime, 'session.create', { sessionId: 'two', title: 'Two' })
    await f.chat(runtime, 'two', 't2', 'hello')
    assert.equal((await f.call(runtime, 'session.list')).currentId, 'two')
    await f.until(() => !runtime.host.openIds().includes('one'))
    assert.deepEqual(runtime.host.openIds(), ['two'], 'The current session is never reclaimed')
    const loaded = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.messages.map(message => message.text), ['hello', 'first'])
    assert.deepEqual(runtime.host.openIds().sort(), ['one', 'two'])
    await f.until(() => !runtime.host.openIds().includes('two'))
    assert.deepEqual(runtime.host.openIds(), ['one'], 'Loading moves the current session')
  } finally { await f.cleanup() }
})

test('the number of open sessions is capped by closing the least recently used idle one', async () => {
  const f = fixture({ runtime: { maxOpen: 2 } })
  const runtime = await f.create()
  try {
    f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('ok')))
    for (const id of ['a', 'b', 'c']) {
      await f.call(runtime, 'session.create', { sessionId: id, title: id })
      await f.chat(runtime, id, `t-${id}`, 'hello')
    }
    assert.ok(runtime.host.openIds().length <= 2)
    assert.ok(runtime.host.openIds().includes('c'))
    assert.equal((await f.call(runtime, 'session.load', { sessionId: 'a' })).messages.length, 2, 'An evicted session reopens with its history')
  } finally { await f.cleanup() }
})

test('a poisoned store is closed and reopened instead of failing every later command', async () => {
  let failNext = false
  const f = fixture({
    runtime: {
      openStorage: async file => {
        const storage = await openNodeSqliteStorage(file)
        const commit = storage.commit.bind(storage)
        storage.commit = async (...args) => {
          if (failNext) { failNext = false; throw new Error('SQLITE_BUSY: database is locked') }
          return commit(...args)
        }
        return storage
      },
    },
  })
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    await f.chat(runtime, 'one', 't1', 'hello')
    const before = runtime.host.peek('one')
    failNext = true
    const failed = await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 't2', text: 'boom' })
    assert.deepEqual([failed.type, failed.code], ['error', 'failed'])
    assert.equal(f.turn('t2').length, 0)
    const events = await f.chat(runtime, 'one', 't3', 'after')
    assert.equal(events.at(-1).text, 'second', 'The next command works on a reopened store')
    assert.notEqual(runtime.host.peek('one'), before)
    const loaded = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.messages.map(message => message.text), ['hello', 'first', 'after', 'second'])
  } finally { await f.cleanup() }
})

test('the main conversation offers only delegation tools and the subagent gets neither the persona nor delegation', async () => {
  const f = fixture()
  const runtime = await f.create()
  const tools = context => context.messages.flatMap(message => message.role === 'system' ? (message.toolsAdded ?? []).map(tool => tool.name) : []).sort()
  const systemText = context => context.messages.filter(message => message.role === 'system')
    .map(message => [typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join(''), ...Object.values(message.sections ?? {})].join('\n')).join('\n')
  const seen = { main: [], child: [] }
  const router = async context => {
    if (tools(context).includes('web_search')) { seen.child.push(context); return fauxAssistantMessage('结论：已完成。') }
    seen.main.push(context)
    if (seen.main.length === 1) return fauxAssistantMessage([fauxText('<zh>我让人去查。</zh><jp>調べてもらうわ。</jp>'), fauxToolCall('handoff', { kind: 'research', title: '查资料', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
    return fauxAssistantMessage('<zh>好。</zh><jp>うん。</jp>')
  }
  f.faux.setResponses(Array.from({ length: 10 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '帮我查一下东京明天的天气')
    await f.until(() => seen.child.length > 0)
    assert.deepEqual(tools(seen.main[0]), ['handoff', 'handoff_cancel', 'handoff_send', 'handoff_status'], 'No built-in read / bash / edit / write in the main conversation')
    assert.match(systemText(seen.main[0]), /## Boundaries/)
    assert.match(systemText(seen.main[0]), /You are Amadeus/)
    assert.deepEqual(tools(seen.child[0]), ['report_progress', 'web_fetch', 'web_search'], 'The subagent cannot delegate again')
    assert.doesNotMatch(systemText(seen.child[0]), /You are Amadeus|## Boundaries/, 'The subagent does not inherit the persona prompt')
    assert.match(systemText(seen.child[0]), /background task assistant/)
  } finally { await f.cleanup() }
})

test('the session index coalesces frequent updates, writes atomically and reports observable changes only', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'amadeus-index-'))
  try {
    const index = new SessionIndex(directory)
    assert.equal(index.load(), 'missing')
    index.add({ id: 'one', title: 'One', createdAt: 1, updatedAt: 1, hasActive: false, pendingReports: 0, empty: true })
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8')).sessions[0].empty, true, 'Registering is written at once')
    assert.equal(index.update('one', { hasActive: false })?.changed, false)
    assert.equal(index.update('one', { hasActive: true })?.changed, true)
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8')).sessions[0].hasActive, false, 'Frequent fields wait for the 200ms window')
    index.close()
    assert.equal(JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8')).sessions[0].hasActive, true, 'close() flushes')
    assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.tmp')), [])
    const reloaded = new SessionIndex(directory)
    assert.equal(reloaded.load(), 'ok')
    assert.equal(reloaded.get('one')?.empty, true)
    writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ version: 2, sessions: [] }))
    assert.equal(new SessionIndex(directory).load(), 'corrupt')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('with the real memory service: the snapshot is injected, hidden from the history, and memory.* works end to end', async () => {
  const f = fixture({ realMemory: true })
  const runtime = await f.create()
  const seen = []
  const tools = context => context.messages.flatMap(message => message.role === 'system' ? (message.toolsAdded ?? []).map(tool => tool.name) : []).sort()
  f.faux.setResponses([context => { seen.push(context); return fauxAssistantMessage('<zh>好的</zh><jp>うん</jp>') }])
  try {
    const written = await f.call(runtime, 'memory.write', { type: 'preference', body: '主人喜欢咖啡' })
    assert.deepEqual([written.type, written.ok], ['done', true])
    assert.equal(f.events('memory.changed').length > 0, true, 'The service posts memory.changed through the worker port')
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '早上好')
    assert.match(JSON.stringify(seen[0].messages), /主人喜欢咖啡/, 'The reviewed memory reaches the model')
    assert.deepEqual(tools(seen[0]), ['forget', 'handoff', 'handoff_cancel', 'handoff_send', 'handoff_status', 'remember'])
    const loaded = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.messages.map(message => [message.role, message.text]), [['user', '早上好'], ['assistant', '好的']])
    assert.doesNotMatch(JSON.stringify(loaded), /咖啡|amadeus_/)
    const listed = await f.call(runtime, 'memory.list')
    assert.equal(listed.items.length, 1)
    const status = await f.call(runtime, 'memory.status', { sessionId: 'one' })
    assert.equal(status.enabled, true)
    assert.equal((await f.call(runtime, 'memory.configure', { enabled: false })).ok, true)
    assert.equal((await f.call(runtime, 'memory.status')).enabled, false)
  } finally { await f.cleanup() }
})

test('the event bridge diffs the whole message: first text without a delta, an overflow snapshot, no repeats', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([fauxAssistantMessage('seed')])
    await f.chat(runtime, 'one', 'seed', 'seed')
    const { bridge } = runtime.host.peek('one')
    const message = text => ({ role: 'assistant', timestamp: 1, content: [{ type: 'text', text }], stopReason: 'stop' })
    const record = (status, extra = {}) => ({ type: 'input', id: 9001, conversationId: 0, requestId: 'turn:x', status, ...extra })
    const snapshot = text => ({ type: 'snapshot', entries: [], run: { inputs: [9001] }, generation: { attempt: 1, message: message(text) }, tools: [], compactions: [], inbox: [], agent: {}, usage: {} })
    bridge.expect('turn:x', 'x')
    // 第一段文本在 message_start 里，一个 text_delta 也没有。
    bridge.batch([{ type: 'submission', record: record('placed', { entry: 5 }) }, { type: 'run_start', inputs: [9001] }, { type: 'message_start', message: message('<zh>你') }])
    // 消费者落后：整份快照里的半成品比已转发的长，只补尾部。
    bridge.batch([snapshot('<zh>你好</zh><jp>こんにちは')])
    bridge.batch([{ type: 'message_update', usage: {}, changes: [{ type: 'text_delta', contentIndex: 0, delta: '</jp>' }] }])
    bridge.batch([{ type: 'message_update', usage: {}, changes: [{ type: 'thinking_start', contentIndex: 1, block: { type: 'thinking', thinking: '秘密' } }] }])
    bridge.batch([{ type: 'message_end', entry: { id: 6, kind: 'pi.assistant', model: [message('<zh>你好</zh><jp>こんにちは</jp>')] } }])
    assert.equal(f.turn('x').length > 0, true)
    bridge.batch([{ type: 'run_end', inputs: [9001] }, { type: 'submission', record: record('done', { entry: 5, answer: 6 }) }])
    const events = f.turn('x')
    assert.deepEqual(events.map(event => event.name), ['turn.text', 'turn.text', 'turn.text', 'turn.done'])
    assert.deepEqual(events.filter(event => event.name === 'turn.text').map(event => event.delta), ['<zh>你', '好</zh><jp>こんにちは', '</jp>'])
    assert.equal(events.at(-1).text, '<zh>你好</zh><jp>こんにちは</jp>')
    assert.doesNotMatch(JSON.stringify(events), /秘密/, 'Thinking never reaches the subtitles')
    assert.equal(bridge.unsettled, 0)
  } finally { await f.cleanup() }
})

test('a withdrawn queued input settles as aborted without any run', async () => {
  const f = fixture()
  const runtime = await f.create()
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    f.faux.setResponses([fauxAssistantMessage('seed')])
    await f.chat(runtime, 'one', 'seed', 'seed')
    const { bridge } = runtime.host.peek('one')
    bridge.expect('report:r', 'rt')
    bridge.batch([{ type: 'submission', record: { type: 'input', id: 9002, conversationId: 0, requestId: 'report:r', status: 'unanswered', reason: 'aborted' } }])
    assert.deepEqual(f.turn('rt').map(event => [event.name, event.kind]), [['turn.aborted', 'report']])
    bridge.expect('turn:e', 'te')
    bridge.batch([{ type: 'submission', record: { type: 'input', id: 9003, conversationId: 0, requestId: 'turn:e', status: 'unanswered', reason: 'model_error', detail: { message: 'upstream 500' } } }])
    const failed = f.turn('te').at(-1)
    assert.deepEqual([failed.name, failed.code, failed.error], ['turn.error', 'model_error', 'upstream 500'])
  } finally { await f.cleanup() }
})

test('the worker entry wires the port protocol: ready, commands in order, lock failures reported in ready', async () => {
  const { startDurableWorker } = await import('../src/main/durable/worker.ts')
  const root = mkdtempSync(path.join(os.tmpdir(), 'amadeus-worker-'))
  const saved = { ...process.env }
  const env = {
    PI_CODING_AGENT_DIR: path.join(root, 'agent'),
    AMADEUS_NEXT_PI_AUTH: path.join(root, 'auth.json'),
    AMADEUS_NEXT_PI_MODELS: path.join(root, 'models.json'),
    AMADEUS_NEXT_SESSIONS: path.join(root, 'sessions'),
    AMADEUS_MEMORY_DIR: path.join(root, 'memory'),
  }
  const port = () => {
    const posted = []
    let listener
    return { posted, on: (_event, callback) => { listener = callback }, postMessage: value => posted.push(value), send: value => listener({ data: value }) }
  }
  try {
    Object.assign(process.env, env)
    const first = port()
    startDurableWorker(first)
    first.send({ id: 'a', command: 'session.create', params: { sessionId: 'one', title: 'Hello' } })
    first.send({ id: 'b', command: 'session.list' })
    first.send({ id: 'c', command: 'chat.abort', params: { sessionId: 'one' } })
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.deepEqual(first.posted.filter(message => message.type === 'ready'), [{ type: 'ready' }])
    assert.equal(first.posted.find(message => message.id === 'a')?.type, 'done')
    assert.deepEqual(first.posted.find(message => message.id === 'b')?.sessions.map(session => session.title), ['Hello'], 'Commands that arrive before ready run in order')
    assert.equal(first.posted.find(message => message.id === 'c')?.type, 'aborted')
    first.send({ id: 'd', command: 'checkpoint' })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(first.posted.find(message => message.id === 'd')?.type, 'done')

    // 另一个存活进程持有锁：ready 里报错，不开库；命令得到 failed。
    writeFileSync(path.join(env.AMADEUS_NEXT_SESSIONS, '.lock'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))
    const second = port()
    process.env.AMADEUS_NEXT_LOCK_WAIT_MS = '0'
    startDurableWorker(second)
    second.send({ id: 'e', command: 'session.list' })
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(second.posted.find(message => message.type === 'ready')?.error === undefined, false)
    assert.equal(second.posted.find(message => message.id === 'e')?.code, 'failed')
  } finally {
    for (const key of Object.keys(env)) delete process.env[key]
    delete process.env.AMADEUS_NEXT_LOCK_WAIT_MS
    Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([key]) => key in env)))
    rmSync(root, { recursive: true, force: true })
  }
})

/** 主对话委托一次，子代理由 child 决定怎么答，汇报回合由 report 决定。 */
function delegation({ child, report, plain }) {
  const isChild = context => context.messages.some(message => message.role === 'system' && (message.toolsAdded ?? []).some(tool => tool.name === 'web_search'))
  const isReport = context => JSON.stringify(context.messages.at(-1)?.content ?? '').includes('amadeus_handoff_result')
  return async (context, options) => {
    if (isChild(context)) return child(context, options)
    if (isReport(context)) return report(context, options)
    const asked = JSON.stringify(context.messages.at(-1)?.content ?? '')
    if (asked.includes('委托')) return fauxAssistantMessage([fauxText('好。'), fauxToolCall('handoff', { kind: 'research', title: '查资料', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
    return (plain ?? (() => fauxAssistantMessage('嗯。')))(context, options)
  }
}

test('a subagent interrupted by a restart finishes afterwards and its report is delivered exactly once', async () => {
  const f = fixture()
  const first = await f.create()
  const childCalls = []
  let restarted = false
  const router = delegation({
    child: (context, options) => restarted ? fauxAssistantMessage('结论：东京晴。') : hang(childCalls)(context, options),
    report: () => fauxAssistantMessage('<zh>查到了。</zh><jp>調べたよ。</jp>'),
  })
  f.faux.setResponses(Array.from({ length: 20 }, () => router))
  try {
    await f.call(first, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(first, 'one', 't1', '请委托')
    await f.until(() => childCalls.length > 0)
    await f.call(first, 'checkpoint')
    assert.equal(indexOf(f).sessions[0].hasActive, true, 'The index remembers that this session has work to resume')
    restarted = true
    const before = f.events('task.report-ready').length
    const second = await f.create()
    await second.warm()
    await f.until(() => f.events('task.report-ready').length > before)
    const ready = f.events('task.report-ready').at(-1)
    assert.equal(ready.sessionId, 'one')
    assert.equal((await f.call(second, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r1' })).status, 'started')
    assert.equal((await f.settled('r1')).at(-1).name, 'turn.done')
    assert.equal((await f.call(second, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r2' })).status, 'already')
    assert.equal(f.events('task.report-ready').length, before + 1, 'The report is announced once')
  } finally { await f.cleanup() }
})

test('a pending report is replayed after a restart; one crashed between the two commits is reconciled, not redelivered', async () => {
  const f = fixture()
  const first = await f.create()
  const reportCalls = []
  const router = delegation({
    child: () => fauxAssistantMessage('结论：东京晴。'),
    report: (context, options) => hang(reportCalls)(context, options),
  })
  f.faux.setResponses(Array.from({ length: 20 }, () => router))
  try {
    await f.call(first, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(first, 'one', 't1', '请委托')
    await f.until(() => f.events('task.report-ready').length > 0)
    const ready = f.events('task.report-ready')[0]
    await f.call(first, 'checkpoint')

    const second = await f.create()
    await second.warm()
    await f.until(() => f.events('task.report-ready').length > 1)
    assert.equal(f.events('task.report-ready')[1].id, ready.id, 'Existing pending reports are replayed when the session opens')
    assert.equal((await f.call(second, 'session.list')).sessions[0].pendingReports, 1)

    // 第一次提交已落库（输入进了对话、run 在跑），第二次提交（pending → delivered）之前进程死了。
    const open = second.host.peek('one')
    const outbox = await open.harness.snapshot(OutboxDoc, open.root.id, ctx)
    const item = outbox.pending[0]
    await open.root.submit({ type: 'input', content: renderReport({ ...item }, 'research'), requestId: `report:${item.id}`, whenBusy: 'reject' }, ctx)
    await f.until(() => reportCalls.length > 0)
    await f.call(second, 'checkpoint')

    const before = f.events('task.report-ready').length
    const third = await f.create()
    await third.warm()
    await sleep(50)
    assert.equal(reportCalls.length, 1, 'The interrupted report run is aborted, not replayed')
    assert.equal(f.events('task.report-ready').length, before, 'It is no longer pending, so it is not announced again')
    const listed = await f.call(third, 'session.list')
    assert.equal(listed.sessions[0].pendingReports, 0)
    assert.equal((await f.call(third, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r1' })).status, 'already')
    const loaded = await f.call(third, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.messages.map(message => message.role), ['user', 'assistant', 'card'], 'The reconciled report shows as a card')
  } finally { await f.cleanup() }
})

test('approval requests of a running subagent reach the main process and are answered by task.approve', async () => {
  const f = fixture()
  const runtime = await f.create()
  const childCalls = []
  f.faux.setResponses(Array.from({ length: 10 }, () => delegation({ child: hang(childCalls), report: () => fauxAssistantMessage('x') })))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '请委托')
    await f.until(() => childCalls.length > 0)
    const open = runtime.host.peek('one')
    const handoffs = await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)
    const { taskId, child } = handoffs.items[0]
    await open.harness.commit(async tx => {
      const approvals = await tx.doc(ApprovalsDoc, child)
      approvals.items['77'] = { tool: 'bash', summary: '运行 ls', detail: { command: 'ls' }, state: 'pending', requestedAt: Date.now(), expiresAt: Date.now() + 60_000 }
    }, ctx)
    await f.until(() => f.events('task.approval-request').length > 0)
    const request = f.events('task.approval-request')[0]
    assert.deepEqual([request.sessionId, request.taskId, request.approvalId, request.summary], ['one', taskId, '77', '运行 ls'])
    assert.equal(typeof request.expiresAt, 'number')
    assert.equal((await f.call(runtime, 'task.approve', { sessionId: 'one', taskId, approvalId: '77', allow: false })).type, 'done')
    await f.until(() => f.events('task.approval-resolved').length > 0)
    assert.deepEqual(f.events('task.approval-resolved').map(event => [event.taskId, event.approvalId, event.state]), [[taskId, '77', 'deny']])
    assert.equal((await f.call(runtime, 'task.approve', { sessionId: 'one', taskId, approvalId: '77', allow: true })).code, 'not_found', 'A second click finds nothing pending')
  } finally { await f.cleanup() }
})

test('the handoff path guard denies the app directories even when the environment names do not match', async () => {
  const f = fixture()
  const runtime = await f.create()
  const memoryDir = path.join(f.root, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(f.agentDir, { recursive: true })
  mkdirSync(f.sessionsDir, { recursive: true })
  const seen = []
  const askFor = paths => fauxAssistantMessage([fauxToolCall('handoff', { kind: 'files', title: '看文件', brief: '看一下这些文件里写了什么，给出摘要。', paths })], { stopReason: 'toolUse' })
  let call = 0
  const router = async context => {
    call += 1
    seen.push(JSON.stringify(context.messages.at(-1) ?? ''))
    if (call === 1) return askFor([f.sessionsDir])
    if (call === 2) return askFor([f.root])
    if (call === 3) return askFor([memoryDir])
    if (call === 4) return askFor([f.agentDir])
    return fauxAssistantMessage('<zh>不行。</zh><jp>だめ。</jp>')
  }
  f.faux.setResponses(Array.from({ length: 10 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '看看应用数据')
    for (const reply of seen.slice(1, 5)) assert.match(reply, /cannot be given to a subagent \(app data\)/, reply)
    assert.deepEqual(f.events('task.graph'), [], 'No subagent was started for any of them')
  } finally { await f.cleanup() }
})

test('memory.configure survives checkpoint and resume: the rebuilt service keeps the switches instead of the defaults', async () => {
  const f = fixture()
  const runtime = await f.create()
  const creates = () => f.memoryLog.filter(entry => entry.call === 'create')
  try {
    assert.deepEqual(creates(), [{ call: 'create', enabled: undefined, recall: undefined }], 'Nothing was configured yet: the service starts from its own defaults')
    assert.equal((await f.call(runtime, 'memory.configure', { enabled: false, recall: 'off' })).ok, true)
    await f.call(runtime, 'checkpoint')
    await f.call(runtime, 'resume')
    assert.deepEqual(creates().at(-1), { call: 'create', enabled: false, recall: 'off' })

    // 只改一项不会冲掉另一项；不合法的参数整条作废，也不被记住。
    await f.call(runtime, 'memory.configure', { recall: 'on' })
    await f.call(runtime, 'memory.configure', { enabled: 'yes', recall: 'log' })
    await f.call(runtime, 'memory.configure', { recall: 'sometimes' })
    await f.call(runtime, 'checkpoint')
    await f.call(runtime, 'resume')
    assert.deepEqual(creates().at(-1), { call: 'create', enabled: false, recall: 'on' })

    await f.call(runtime, 'memory.configure', { enabled: true })
    await f.call(runtime, 'checkpoint')
    await f.call(runtime, 'resume')
    assert.deepEqual(creates().at(-1), { call: 'create', enabled: true, recall: 'on' })
  } finally { await f.cleanup() }
})

test('a rebuild of the missing index runs after start() returns; commands and the checkpoint wait for it', async () => {
  const f = fixture()
  const first = await f.create()
  f.faux.setResponses([fauxAssistantMessage('a'), fauxAssistantMessage('b')])
  await f.call(first, 'session.create', { sessionId: 'one', title: '第一个' })
  await f.chat(first, 'one', 't1', 'hi')
  await f.call(first, 'session.create', { sessionId: 'two', title: '第二个' })
  await f.chat(first, 'two', 't2', 'hi')
  await f.call(first, 'checkpoint')
  rmSync(path.join(f.sessionsDir, 'index.json'))

  const gate = deferred()
  const opened = []
  let second
  try {
    second = await f.create({ openStorage: async file => { opened.push(file); await gate.promise; return openNodeSqliteStorage(file) } })
    // start() 已经返回（worker 据此发 ready），重建还卡在开库上。
    assert.equal(opened.length > 0, true, 'The rebuild is under way')
    const listing = f.call(second, 'session.list')
    const checkpoint = f.call(second, 'checkpoint')
    const settled = []
    void listing.then(() => settled.push('list'))
    void checkpoint.then(() => settled.push('checkpoint'))
    await sleep(80)
    assert.deepEqual(settled, [], 'Neither command answers from a half-built index')
    gate.resolve()
    assert.deepEqual((await listing).sessions.map(session => session.title).sort(), ['第一个', '第二个'])
    await checkpoint
    assert.deepEqual(settled, ['list', 'checkpoint'])
    assert.equal(existsSync(path.join(f.sessionsDir, '.lock')), false, 'The lock is released only after the rebuild stopped opening stores')
  } finally { gate.resolve(); await f.cleanup() }
})

test('approvals voided by a restart are announced as expired so the card stops asking', async () => {
  const f = fixture()
  const first = await f.create()
  const childCalls = []
  f.faux.setResponses(Array.from({ length: 10 }, () => delegation({ child: hang(childCalls), report: () => fauxAssistantMessage('x') })))
  try {
    await f.call(first, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(first, 'one', 't1', '请委托')
    await f.until(() => childCalls.length > 0)
    const open = first.host.peek('one')
    const { taskId, child } = (await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)).items[0]
    await open.harness.commit(async tx => {
      const approvals = await tx.doc(ApprovalsDoc, child)
      approvals.items['77'] = { tool: 'bash', summary: '运行 ls', detail: { tool: 'bash', command: 'ls' }, state: 'pending', requestedAt: Date.now(), expiresAt: Date.now() + 60_000 }
      approvals.items['78'] = { tool: 'bash', summary: '运行 pwd', detail: { tool: 'bash', command: 'pwd' }, state: 'allow', by: 'user', requestedAt: Date.now(), expiresAt: Date.now() + 60_000 }
    }, ctx)
    await f.until(() => f.events('task.approval-request').length > 0)
    await f.call(first, 'checkpoint')
    assert.equal(f.events('task.approval-resolved').length, 0, 'Nothing was decided before the restart')

    const second = await f.create()
    await second.warm()
    await f.until(() => f.events('task.approval-resolved').length > 0)
    assert.deepEqual(f.events('task.approval-resolved').map(event => [event.sessionId, event.taskId, event.approvalId, event.state]), [['one', taskId, '77', 'expired']], 'Only the pending one is announced')
    await sleep(50)
    assert.equal(f.events('task.approval-resolved').length, 1, 'Once')
  } finally { await f.cleanup() }
})

test('a Reporter that faulted is cleaned up when the bridge sees it: the entry fails as lost and is reported once', async () => {
  const f = fixture()
  const runtime = await f.create()
  const granted = mkdtempSync(path.join(os.tmpdir(), 'amadeus-granted-'))
  const router = async context => {
    const asked = JSON.stringify(context.messages.at(-1)?.content ?? '')
    if (asked.includes('委托')) return fauxAssistantMessage([fauxText('好。'), fauxToolCall('handoff', { kind: 'files', title: '读文件', brief: '读一下这个目录里的文件，给出摘要。', paths: [granted] })], { stopReason: 'toolUse' })
    return fauxAssistantMessage('<zh>嗯。</zh><jp>うん。</jp>')
  }
  f.faux.setResponses(Array.from({ length: 10 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    // 先让会话落地，再把任务私有目录的父目录换成一个文件：Reporter 在 deliver 阶段 mkdir(cwd) 必然抛错。
    f.faux.setResponses([fauxAssistantMessage('seed')])
    await f.chat(runtime, 'one', 'seed', 'seed')
    writeFileSync(path.join(f.sessionsDir, 'one', 'handoff'), 'not a directory')
    f.faux.setResponses(Array.from({ length: 10 }, () => router))
    await f.chat(runtime, 'one', 't1', '请委托')
    await f.until(() => f.events('task.report-ready').length > 0)
    const ready = f.events('task.report-ready')[0]
    assert.equal(ready.status, 'failed')
    const open = runtime.host.peek('one')
    const handoffs = await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)
    assert.deepEqual([handoffs.items[0].status, handoffs.items[0].failure.reason], ['failed', 'lost'])
    assert.equal(f.events('task.graph').at(-1).tasks[0].status, 'failed')
    await sleep(100)
    assert.equal(f.events('task.report-ready').length, 1, 'The report is written and announced once')
    const outbox = await open.harness.snapshot(OutboxDoc, open.root.id, ctx)
    assert.equal(outbox.pending.filter(item => item.id === ready.id).length, 1)
    await f.until(() => indexOf(f).sessions[0].hasActive === false)
  } finally { rmSync(granted, { recursive: true, force: true }); await f.cleanup() }
})

test('the idle sweep also runs the cleaner for sessions that stay open', async () => {
  const f = fixture()
  const runtime = await f.create({ sweepMs: 20 })
  const granted = mkdtempSync(path.join(os.tmpdir(), 'amadeus-granted-'))
  try {
    f.faux.setResponses([fauxAssistantMessage('seed')])
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 'seed', 'seed')
    const open = runtime.host.peek('one')
    // 把一个 Reporter 已终止（指向 Anchor）的条目直接写进去，绕开事件，只剩巡检能发现它。
    await open.root.commit(async tx => {
      const handoffs = await tx.doc(HandoffsDoc, open.root.id)
      const anchor = await tx.createTask(AnchorTask, { taskId: 't_01' }, { ownership: { kind: 'conversation' }, background: true })
      handoffs.items.push({ taskId: 't_01', callId: 'x', kind: 'files', title: '丢失', briefHash: 'x', child: open.root.id, anchor, reporter: anchor, cwd: '', paths: [], status: 'running', createdAt: Date.now() })
      handoffs.seq = 1
    }, ctx)
    await f.until(() => f.events('task.report-ready').length > 0)
    assert.equal(f.events('task.report-ready')[0].status, 'failed')
  } finally { rmSync(granted, { recursive: true, force: true }); await f.cleanup() }
})

test('the process lock tells a recycled pid from its writer by the process start time', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'amadeus-lock-'))
  const lock = path.join(directory, '.lock')
  const write = body => writeFileSync(lock, typeof body === 'string' ? body : JSON.stringify(body))
  const withStart = start => new ProcessLock(directory, { startTimeOf: async () => start })
  try {
    // pid 活着，启动时间早于写锁时刻：确实是写锁的那个进程，等不到就报被占用。
    write({ pid: process.ppid, startedAt: 1_000_000 })
    await assert.rejects(withStart(900_000).acquire({ waitMs: 30, intervalMs: 5 }), /held by process/)

    // pid 活着，却比写锁还晚启动：已经是另一个进程了，锁是残留的，回收。
    const recycled = withStart(1_000_000 + 10 * 60_000)
    await recycled.acquire({ waitMs: 30, intervalMs: 5 })
    assert.equal(recycled.isHeld, true)
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid)
    recycled.release()
    assert.equal(existsSync(lock), false)

    // 取不到启动时间、或旧格式的锁里没有 startedAt：按存活处理，宁可多等也不抢活着的锁。
    write({ pid: process.ppid, startedAt: 1_000_000 })
    await assert.rejects(withStart(undefined).acquire({ waitMs: 30, intervalMs: 5 }), /held by process/)
    write(String(process.ppid))
    await assert.rejects(withStart(1e15).acquire({ waitMs: 30, intervalMs: 5 }), /held by process/)
    rmSync(lock)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the real process start time is readable, and a lock written before the pid was reused is reclaimed', async (t) => {
  const started = await processStartTime(process.pid)
  if (started === undefined) return t.skip('ps is not available here')
  const uptimeStart = Date.now() - process.uptime() * 1000
  assert.ok(Math.abs(started - uptimeStart) < 2500, `ps says ${started}, uptime says ${uptimeStart}`)
  assert.equal(await processStartTime(2 ** 22 + 12345), undefined, 'A pid that does not exist has no start time')

  const f = fixture()
  try {
    mkdirSync(f.sessionsDir, { recursive: true })
    const lock = path.join(f.sessionsDir, '.lock')
    // 父进程活着，但它是在这把锁"写下"之后才启动的：模拟 pid 被复用。
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: 1_000 }))
    const runtime = await f.create()
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid)
    await f.call(runtime, 'checkpoint')
    // 同一个 pid、锁写在它启动之后：真正的持有者，照旧被拒。
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))
    await assert.rejects(new ProcessLock(f.sessionsDir).acquire({ waitMs: 30, intervalMs: 5 }), /held by process/)
  } finally { await f.cleanup() }
})

test('a report is never submitted behind a leftover queued input: it stays pending until the user message has cleared the leftover', async () => {
  const f = fixture()
  const runtime = await f.create()
  const gate = deferred()
  const model = { started: false, replies: [] }
  const router = delegation({
    child: () => fauxAssistantMessage('结论：已完成。'),
    report: () => fauxAssistantMessage('<zh>汇报。</zh><jp>報告。</jp>'),
    plain: async context => {
      const asked = JSON.stringify(context.messages.at(-1)?.content ?? '')
      model.replies.push(asked)
      if (asked.includes('first')) { model.started = true; await gate.promise; return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'boom' }) }
      return fauxAssistantMessage('<zh>在。</zh><jp>いるよ。</jp>')
    },
  })
  f.faux.setResponses(Array.from({ length: 30 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '请委托')
    await f.until(() => f.events('task.report-ready').length > 0)
    const ready = f.events('task.report-ready')[0]
    const open = runtime.host.peek('one')

    // 一个 run 失败后，排在它后面的输入留在 inbox 里：对话空闲，但有 queued 的遗留项。
    await f.call(runtime, 'chat.submit', { sessionId: 'one', turnId: 't2', text: 'first' })
    await f.until(() => model.started)
    const leftover = await open.root.submit({ type: 'input', content: 'second', requestId: 'test:leftover', whenBusy: 'followUp' }, ctx)
    gate.resolve()
    assert.equal((await f.settled('t2')).at(-1).name, 'turn.error')
    await sleep(50)
    assert.equal((await leftover.status(ctx)).status, 'queued', 'The leftover sits in the inbox while the conversation is idle')

    const busy = await f.call(runtime, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r1' })
    assert.deepEqual([busy.type, busy.code], ['error', 'busy'])
    const outbox = await open.harness.snapshot(OutboxDoc, open.root.id, ctx)
    assert.deepEqual([outbox.pending.map(item => item.id), Object.keys(outbox.delivered)], [[ready.id], []], 'Nothing was written: the report is still pending, not delivered')
    assert.equal((await f.call(runtime, 'session.list')).sessions[0].pendingReports, 1)

    // 主人的话有优先权：先撤回遗留项，再提交；遗留项不会抢在它前面被回答。
    const answered = await f.chat(runtime, 'one', 't3', 'hello')
    assert.equal(answered.at(-1).name, 'turn.done')
    assert.equal((await leftover.status(ctx)).status, 'unanswered')
    assert.equal(model.replies.some(asked => asked.includes('second')), false)

    const delivered = await f.call(runtime, 'report.deliver', { sessionId: 'one', id: ready.id, turnId: 'r2' })
    assert.equal(delivered.status, 'started')
    assert.equal((await f.settled('r2')).at(-1).name, 'turn.done')
    const after = await open.harness.snapshot(OutboxDoc, open.root.id, ctx)
    assert.notEqual(after.delivered[ready.id].entryId, null, 'The report went straight into the conversation')
  } finally { gate.resolve(); await f.cleanup() }
})

// ─── handoff v2：续接、进度、提问、委托模型（pi-tool-constraints §3.7） ───

const isChildContext = context => context.messages.some(message => message.role === 'system' && (message.toolsAdded ?? []).some(tool => tool.name === 'web_search'))
const lastText = context => { const content = context.messages.at(-1)?.content; return typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('') }
const userCount = context => context.messages.filter(message => message.role === 'user').length

test('v2 through the runtime: progress, a question, an answer and a second round reach task.graph, session.load and the card history', async () => {
  const f = fixture({ runtime: { handoff: { limits: { progressIntervalMs: 250, tickMs: 50 } } } })
  const runtime = await f.create()
  const release = deferred()
  let step = 0
  const router = async context => {
    const last = lastText(context)
    if (isChildContext(context)) {
      if (userCount(context) > 1) return fauxAssistantMessage('结论：新宿区明天晴。')
      step++
      if (step === 1) return fauxAssistantMessage([fauxToolCall('report_progress', { note: '读第一个来源' })], { stopReason: 'toolUse' })
      if (step === 2) return fauxAssistantMessage([fauxToolCall('report_progress', { note: '读第二个来源' })], { stopReason: 'toolUse' })
      if (step === 3) return fauxAssistantMessage([fauxToolCall('report_progress', { note: '汇总' })], { stopReason: 'toolUse' })
      await release.promise
      return fauxAssistantMessage('QUESTION: 你说的东京是哪个区？')
    }
    if (last.includes('amadeus_handoff_result')) return fauxAssistantMessage('<zh>子代理在问问题。</zh><jp>質問だって。</jp>')
    if (last.includes('新宿')) return fauxAssistantMessage([fauxText('<zh>好，补充给它。</zh><jp>伝えるね。</jp>'), fauxToolCall('handoff_send', { task_id: 't_01', message: '新宿区' })], { stopReason: 'toolUse' })
    if (last.includes('天气')) return fauxAssistantMessage([fauxText('<zh>我让人去查。</zh><jp>調べてもらうわ。</jp>'), fauxToolCall('handoff', { kind: 'research', title: '东京天气', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
    return fauxAssistantMessage('<zh>嗯。</zh><jp>うん。</jp>')
  }
  f.faux.setResponses(Array.from({ length: 40 }, () => router))
  try {
    await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
    await f.chat(runtime, 'one', 't1', '帮我查一下东京明天的天气')
    await f.until(() => step >= 4 && f.events('task.graph').some(event => event.tasks[0].progress))
    await sleep(120)
    // 同一个节流窗口里的第二、三条先被合并，窗口结束时推最新的一条。
    await f.until(() => f.events('task.graph').some(event => event.tasks[0].progress?.text === '汇总'))
    const notes = f.events('task.graph').map(event => event.tasks[0].progress?.text).filter(Boolean)
    assert.deepEqual(notes, ['读第一个来源', '汇总'], 'the middle note is coalesced away')
    const shape = f.events('task.graph').at(-1).tasks[0]
    assert.deepEqual(Object.keys(shape).sort(), ['kind', 'progress', 'round', 'status', 'taskId', 'title'])
    assert.deepEqual([shape.round, shape.status, typeof shape.progress.at], [1, 'running', 'number'])
    const midway = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.equal(midway.tasks[0].progress.text, '汇总', 'session.load always reads the newest note, throttled or not')

    release.resolve()
    await f.until(() => f.events('task.report-ready').length > 0)
    const asked = f.events('task.report-ready')[0]
    assert.deepEqual([asked.id, asked.status, asked.round], ['t_01', 'needs_input', 1])
    const waiting = f.events('task.graph').at(-1).tasks[0]
    assert.deepEqual(waiting, { taskId: 't_01', kind: 'research', title: '东京天气', status: 'needs_input', round: 1, question: '你说的东京是哪个区？' })
    assert.equal((await f.call(runtime, 'report.deliver', { sessionId: 'one', id: asked.id, turnId: 'r1' })).card.question, '你说的东京是哪个区？')
    await f.settled('r1')

    await f.chat(runtime, 'one', 't2', '新宿')
    await f.until(() => f.events('task.report-ready').length === 2)
    const second = f.events('task.report-ready')[1]
    assert.deepEqual([second.id, second.status, second.round], ['t_01.2', 'done', 2])
    assert.deepEqual(f.events('task.graph').at(-1).tasks[0], { taskId: 't_01', kind: 'research', title: '东京天气', status: 'done', round: 2 })
    const delivered = await f.call(runtime, 'report.deliver', { sessionId: 'one', id: second.id, turnId: 'r2' })
    assert.equal(delivered.status, 'started')
    assert.deepEqual([delivered.card.round, delivered.card.status], [2, 'done'])
    await f.settled('r2')

    const loaded = await f.call(runtime, 'session.load', { sessionId: 'one' })
    assert.deepEqual(loaded.tasks, [{ taskId: 't_01', kind: 'research', title: '东京天气', status: 'done', round: 2 }])
    const cards = loaded.messages.filter(message => message.role === 'card').map(message => message.card)
    assert.equal(cards.length, 2, 'every round has its own card in the history')
    assert.deepEqual(cards.map(card => [card.taskId, card.round, card.status]), [['t_01', 1, 'needs_input'], ['t_01', 2, 'done']])
    assert.equal(cards[0].question, '你说的东京是哪个区？', 'the older round is rebuilt from its own report, not from the task as it is now')
    assert.equal(cards[0].summary, '你说的东京是哪个区？')
    assert.equal(cards[1].summary, '结论：新宿区明天晴。')
    assert.deepEqual(loaded.messages.map(message => message.role), ['user', 'assistant', 'card', 'assistant', 'user', 'assistant', 'card', 'assistant'])
    assert.deepEqual(loaded.pendingReports, [])
  } finally { release.resolve(); await f.cleanup() }
})

test('the delegation model comes from AMADEUS_DELEGATION_MODEL; without it the child follows the conversation model', async () => {
  const saved = process.env.AMADEUS_DELEGATION_MODEL
  const modelsSeen = async (value) => {
    if (value === undefined) delete process.env.AMADEUS_DELEGATION_MODEL
    else process.env.AMADEUS_DELEGATION_MODEL = value
    const f = fixture({ fauxModels: [{ id: 'faux-1' }, { id: 'faux-deleg' }] })
    const runtime = await f.create()
    const seen = { main: [], child: [] }
    const router = async (context, _options, _state, model) => {
      if (isChildContext(context)) { seen.child.push(model.id); return fauxAssistantMessage('结论：已完成。') }
      seen.main.push(model.id)
      if (seen.main.length === 1) return fauxAssistantMessage([fauxText('好。'), fauxToolCall('handoff', { kind: 'research', title: '查资料', brief: '查一下东京明天的天气，给出一句结论。' })], { stopReason: 'toolUse' })
      return fauxAssistantMessage('<zh>嗯。</zh><jp>うん。</jp>')
    }
    f.faux.setResponses(Array.from({ length: 10 }, () => router))
    try {
      await f.call(runtime, 'session.create', { sessionId: 'one', title: '' })
      await f.chat(runtime, 'one', 't1', '帮我查一下')
      await f.until(() => f.events('task.report-ready').length > 0)
      const open = runtime.host.peek('one')
      const handoffs = await open.harness.snapshot(HandoffsDoc, open.root.id, ctx)
      assert.equal(handoffs.items[0].status, 'done')
      return { ...seen, failure: handoffs.items[0].failure?.reason }
    } finally { await f.cleanup() }
  }
  try {
    assert.deepEqual(await modelsSeen('faux/faux-deleg'), { main: ['faux-1'], child: ['faux-deleg'], failure: undefined })
    assert.deepEqual(await modelsSeen(undefined), { main: ['faux-1'], child: ['faux-1'], failure: undefined })
    const fallback = await modelsSeen('faux/gone')
    assert.deepEqual([fallback.main, fallback.child, fallback.failure], [['faux-1'], ['faux-1'], 'model_fallback'], 'an unusable model falls back and says so on the card')
  } finally {
    if (saved === undefined) delete process.env.AMADEUS_DELEGATION_MODEL
    else process.env.AMADEUS_DELEGATION_MODEL = saved
  }
})
