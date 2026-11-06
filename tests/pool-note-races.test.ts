import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { createLocalWallet, lockLocalWallet, unlockedWalletId, unlockLocalWallet } from '../src/wallet/lifecycle.ts'
import { captureNoteSession, listStoredNotes, mutateStoredNotes, reconcileNotes, saveStoredNotes } from '../src/pool/notes.ts'
import { config, createNote, type RpcTransport } from '../src/pool/index.ts'
import { keccak256, toHex } from 'viem'

const values = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
}, configurable: true })
const password = 'disposable test password'
function realCrypto() { Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const depositTopic = keccak256(toHex('Deposit(bytes32,uint32,uint256)'))
beforeEach(async () => { realCrypto(); await lockLocalWallet(); values.clear(); await createLocalWallet(password, 0) })
afterEach(async () => { realCrypto(); await lockLocalWallet() })

test('slow reconciliation preserves a newly added pending deposit and a newer spending reservation', async () => {
  const original = createNote(config.pool, config.chainId), added = createNote(config.pool, config.chainId)
  await saveStoredNotes([{ note: original, status: 'unspent' }])
  const started = deferred(), release = deferred()
  const transport: RpcTransport = async (_url, body) => {
    const request = body as { id: number; params: [{ topics: string[] }] }
    if (request.params[0].topics[0] === depositTopic) { started.resolve(); await release.promise }
    return { jsonrpc: '2.0', id: request.id, result: [] }
  }
  const refreshing = reconcileNotes(transport)
  await started.promise
  await mutateStoredNotes(notes => { notes[0].status = 'spending'; notes.push({ note: added, status: 'pending-deposit' }) })
  release.resolve()
  await refreshing
  const stored = await listStoredNotes()
  assert.equal(stored.length, 2)
  assert.equal(stored.find(entry => entry.note.commitment === original.commitment)?.status, 'spending')
  assert.equal(stored.find(entry => entry.note.commitment === added.commitment)?.note.secret, added.secret)
})

test('two concurrent reconciliations cannot erase a pending note created while their reads wait', async () => {
  const original = createNote(config.pool, config.chainId), added = createNote(config.pool, config.chainId)
  await saveStoredNotes([{ note: original, status: 'unspent' }])
  const bothStarted = deferred(), release = deferred()
  let reads = 0
  const transport: RpcTransport = async (_url, body) => {
    const request = body as { id: number; params: [{ topics: string[] }] }
    if (request.params[0].topics[0] === depositTopic) {
      if (++reads === 2) bothStarted.resolve()
      await release.promise
    }
    return { jsonrpc: '2.0', id: request.id, result: [] }
  }
  const refreshes = [reconcileNotes(transport), reconcileNotes(transport)]
  await bothStarted.promise
  await mutateStoredNotes(notes => { notes.push({ note: added, status: 'pending-deposit' }) })
  release.resolve()
  await Promise.all(refreshes)
  assert.equal((await listStoredNotes()).find(entry => entry.note.commitment === added.commitment)?.note.nullifier, added.nullifier)
})

test('concurrent mutations retain both new notes and a failed mutation does not poison the wallet queue', async () => {
  const first = createNote(config.pool, config.chainId), second = createNote(config.pool, config.chainId)
  await Promise.all([
    mutateStoredNotes(notes => { notes.push({ note: first, status: 'pending-deposit' }) }),
    mutateStoredNotes(notes => { notes.push({ note: second, status: 'pending-deposit' }) }),
  ])
  await assert.rejects(mutateStoredNotes(notes => { notes.length = 0; throw new Error('Test writer failed') }), /Test writer failed/)
  await mutateStoredNotes(notes => { notes[0].status = 'spending' })
  const stored = await listStoredNotes()
  assert.equal(stored.length, 2)
  assert.equal(stored[0].status, 'spending')
  assert.equal(stored[1].note.secret, second.secret)
})

test('locking A and unlocking B during encryption cannot write A data into either wallet', async () => {
  const original = createNote(config.pool, config.chainId), added = createNote(config.pool, config.chainId)
  await saveStoredNotes([{ note: original, status: 'unspent' }])
  const walletA = unlockedWalletId(), vaultA = values.get('0xpay.vault.v1')!
  const beforeA = values.get(`0xpay.notes.v1.${walletA}`)
  const started = deferred(), release = deferred()
  let pauseNext = true
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: new Proxy(webcrypto.subtle, { get(target, property) {
      if (property === 'encrypt') return async (...args: Parameters<SubtleCrypto['encrypt']>) => {
        if (pauseNext) { pauseNext = false; started.resolve(); await release.promise }
        return Reflect.apply(target.encrypt, target, args)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }),
  } })
  const pending = mutateStoredNotes(notes => { notes.push({ note: added, status: 'pending-deposit' }) })
  const rejected = assert.rejects(pending, /Wallet session changed|Wallet is locked/)
  await started.promise
  await lockLocalWallet()
  values.delete('0xpay.vault.v1')
  await createLocalWallet(password, 0)
  const walletB = unlockedWalletId()
  release.resolve()
  await rejected
  assert.equal(values.get(`0xpay.notes.v1.${walletA}`), beforeA)
  assert.equal(values.has(`0xpay.notes.v1.${walletB}`), false)
  assert.deepEqual(await listStoredNotes(), [])
  await lockLocalWallet(); values.set('0xpay.vault.v1', vaultA); await unlockLocalWallet(password)
  assert.equal((await listStoredNotes())[0].note.secret, original.secret)
})

test('an old-session reconciliation cannot mutate the newly unlocked wallet', async () => {
  const note = createNote(config.pool, config.chainId)
  await saveStoredNotes([{ note, status: 'unspent' }])
  const sessionA = captureNoteSession(), started = deferred(), release = deferred()
  const transport: RpcTransport = async (_url, body) => {
    started.resolve(); await release.promise
    return { jsonrpc: '2.0', id: (body as { id: number }).id, result: [] }
  }
  const refreshing = reconcileNotes(transport, sessionA)
  const rejected = assert.rejects(refreshing, /Wallet session changed|Wallet is locked/)
  await started.promise
  await lockLocalWallet(); values.delete('0xpay.vault.v1'); await createLocalWallet(password, 0)
  release.resolve(); await rejected
  assert.deepEqual(await listStoredNotes(), [])
})
