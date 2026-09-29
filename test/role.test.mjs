import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composePrompt, ensurePromptFiles } from '../src/main/role.ts'

test('prompt files are seeded once, owned by the user, and re-read on every prompt build', () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'amadeus-role-')), 'pi')
  try {
    ensurePromptFiles(dir)
    const role = path.join(dir, 'ROLE.md')
    const presentation = path.join(dir, 'PRESENTATION.md')
    assert.match(readFileSync(role, 'utf8'), /You are Amadeus, the digital persona of Makise Kurisu/)
    assert.match(readFileSync(presentation, 'utf8'), /<zh>.*<\/zh><jp>.*<\/jp>/)
    writeFileSync(role, '你是测试角色。\n')
    writeFileSync(presentation, 'FORMAT')
    ensurePromptFiles(dir)
    assert.equal(readFileSync(role, 'utf8'), '你是测试角色。\n', 'an existing role must never be overwritten')
    assert.equal(composePrompt(dir, 'PROTOCOL'), '你是测试角色。\n\nFORMAT\n\nPROTOCOL')
    writeFileSync(presentation, '第二版。')
    assert.equal(composePrompt(dir, 'PROTOCOL'), '你是测试角色。\n\n第二版。\n\nPROTOCOL')
    writeFileSync(role, '  \n')
    writeFileSync(presentation, '')
    assert.equal(composePrompt(dir, 'PROTOCOL'), 'You are Amadeus.\n\nPROTOCOL', 'blank files fall back to the minimal identity')
  } finally { rmSync(path.dirname(dir), { recursive: true, force: true }) }
})

test('missing prompt files fall back instead of failing a reload', () => {
  assert.equal(composePrompt('/nonexistent-amadeus-role-dir', 'P'), 'You are Amadeus.\n\nP')
})
