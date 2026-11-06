import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalWallet, hasStoredVault } from '../src/wallet/lifecycle.ts'

test('denied browser storage stops wallet creation before a phrase is generated', async () => {
  const original = globalThis.localStorage
  Object.assign(globalThis, { localStorage: {
    getItem: () => { throw new Error('storage denied') },
    setItem: () => { throw new Error('storage denied') },
    removeItem: () => {},
  } })
  try {
    assert.equal(hasStoredVault(), false)
    await assert.rejects(createLocalWallet('long-test-password', 1), /Browser storage is unavailable/)
  } finally { Object.assign(globalThis, { localStorage: original }) }
})
