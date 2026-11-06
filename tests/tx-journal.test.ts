import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTransaction, markTransaction, readTransactions, recordSubmitted, unresolvedTransaction } from '../src/domain/tx-journal.ts'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
  }
}

const hash = `0x${'12'.repeat(32)}`
const from = `0x${'34'.repeat(20)}`

test('a submitted transaction survives a fresh reader and blocks duplicate intent until reconciled', () => {
  const storage = memoryStorage()
  recordSubmitted('send', hash, from, storage)
  assert.equal(unresolvedTransaction('send', storage)?.hash, hash)
  assert.equal(readTransactions(storage).length, 1)
  recordSubmitted('send', hash, from, storage)
  assert.equal(readTransactions(storage).length, 1)
  markTransaction(hash, 'unknown', storage)
  assert.equal(unresolvedTransaction('send', storage)?.status, 'unknown')
  markTransaction(hash, 'confirmed', storage)
  assert.equal(unresolvedTransaction('send', storage), undefined)
  assert.equal(findTransaction(hash, storage)?.status, 'confirmed')
  assert.throws(() => markTransaction(hash, 'reverted', storage), /cannot be changed/)
})

test('damaged local transaction history cannot silently be overwritten', () => {
  const storage = memoryStorage()
  storage.setItem('0xpay.transactions.v1', '[{"hash":"broken"}]')
  assert.throws(() => recordSubmitted('shield', hash, from, storage), /damaged/)
  assert.throws(() => unresolvedTransaction('shield', storage), /damaged/)
})
