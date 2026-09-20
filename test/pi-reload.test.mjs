import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PiHost } from '../src/main/piHost.ts'
import { openPiSession } from '../src/main/piSessions.ts'

class Child extends EventEmitter {
  sent = []
  killed = false
  postMessage(message) {
    this.sent.push(message)
    if (message.command === 'checkpoint') queueMicrotask(() => this.emit('message', { id: message.id, type: 'done' }))
  }
  kill() { this.killed = true; return true }
}

test('Pi replacement waits for readiness, rejects dead requests, and ignores an old process exit', async () => {
  const children = []
  const host = new PiHost(() => {
    const child = new Child()
    children.push(child)
    return child
  })
  const initialized = host.init()
  children[0].emit('message', { type: 'ready' })
  await initialized
  try {
    const replacement = host.restart()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(children[0].killed, false, 'Keep the old process until the replacement is ready')
    children[1].emit('message', { type: 'ready' })
    await replacement
    assert.equal(children[0].killed, true)
    children[0].emit('exit', 0)
    assert.equal(host.error, '')
    const reply = host.prompt('one', 'hello', { onText() {}, onTool() {} })
    await new Promise(resolve => setImmediate(resolve))
    const message = children[1].sent.at(-1)
    children[1].emit('message', { id: message.id, type: 'done', text: 'new worker' })
    assert.equal(await reply, 'new worker')
    const interrupted = host.prompt('one', 'do not replay', { onText() {}, onTool() {} })
    const rejected = assert.rejects(interrupted, /exited/)
    await new Promise(resolve => setImmediate(resolve))
    children[1].emit('exit', 1)
    await rejected
    assert.equal(children.length, 2, 'A crash must not automatically replay a prompt')
  } finally { host.dispose() }
})

test('failed Pi replacement leaves the old process usable', async () => {
  const children = []
  const host = new PiHost(() => {
    const child = new Child()
    children.push(child)
    queueMicrotask(() => child.emit('message', children.length === 1 ? { type: 'ready' } : { type: 'ready', error: 'bad extension' }))
    return child
  })
  await host.init()
  try {
    await assert.rejects(host.restart(), /bad extension/)
    assert.equal(children[0].killed, false)
    assert.equal(children[1].killed, true)
    assert.equal(host.error, '')
    await host.request('checkpoint')
  } finally { host.dispose() }
})

test('a Pi child that exits during the ready handshake is never adopted', async () => {
  const host = new PiHost(() => {
    const child = new Child()
    queueMicrotask(() => { child.emit('message', { type: 'ready' }); child.emit('exit', 1) })
    return child
  })
  try {
    await host.init()
    assert.match(host.error, /exited/)
  } finally { host.dispose() }
})

test('Pi sessions persist full tool context and model state in an isolated app directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'salieri-pi-session-'))
  try {
    const manager = openPiSession(root, root, 'chat-one')
    manager.appendModelChange('fixture', 'model')
    manager.appendThinkingLevelChange('low')
    manager.appendMessage({ role: 'user', content: 'read the file', timestamp: 1 })
    // Even before an assistant responds, the accepted user message must survive.
    assert.equal(openPiSession(root, root, 'chat-one').buildSessionContext().messages[0].content, 'read the file')
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file.txt' } }], api: 'openai-responses', provider: 'fixture', model: 'model', stopReason: 'toolUse', timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
    manager.appendMessage({ role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'already executed' }], isError: false, timestamp: 3 })
    const restored = openPiSession(root, root, 'chat-one')
    assert.deepEqual(restored.getEntries(), manager.getEntries())
    assert.equal(restored.buildSessionContext().model.modelId, 'model')
    assert.equal(openPiSession(root, root, 'chat-two').getEntries().length, 0)
    assert.throws(() => openPiSession(root, root, '../escape'), /session id/i)
    assert.match(readFileSync(manager.getSessionFile(), 'utf8'), /toolResult/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
