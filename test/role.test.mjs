import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composePrompt, ensurePromptFiles, readVoiceSheet } from '../src/main/role.ts'

test('prompt files are seeded once, owned by the user, and re-read on every prompt build', () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'amadeus-role-')), 'pi')
  try {
    ensurePromptFiles(dir)
    const role = path.join(dir, 'ROLE.md')
    const voice = path.join(dir, 'VOICE.md')
    assert.match(readFileSync(role, 'utf8'), /You are Amadeus, the digital persona of Makise Kurisu/)
    assert.match(readFileSync(voice, 'utf8'), /First person 私/)
    writeFileSync(role, '你是测试角色。\n')
    writeFileSync(voice, '口吻')
    ensurePromptFiles(dir)
    assert.equal(readFileSync(role, 'utf8'), '你是测试角色。\n', 'an existing role must never be overwritten')
    assert.equal(readVoiceSheet(dir), '口吻')
    assert.equal(composePrompt(dir, 'PROTOCOL'), '你是测试角色。\n\nPROTOCOL', 'the voice sheet is for the director, not the main model')
    writeFileSync(role, '第二版。')
    assert.equal(composePrompt(dir, 'PROTOCOL'), '第二版。\n\nPROTOCOL')
    writeFileSync(role, '  \n')
    assert.equal(composePrompt(dir, 'PROTOCOL'), 'You are Amadeus.\n\nPROTOCOL', 'blank files fall back to the minimal identity')
  } finally { rmSync(path.dirname(dir), { recursive: true, force: true }) }
})

test('a PRESENTATION.md left by the bilingual-tag format is no longer read', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'amadeus-role-'))
  try {
    writeFileSync(path.join(dir, 'ROLE.md'), '角色')
    writeFileSync(path.join(dir, 'PRESENTATION.md'), '<zh>…</zh><jp>…</jp>')
    assert.equal(composePrompt(dir, 'P'), '角色\n\nP')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing prompt files fall back instead of failing a reload', () => {
  assert.equal(composePrompt('/nonexistent-amadeus-role-dir', 'P'), 'You are Amadeus.\n\nP')
})
