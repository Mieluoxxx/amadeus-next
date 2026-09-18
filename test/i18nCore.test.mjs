import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { interpolate, normalizeLocale, SUPPORTED_LOCALES } from '../src/renderer/i18n/core.ts'

test('normalizes supported locale aliases and falls back to English', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['en-US', 'zh-CN', 'ja-JP'])
  assert.equal(normalizeLocale('zh'), 'zh-CN')
  assert.equal(normalizeLocale('ja_jp'), 'ja-JP')
  assert.equal(normalizeLocale('unknown'), 'en-US')
})

test('interpolates values while preserving missing placeholders', () => {
  assert.equal(interpolate('Hello {name}, {count} items', { name: '主人', count: 2 }), 'Hello 主人, 2 items')
  assert.equal(interpolate('Missing {value}'), 'Missing {value}')
})

test('main renderer catalog explicitly overrides every supported locale', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../src/renderer/i18n/index.tsx'), 'utf8')
  const main = source.slice(source.indexOf('const MAIN_LOCALE_MESSAGES ='), source.indexOf('const EN ='))
  const mainZh = main.slice(main.indexOf("'zh-CN': {"), main.indexOf("'ja-JP': {"))
  const mainJa = main.slice(main.indexOf("'ja-JP': {"))
  const en = source.slice(source.indexOf('const EN ='), source.indexOf('const ZH:'))
  const zh = source.slice(source.indexOf('const ZH:'), source.indexOf('const JA:'))
  const ja = source.slice(source.indexOf('const JA:'), source.indexOf('export const MESSAGES'))
  const keys = [...new Set([main, en].flatMap(block => [...block.matchAll(/^\s*'((?:nav|chat|session|activity|backend|artifact|scene)\.[^']+)'\s*:/gm)].map(match => match[1])))]
  for (const key of keys) {
    const pattern = new RegExp(`['"]${key.replaceAll('.', '\\.') }['"]\\s*:`)
    assert.match(`${mainZh}\n${zh}`, pattern, `zh-CN is missing ${key}`)
    assert.match(`${mainJa}\n${ja}`, pattern, `ja-JP is missing ${key}`)
  }
})
