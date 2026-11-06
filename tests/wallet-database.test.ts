import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { IDBObjectStore } from 'fake-indexeddb'
import { Database } from '@railgun-community/engine'
import { ArtifactStore, getEngine, startRailgunEngine, stopRailgunEngine } from '@railgun-community/wallet'
import { createBrowserDatabase, protectNamespaceReads } from '../src/railgun/browser-database.ts'
import { createLocalWallet, importLocalWallet, lockLocalWallet, unlockLocalWallet } from '../src/wallet/lifecycle.ts'

test('an aborted write is rejected without reopening or replaying it', async () => {
  const adapter = createBrowserDatabase('0xpay-abort-isolated-test')
  const db = new Database(adapter)
  const put = IDBObjectStore.prototype.put
  const open = indexedDB.open.bind(indexedDB)
  let puts = 0
  let opens = 0
  try {
    await db.put(['01'], 'aa')
    indexedDB.open = (...args: Parameters<typeof open>) => { opens++; return open(...args) }
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      puts++
      const request = put.apply(this, args)
      this.transaction.abort()
      return request
    }
    await assert.rejects(db.put(['02'], 'bb'), /Failed to put value in database/)
    assert.equal(puts, 1)
    assert.equal(opens, 0)
    IDBObjectStore.prototype.put = put
    assert.equal(await db.get(['01']), 'aa')
    await assert.rejects(db.get(['02']))
  } finally {
    IDBObjectStore.prototype.put = put
    indexedDB.open = open
    await db.close()
  }
})

test('actual SDK creates, reloads and imports through the browser recovery adapter', { timeout: 120_000 }, async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const records = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) },
    removeItem: (key: string) => { records.delete(key) },
  } })
  const artifacts = new ArtifactStore(async () => null, async () => {}, async () => false)
  const start = async (name: string) => {
    await startRailgunEngine('0xpaytest', createBrowserDatabase(name), false, artifacts, false, false, [])
    protectNamespaceReads(getEngine().db)
  }
  const identity = (wallet: { id: string; publicAddress: string; railgunAddress: string }) =>
    [wallet.id, wallet.publicAddress, wallet.railgunAddress]
  try {
    await start('0xpay-adapter-wallet-test')
    const created = await createLocalWallet('disposable-test-password', 12_000_000)
    const expected = identity(created.session)
    const encryptedRecord = records.get('0xpay.vault.v1')
    assert.ok(encryptedRecord)
    assert.ok(!encryptedRecord.includes(created.recoveryPhrase))
    await lockLocalWallet()
    await stopRailgunEngine()
    await start('0xpay-adapter-wallet-test')
    assert.deepEqual(identity(await unlockLocalWallet('disposable-test-password')), expected)
    await lockLocalWallet()
    await stopRailgunEngine()
    // Isolated in-memory storage models another browser profile, not user data.
    records.clear()
    await start('0xpay-adapter-import-test')
    assert.deepEqual(identity(await importLocalWallet(created.recoveryPhrase, 'other-test-password')), expected)
  } finally {
    await lockLocalWallet()
    await stopRailgunEngine()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
