import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import Level from 'level-js'
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb'
import { Mnemonic } from 'ethers'
import { RailgunEngine, TXIDVersion } from '@railgun-community/engine'
import { ArtifactStore, startRailgunEngine, stopRailgunEngine, getEngine } from '@railgun-community/wallet'
import {
  assertUnlockedSession, confirmWalletBackup, createLocalWallet, importLocalWallet, lockLocalWallet,
  recoveryPhraseForBackup, storedVault, unlockedFundingWallet, unlockedSessionVersion,
  unlockedWalletId, unlockedEncryptionKey, unlockLocalWallet,
} from '../src/wallet/lifecycle.ts'
import { createBrowserDatabase, protectNamespaceReads } from '../src/railgun/browser-database.ts'

test('actual RAILGUN wallet survives reload, SDK database loss and fresh phrase restore', { timeout: 120_000 }, async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const records = new Map<string, string>()
  let failWrites = false
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('Storage quota denied')
      records.set(key, value)
    },
    removeItem: (key: string) => { records.delete(key) },
  } })
  const artifacts = new ArtifactStore(async () => null, async () => { throw new Error('No artifact downloads in recovery test') }, async () => false)
  const start = (name: string) => startRailgunEngine('0xpaytest', new Level(name), false, artifacts, false, false, [])
  const password = 'disposable-test-password'
  try {
    await start('0xpay-recovery-persisted')
    const created = await createLocalWallet(password, 12_000_000)
    const identity = (session: typeof created.session) => ({
      id: session.id, publicAddress: session.publicAddress, railgunAddress: session.railgunAddress,
    })
    const original = identity(created.session)
    assert.equal(created.session.backupConfirmed, false)
    const firstVersion = unlockedSessionVersion()
    // Legacy records have no durable backup field; treat them as incomplete.
    const legacy = { ...storedVault() }
    delete legacy.backupConfirmed
    delete legacy.walletId
    records.set('0xpay.vault.v1', JSON.stringify(legacy))
    await lockLocalWallet()
    assert.throws(unlockedFundingWallet, /locked/)
    assert.throws(unlockedWalletId, /locked/)
    await stopRailgunEngine()

    // Same SDK database models reload. Unfinished backup must remain unfinished.
    await start('0xpay-recovery-persisted')
    failWrites = true
    await assert.rejects(unlockLocalWallet(password), /Could not save or validate restored wallet metadata/)
    assert.throws(unlockedFundingWallet, /locked/)
    assert.equal(storedVault()?.walletId, undefined)
    failWrites = false
    const reloaded = await unlockLocalWallet(password)
    assert.deepEqual(identity(reloaded), original)
    assert.equal(storedVault()?.walletId, original.id)
    assert.equal(reloaded.backupConfirmed, false)
    assert.throws(() => assertUnlockedSession(reloaded.id, firstVersion), /session changed/)
    assert.equal(await recoveryPhraseForBackup(password), created.recoveryPhrase)
    failWrites = true
    assert.throws(() => confirmWalletBackup(reloaded.id), /Storage quota denied/)
    assert.notEqual(storedVault()?.backupConfirmed, true)
    failWrites = false
    confirmWalletBackup(reloaded.id)
    assert.equal(storedVault()?.backupConfirmed, true)
    await assert.rejects(recoveryPhraseForBackup(password), /already been backed up/)
    await lockLocalWallet()
    await stopRailgunEngine()

    // A fresh SDK database models browser eviction while the encrypted vault survives.
    await start('0xpay-recovery-evicted')
    const evicted = await unlockLocalWallet(password)
    assert.deepEqual(identity(evicted), original)
    assert.equal(evicted.backupConfirmed, true)
    const storedIdentity = records.get('0xpay.vault.v1')!
    const evictedVersion = unlockedSessionVersion()
    records.set('0xpay.vault.v1', JSON.stringify({ ...storedVault(), creationBlock: 12_000_001 }))
    assert.throws(unlockedFundingWallet, /Stored wallet changed/)
    assert.throws(unlockedEncryptionKey, /Stored wallet changed/)
    assert.throws(() => assertUnlockedSession(evicted.id, evictedVersion), /Stored wallet changed/)
    records.set('0xpay.vault.v1', storedIdentity)
    assert.throws(unlockedFundingWallet, /Stored wallet changed/)
    await lockLocalWallet()
    assert.deepEqual(identity(await unlockLocalWallet(password)), original)
    await lockLocalWallet()
    await stopRailgunEngine()

    // A new profile has only the user's phrase, not the vault or SDK records.
    records.clear()
    await start('0xpay-recovery-fresh-profile')
    const restored = await importLocalWallet(created.recoveryPhrase, 'different-test-password')
    assert.deepEqual(identity(restored), original)
    assert.equal(restored.backupConfirmed, true)
    await lockLocalWallet()

    // Another tab can create a wallet while this tab awaits encryption/SDK work.
    const otherTabRecord = records.get('0xpay.vault.v1')!
    records.clear()
    const overlapping = createLocalWallet(password, 12_000_000)
    records.set('0xpay.vault.v1', otherTabRecord)
    await assert.rejects(overlapping, /could not save this wallet|local wallet already exists/)
    assert.equal(records.get('0xpay.vault.v1'), otherTabRecord)
    assert.throws(unlockedFundingWallet, /locked/)
  } finally {
    await lockLocalWallet()
    await stopRailgunEngine()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('origin wallet-creation lock rejects a second tab before creating a wallet', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let lockName = ''
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, options: { ifAvailable: boolean }, callback: (lock: null) => unknown) => {
      lockName = name
      assert.equal(options.ifAvailable, true)
      return callback(null)
    },
  } })
  try {
    await assert.rejects(createLocalWallet('disposable-test-password', 12_000_000), /already running in another tab/)
    assert.equal(lockName, '0xpay.wallet-vault-create')
  } finally {
    if (original) Object.defineProperty(navigator, 'locks', original)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

test('failed SDK history-marker writes never recreate the wallet or leave a partial loaded wallet', { timeout: 120_000 }, async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const records = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) },
    removeItem: (key: string) => { records.delete(key) },
  } })
  const originalLoad = RailgunEngine.prototype.loadWallet
  const originalPut = IDBObjectStore.prototype.put
  const artifacts = new ArtifactStore(async () => null, async () => {}, async () => false)
  const password = 'disposable-test-password'
  let attachmentAttempts = 0
  let markerWrites = 0
  let encryptedWalletWrites = 0
  let failMarkerWrites = true
  let encryptedRecordKey = ''
  try {
    await startRailgunEngine('0xpaytest', new Level('0xpay-recovery-write-failure'), false, artifacts, false, false, [])
    const created = await createLocalWallet(password, 12_000_000)
    const record = records.get('0xpay.vault.v1')!
    await lockLocalWallet()
    encryptedRecordKey = `${Buffer.from('wallet').toString('hex').padStart(64, '0')}:${created.session.id.padStart(64, '0')}`
    RailgunEngine.prototype.loadWallet = async function (wallet) {
      await originalLoad.call(this, wallet)
      assert.equal(this.wallets[wallet.id], wallet)
      attachmentAttempts++
      // Load the real SDK's UTXO attachment path without a network/provider.
      await wallet.loadUTXOMerkletree(TXIDVersion.V2_PoseidonMerkle, { chain: { type: 0, id: 11155111 } } as never)
    }
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
      const key = typeof args[1] === 'string' ? args[1] : Buffer.from(args[1] as ArrayBuffer).toString('utf8')
      if (key === encryptedRecordKey) encryptedWalletWrites++
      if (key.includes('merkleetree_history_version')) {
        markerWrites++
        if (failMarkerWrites) throw new DOMException('Injected storage write failure', 'QuotaExceededError')
      }
      return originalPut.apply(this, args)
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(unlockLocalWallet(password), /Wallet storage could not be written/)
      assert.equal(getEngine().wallets[created.session.id], undefined)
      assert.throws(unlockedFundingWallet, /locked/)
      assert.equal(records.get('0xpay.vault.v1'), record)
    }
    assert.equal(attachmentAttempts, 2)
    assert.equal(markerWrites, 2)
    assert.equal(encryptedWalletWrites, 0)
    failMarkerWrites = false
    const unlocked = await unlockLocalWallet(password)
    assert.equal(unlocked.id, created.session.id)
    assert.equal(attachmentAttempts, 3)
    assert.equal(encryptedWalletWrites, 0)
    await lockLocalWallet()

    // A generic 'not found' read error is not a LevelUP missing-record proof.
    const db = getEngine().db
    const originalGet = db.get
    db.get = async () => { throw new Error('Remote endpoint not found') }
    try {
      await assert.rejects(unlockLocalWallet(password), /Wallet storage could not be loaded/)
      assert.equal(encryptedWalletWrites, 0)
    } finally { db.get = originalGet }
  } finally {
    RailgunEngine.prototype.loadWallet = originalLoad
    IDBObjectStore.prototype.put = originalPut
    await lockLocalWallet()
    await stopRailgunEngine()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('actual SDK import uses the production adapter, recovers a closed handle and preserves retry after failed storage', { timeout: 180_000 }, async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalTransaction = IDBDatabase.prototype.transaction
  const originalPut = IDBObjectStore.prototype.put
  const originalFetch = globalThis.fetch
  const records = new Map<string, string>()
  const observed: { handle?: IDBDatabase } = {}
  let networkCalls = 0
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) },
    removeItem: (key: string) => { records.delete(key) },
  } })
  IDBDatabase.prototype.transaction = function (...args: Parameters<typeof originalTransaction>) {
    observed.handle = this
    return originalTransaction.apply(this, args)
  }
  globalThis.fetch = async () => { networkCalls++; throw new Error('No network in disposable wallet import test') }
  const artifacts = new ArtifactStore(async () => null, async () => { throw new Error('No proof downloads in import test') }, async () => false)
  const start = async (name: string) => {
    await startRailgunEngine('0xpaytest', createBrowserDatabase(name), false, artifacts, false, false, [])
    protectNamespaceReads(getEngine().db)
  }
  // Deterministic, synthetic, unfunded test phrase; never a user wallet.
  const phrase = Mnemonic.fromEntropy(new Uint8Array(16).fill(17)).phrase
  const identity = (session: { id: string; publicAddress: string; railgunAddress: string }) => [session.id, session.publicAddress, session.railgunAddress]
  try {
    await start('0xpay-import-production-adapter')
    await getEngine().db.put(['adapter-probe'], 'aa')
    observed.handle!.close()
    const imported = await importLocalWallet(phrase.replaceAll(' ', '\n  '), 'disposable-import-password')
    const expected = identity(imported)
    assert.equal(imported.backupConfirmed, true)
    assert.equal(storedVault()?.walletId, imported.id)
    assert.equal(records.get('0xpay.vault.v1')!.includes(phrase), false)
    await lockLocalWallet()
    await stopRailgunEngine()
    await start('0xpay-import-production-adapter')
    assert.deepEqual(identity(await unlockLocalWallet('disposable-import-password')), expected)
    await lockLocalWallet()
    await stopRailgunEngine()

    // A second isolated profile has no vault and gets a real failed IDB write.
    // Only this synthetic Map is cleared, never a browser's existing wallet.
    records.clear()
    await start('0xpay-import-rejected-storage')
    IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota fault', 'QuotaExceededError') }
    await assert.rejects(importLocalWallet(phrase, 'disposable-import-password'), /Wallet storage could not be written/)
    assert.equal(storedVault(), null)
    assert.deepEqual(Object.keys(getEngine().wallets), [])
    assert.throws(unlockedFundingWallet, /locked/)
    IDBObjectStore.prototype.put = originalPut
    assert.deepEqual(identity(await importLocalWallet(phrase, 'disposable-import-password')), expected)
    assert.equal(networkCalls, 0)
  } finally {
    IDBObjectStore.prototype.put = originalPut
    IDBDatabase.prototype.transaction = originalTransaction
    globalThis.fetch = originalFetch
    await lockLocalWallet()
    await stopRailgunEngine()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
