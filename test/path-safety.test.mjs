import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeFilePath } from '../src/main/pathSafety.ts'

test('scene asset requests cannot escape the selected root', () => {
  assert.equal(safeFilePath('/tmp/assets', 'images/wallpaper.png'), '/tmp/assets/images/wallpaper.png')
  assert.equal(safeFilePath('/tmp/assets', '../secrets.txt'), null)
  assert.equal(safeFilePath('/tmp/assets', '%2e%2e/%2e%2e/secrets.txt'), null)
  assert.equal(safeFilePath('/tmp/assets', '%ZZ'), null)
})
