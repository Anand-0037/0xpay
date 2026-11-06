/** Disposable notes and in-memory browser storage; no funded wallet or network. */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { createPoolApi } from '../src/pool/api.ts'
import { config, createNote, hash } from '../src/pool/index.ts'
import { decryptNoteBackup, encryptNoteBackup, mergeRestoredNotes, restorePrivateNoteBackup, exportPrivateNoteBackup, type BackupContext } from '../src/pool/note-backup.ts'
import { listStoredNotes, mutateStoredNotes, reconcileNotes, saveStoredNotes, type StoredNote } from '../src/pool/notes.ts'
import { createLocalWallet, importLocalWallet, lockLocalWallet, unlockedWalletId } from '../src/wallet/lifecycle.ts'
import { CLAIM_FEE } from '../src/pool/fees.ts'
import { NOTE_VALUE } from '../src/pool/payment-records.ts'
import type { PrivateRpc } from '../src/rpc.ts'
import type { Hex } from 'viem'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
} })
const password = 'disposable backup password'
const owner: BackupContext = { walletId: `0x${'1'.repeat(40)}`, chainId: config.chainId, pool: config.pool }
const makeRecord = (): StoredNote => ({ note: createNote(config.pool, config.chainId), status: 'unspent' })
const realCrypto = () => Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => { realCrypto(); await lockLocalWallet(); storage.clear() })
afterEach(async () => { realCrypto(); await lockLocalWallet() })

test('encrypted backups round-trip notes without exposing their fields, owner or password', async () => {
  const record = makeRecord()
  const encoded = await encryptNoteBackup([record], owner, password)
  const decoded = await decryptNoteBackup(encoded, password, owner)
  assert.equal(encoded.includes(record.note.secret.toString()), false)
  assert.equal(encoded.includes(record.note.nullifier.toString()), false)
  assert.equal(encoded.includes(owner.walletId), false)
  assert.equal(encoded.includes(password), false)
  assert.ok(decoded[0].note.secret === record.note.secret)
  assert.ok(decoded[0].note.nullifier === record.note.nullifier)
  assert.equal(decoded[0].note.commitment, record.note.commitment.toLowerCase())
  assert.notEqual(await encryptNoteBackup([record], owner, password), encoded)
})
test('a wrong password, damaged file or unsupported encryption settings leave restore unavailable', async () => {
  const encoded = await encryptNoteBackup([makeRecord()], owner, password)
  await assert.rejects(decryptNoteBackup(encoded, 'another disposable password', owner), /Could not decrypt/)
  const damaged = JSON.parse(encoded)
  damaged.cipher.data = `${damaged.cipher.data[0] === 'A' ? 'B' : 'A'}${damaged.cipher.data.slice(1)}`
  await assert.rejects(decryptNoteBackup(JSON.stringify(damaged), password, owner), /Could not decrypt/)
  const incompatible = JSON.parse(encoded); incompatible.kdf.iterations = 1_000_000_000
  await assert.rejects(decryptNoteBackup(JSON.stringify(incompatible), password, owner), /Unsupported/)
  await assert.rejects(decryptNoteBackup(JSON.stringify([makeRecord()], (_, value) => typeof value === 'bigint' ? String(value) : value), password, owner), /Invalid note backup/)
})
test('wallet, chain and pool binding reject a backup opened in the wrong context', async () => {
  const encoded = await encryptNoteBackup([makeRecord()], owner, password)
  await assert.rejects(decryptNoteBackup(encoded, password, { ...owner, walletId: `0x${'2'.repeat(40)}` }), /original wallet/)
  await assert.rejects(decryptNoteBackup(encoded, password, { ...owner, chainId: owner.chainId + 1 }), /another network or pool/)
  await assert.rejects(decryptNoteBackup(encoded, password, { ...owner, pool: `0x${'2'.repeat(40)}` }), /another network or pool/)
})
test('duplicate, inconsistent or mixed-pool records do not create a partial backup', async () => {
  const record = makeRecord()
  await assert.rejects(encryptNoteBackup([record, record], owner, password), /duplicate/)
  await assert.rejects(encryptNoteBackup([{ ...record, note: { ...record.note, secret: record.note.secret + 1n } }], owner, password), /commitment/)
  await assert.rejects(encryptNoteBackup([{ ...record, note: { ...record.note, pool: `0x${'2'.repeat(40)}` } }], owner, password), /another network or pool/)
})
test('restore deduplicates and keeps spent/reserved notes unavailable, with new notes pending a chain check', () => {
  const spent = makeRecord(), reserved = makeRecord(), added = makeRecord()
  const current: StoredNote[] = [{ ...spent, status: 'spent' }, { ...spent, status: 'unspent' }, { ...reserved, status: 'spending' }]
  const result = mergeRestoredNotes(current, [spent, reserved, added])
  assert.equal(result.notes.length, 3)
  assert.equal(result.notes.find(record => record.note.commitment === spent.note.commitment)?.status, 'spent')
  assert.equal(result.notes.find(record => record.note.commitment === reserved.note.commitment)?.status, 'spending')
  assert.equal(result.notes.find(record => record.note.commitment === added.note.commitment)?.status, 'pending-deposit')
  assert.equal(result.result.added, 1)
  assert.equal(current[0].status, 'spent')
})
test('pending transaction metadata survives encryption but no signer key is included', async () => {
  const record = makeRecord(), txHash = `0x${'a'.repeat(64)}` as Hex
  record.status = 'spending'; record.txHash = txHash
  record.pending = { operation: 'claim', txHash, chainId: config.chainId, pool: record.note.pool, sender: `0x${'2'.repeat(40)}`, recipient: `0x${'3'.repeat(40)}`, nullifierHash: `0x${hash(record.note.nullifier).toString(16).padStart(64, '0')}`, feeWei: String(CLAIM_FEE), amountWei: String(NOTE_VALUE - CLAIM_FEE) }
  const decoded = await decryptNoteBackup(await encryptNoteBackup([record], owner, password), password, owner)
  assert.equal(decoded[0].pending?.txHash, txHash)
  assert.equal(decoded[0].status, 'spending')
  assert.equal('privateKey' in decoded[0].pending!, false)
})
test('mnemonic restore in fresh storage can decrypt a separate note backup despite a new vault password and salt', async () => {
  const created = await createLocalWallet('first disposable wallet password', 0)
  const originalWallet = unlockedWalletId(), record = makeRecord()
  await saveStoredNotes([record])
  const route = { fetchRpc: async () => { throw new Error('Backup must not use the network') } } as unknown as PrivateRpc
  const api = createPoolApi(route)
  const backup = await api.exportNoteBackup(password)
  await lockLocalWallet(); storage.clear()
  await importLocalWallet(created.recoveryPhrase, 'different disposable wallet password')
  assert.equal(unlockedWalletId(), originalWallet)
  const restored = await api.restoreNoteBackup(backup.contents, password)
  assert.equal(restored.added, 1)
  assert.ok((await listStoredNotes())[0].note.secret === record.note.secret)
  assert.equal((await listStoredNotes())[0].status, 'pending-deposit')
  await mutateStoredNotes(notes => { notes[0].status = 'spent' })
  await api.restoreNoteBackup(backup.contents, password)
  const notes = await listStoredNotes()
  assert.equal(notes.length, 1); assert.equal(notes[0].status, 'spent')
  await reconcileNotes(async (_url, body) => ({ jsonrpc: '2.0', id: (body as { id: number }).id, result: [] }))
  assert.equal((await listStoredNotes())[0].status, 'spent')
})

function pauseCrypto(operation: 'encrypt' | 'decrypt') {
  const started = deferred(), release = deferred()
  let once = true
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: new Proxy(webcrypto.subtle, { get(target, property) {
      if (property === operation) return async (...args: Parameters<SubtleCrypto['encrypt']>) => {
        if (once) { once = false; started.resolve(); await release.promise }
        return Reflect.apply(target[operation], target, args)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }),
  } })
  return { started, release }
}
test('locking and switching wallets while exporting prevents the old backup from being returned', async () => {
  await createLocalWallet('disposable first wallet password', 0)
  await saveStoredNotes([makeRecord()])
  const pause = pauseCrypto('encrypt')
  const exporting = exportPrivateNoteBackup(password)
  const rejected = assert.rejects(exporting, /Wallet session changed|Wallet is locked/)
  await pause.started.promise
  await lockLocalWallet(); storage.clear(); await createLocalWallet('disposable second wallet password', 0)
  pause.release.resolve(); await rejected
  assert.deepEqual(await listStoredNotes(), [])
})
test('locking and switching wallets during restore cannot write old notes into the new wallet', async () => {
  await createLocalWallet('disposable first wallet password', 0)
  const record = makeRecord(), originalOwner = { ...owner, walletId: unlockedWalletId() }
  const encoded = await encryptNoteBackup([record], originalOwner, password)
  const pause = pauseCrypto('decrypt')
  const restoring = restorePrivateNoteBackup(encoded, password)
  const rejected = assert.rejects(restoring, /Wallet session changed|Wallet is locked/)
  await pause.started.promise
  await lockLocalWallet(); storage.clear(); await createLocalWallet('disposable second wallet password', 0)
  const ownRecord = makeRecord(); await saveStoredNotes([ownRecord])
  pause.release.resolve(); await rejected
  const notes = await listStoredNotes()
  assert.equal(notes.length, 1)
  assert.ok(notes[0].note.secret === ownRecord.note.secret)
})
