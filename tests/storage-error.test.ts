import { test } from 'node:test'
import assert from 'node:assert/strict'
import { walletStorageError } from '../src/wallet/storage-error.ts'

test('storage diagnostics distinguish quota, permission and closed handles without exposing SDK data', () => {
  for (const name of ['QuotaExceededError', 'SecurityError', 'InvalidStateError', 'AbortError']) {
    const underlying = new DOMException('private wallet contents must not reach the UI', name)
    const sdk = new Error('Failed to put value in database', { cause: new Error('SDK wrapper', { cause: underlying }) })
    const error = walletStorageError(sdk)
    assert.equal(error.code, 'WALLET_STORAGE_WRITE_FAILED')
    assert.equal(error.storageErrorName, name)
    assert.ok(error.message.includes(name))
    assert.ok(!error.message.includes('private wallet contents'))
    assert.equal(error.cause, sdk)
  }
})

test('unknown storage failures stay unknown and cyclic causes terminate', () => {
  const original = new Error('secret SDK context')
  original.name = 'untrusted exception contents'
  original.cause = original
  const error = walletStorageError(original)
  assert.equal(error.code, 'WALLET_STORAGE_LOAD_FAILED')
  assert.equal(error.storageErrorName, undefined)
  assert.ok(!error.message.includes('secret'))
  assert.ok(!error.message.includes('untrusted'))
  assert.match(error.message, /Keep the existing wallet and site data/)
})
