import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb'
import { Database } from '@railgun-community/engine'
import { createBrowserDatabase, protectNamespaceReads } from '../src/railgun/browser-database.ts'

test('closed IDB handles reopen without resetting SDK keys, batches or namespace scans', async () => {
  const transaction = IDBDatabase.prototype.transaction
  const open = indexedDB.open.bind(indexedDB)
  const observed: { handle?: IDBDatabase } = {}
  let opens = 0
  IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
    observed.handle = this
    return transaction.apply(this, args)
  }
  indexedDB.open = (...args: Parameters<typeof open>) => { opens++; return open(...args) }
  const adapter = createBrowserDatabase('0xpay-closed-idb-test')
  const db = new Database(adapter)
  protectNamespaceReads(db)
  const key = ['namespace', '01']
  try {
    await db.put(key, 'aa')
    assert.equal(db.usesIndexedDB(), false)
    observed.handle!.close()
    assert.equal(await db.get(key), 'aa')
    observed.handle!.close()
    await db.put(['namespace', '02'], 'bb')
    observed.handle!.close()
    await db.batch([{ type: 'put', key: Database.pathToKey(['namespace', '03']), value: 'cc' }])
    const beforeConcurrent = opens
    observed.handle!.close()
    const [first, second] = await Promise.all([db.get(key), db.get(['namespace', '02'])])
    assert.deepEqual([first, second], ['aa', 'bb'])
    assert.equal(opens, beforeConcurrent + 1)
    observed.handle!.close()
    assert.equal((await db.getNamespaceKeys(['namespace'])).length, 3)
    const workingTransaction = IDBDatabase.prototype.transaction
    let transactionAttempts = 0
    const beforeRepeatedClose = opens
    IDBDatabase.prototype.transaction = function () {
      transactionAttempts++
      throw new DOMException('Connection is closing', 'InvalidStateError')
    }
    try {
      await assert.rejects(db.get(key), /closed again during recovery/)
      assert.equal(transactionAttempts, 2)
      assert.equal(opens, beforeRepeatedClose + 1)
      await assert.rejects(db.getNamespaceKeys(['namespace']), /could not resume a read cursor/)
      assert.equal(transactionAttempts, 4)
      assert.equal(opens, beforeRepeatedClose + 2)
    } finally { IDBDatabase.prototype.transaction = workingTransaction }
    observed.handle!.close()
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const entries: unknown[] = []
      db.streamRange(['namespace', '01'], ['namespace', '03']).on('data', (value) => entries.push(value)).on('error', reject).on('end', () => resolve(entries))
    })
    assert.deepEqual(values, ['aa', 'bb', 'cc'])
    assert.equal(await db.get(key), 'aa')

    const put = IDBObjectStore.prototype.put
    const beforeQuota = opens
    IDBObjectStore.prototype.put = function () { throw new DOMException('Injected quota failure', 'QuotaExceededError') }
    try {
      await assert.rejects(db.put(['namespace', '04'], 'dd'), /Failed to put value in database/)
      assert.equal(opens, beforeQuota)
    } finally { IDBObjectStore.prototype.put = put }
    assert.equal((await db.getNamespaceKeys(['namespace'])).length, 3)
  } finally {
    await db.close()
    IDBDatabase.prototype.transaction = transaction
    indexedDB.open = open
  }
})
