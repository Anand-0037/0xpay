import type { Note } from './index.ts'
import { hash, syncDeposits } from './index.ts'
import type { RpcTransport } from './index.ts'
import { rpc } from './network.ts'
import { config } from './index.ts'
import { assertUnlockedSession, unlockedEncryptionKey, unlockedSessionVersion, unlockedWalletId } from '../wallet/lifecycle.ts'
import { keccak256, toHex, type Hex } from 'viem'
import type { PreparedPayment } from './payment-records.ts'
import { NOTE_VALUE, verifyDepositReceipt, type PaymentReceipt } from './payment-records.ts'
export type NoteStatus = 'pending-deposit' | 'unspent' | 'spending' | 'spent'
export type StoredNote = { note: Note; status: NoteStatus; source?: 'link'; txHash?: `0x${string}`; pending?: PreparedPayment }
const prefix = '0xpay.notes.v1.'
const claimTopic = keccak256(toHex('Claim(address,bytes32,uint256)'))
export type NoteSession = { id: string; version: number }
export function captureNoteSession(): NoteSession { return { id: unlockedWalletId(), version: unlockedSessionVersion() } }
export function assertNoteSession(session: NoteSession) { assertUnlockedSession(session.id, session.version) }
function storageKey(session: NoteSession) { return prefix + session.id }
function claimLockName(note: Note, session: NoteSession) { return `0xpay.claim.${session.id}.${note.chainId}.${note.pool.toLowerCase()}.${note.commitment.toLowerCase()}` }
/** Hold a separate cross-tab lock until the signed intent is persisted or the
 * operation ends. Reconciliation must not free a note while a proof is active. */
export function withClaimReservation<T>(note: Note, session: NoteSession, operation: () => Promise<T>): Promise<T> {
  assertNoteSession(session)
  if (typeof navigator === 'undefined' || !navigator.locks) return operation()
  return navigator.locks.request(claimLockName(note, session), async () => {
    assertNoteSession(session)
    return operation()
  })
}
function withIdleClaimReservation<T>(note: Note, session: NoteSession, operation: () => Promise<T>): Promise<T | undefined> {
  // Without Web Locks, another tab could still be generating a proof. Keep
  // orphaned reservations unavailable rather than risk a duplicate payment.
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(undefined)
  return navigator.locks.request(claimLockName(note, session), { ifAvailable: true }, async lock => {
    if (!lock) return undefined
    assertNoteSession(session)
    return operation()
  })
}
function bytes(hex: string) { return Uint8Array.from(hex.match(/../g)!.map(x => parseInt(x, 16))) }
async function key(session: NoteSession) {
  assertNoteSession(session)
  const capturedKey = bytes(unlockedEncryptionKey())
  try {
    const imported = await crypto.subtle.importKey('raw', capturedKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
    assertNoteSession(session)
    return imported
  } finally { capturedKey.fill(0) }
}
export async function listStoredNotes(session = captureNoteSession()): Promise<StoredNote[]> {
  assertNoteSession(session)
  const raw = localStorage.getItem(storageKey(session)); if (!raw) return []
  const envelope = JSON.parse(raw) as { iv: string; data: string }
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv) }, await key(session), bytes(envelope.data))
  assertNoteSession(session)
  const serialized = JSON.parse(new TextDecoder().decode(plain)) as { note: Omit<Note, 'nullifier' | 'secret'> & { nullifier: string; secret: string }; status: NoteStatus; source?: 'link'; txHash?: `0x${string}`; pending?: PreparedPayment }[]
  return serialized.map(x => ({ ...x, note: { ...x.note, nullifier: BigInt(x.note.nullifier), secret: BigInt(x.note.secret) } }))
}
async function writeStoredNotes(notes: StoredNote[], session: NoteSession) {
  assertNoteSession(session)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(notes, (_, v) => typeof v === 'bigint' ? v.toString() : v))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(session), data))
  const hex = (v: Uint8Array) => Array.from(v, x => x.toString(16).padStart(2, '0')).join('')
  assertNoteSession(session)
  localStorage.setItem(storageKey(session), JSON.stringify({ iv: hex(iv), data: hex(encrypted) }))
}
const mutations = new Map<string, Promise<void>>()
/** Read-modify-encrypt-write as one per-wallet operation. Web Locks also cover
 * same-origin tabs; the queue covers callers and non-browser test runtimes. */
export function mutateStoredNotes(mutate: (notes: StoredNote[]) => void, session = captureNoteSession()): Promise<StoredNote[]> {
  const name = storageKey(session)
  const run = (mutations.get(name) ?? Promise.resolve()).then(async () => {
    const work = async () => {
      assertNoteSession(session)
      const notes = await listStoredNotes(session)
      mutate(notes)
      await writeStoredNotes(notes, session)
      return notes
    }
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(name, work) : work()
  })
  const tail = run.then(() => undefined, () => undefined)
  mutations.set(name, tail)
  void tail.then(() => { if (mutations.get(name) === tail) mutations.delete(name) })
  return run
}
/** Compatibility upsert. An older caller's snapshot must never delete notes
 * added since it was read. Status changes should use mutateStoredNotes. */
export async function saveStoredNotes(notes: StoredNote[], session = captureNoteSession()) {
  await mutateStoredNotes(current => {
    for (const entry of notes) {
      const index = current.findIndex(value => value.note.commitment.toLowerCase() === entry.note.commitment.toLowerCase())
      if (index < 0) current.push(entry)
      else current[index] = entry
    }
  }, session)
}
export async function claimedNullifiers(transport: RpcTransport): Promise<Map<string, Hex | undefined>> {
  const logs = await rpc<{ topics: Hex[]; transactionHash?: Hex }[]>(config.mempoolRpc, 'eth_getLogs', [{
    address: config.pool, fromBlock: '0x0', toBlock: 'latest', topics: [claimTopic],
  }], transport)
  const claimed = new Map<string, Hex | undefined>()
  for (const log of logs) {
    if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== claimTopic.toLowerCase()
      || !/^0x[0-9a-f]{64}$/i.test(log.topics[2])) throw new Error('Invalid Claim event log')
    if (log.transactionHash !== undefined && !/^0x[0-9a-f]{64}$/i.test(log.transactionHash)) throw new Error('Invalid Claim transaction hash')
    claimed.set(log.topics[2].toLowerCase(), log.transactionHash)
  }
  return claimed
}
export async function reconcileNotes(transport: RpcTransport, session = captureNoteSession()) {
  const notes = await listStoredNotes(session); if (!notes.length) return notes
  const noteId = (entry: StoredNote) => `${entry.note.chainId}:${entry.note.pool.toLowerCase()}:${entry.note.commitment.toLowerCase()}`
  const observed = new Map(notes.map(entry => [noteId(entry), { status: entry.status, txHash: entry.txHash }]))
  const { logs } = await syncDeposits(config.pool, transport)
  assertNoteSession(session)
  const claimed = await claimedNullifiers(transport)
  assertNoteSession(session)
  await mutateStoredNotes(current => {
    for (const entry of current) {
      // Absence from a later RPC response cannot resurrect a spent note, and
      // this pool's reconciliation must not change another pool's records.
      if (entry.pending || entry.note.chainId !== config.chainId || entry.note.pool.toLowerCase() !== config.pool.toLowerCase()) continue
      const previous = observed.get(noteId(entry))
      // Do not overwrite a note created, reserved, or confirmed while these
      // network reads were pending. A later refresh can reconcile that note.
      if (!previous || previous.status !== entry.status || previous.txHash !== entry.txHash) continue
      const nullifierHash = `0x${hash(entry.note.nullifier).toString(16).padStart(64, '0')}` as const
      if (entry.status === 'spent') {
        // A different browser may have spent the note. Keep the conservative
        // spent state, but replace an old deposit reference with the claim hash.
        const claimHash = claimed.get(nullifierHash.toLowerCase())
        if (claimHash) entry.txHash = claimHash
        continue
      }
      const exists = logs.some(x => x.commitment.toLowerCase() === entry.note.commitment.toLowerCase())
      if (!exists) { if (entry.status !== 'spending') entry.status = 'pending-deposit'; continue }
      const claimHash = claimed.get(nullifierHash.toLowerCase())
      entry.status = claimed.has(nullifierHash.toLowerCase()) ? 'spent' : entry.status === 'spending' ? 'spending' : 'unspent'
      if (claimHash) entry.txHash = claimHash
    }
  }, session)
  // A claim cannot be broadcast until its signed hash and pending intent have
  // been persisted together. An interrupted proof leaves only the old deposit
  // hash (or no hash for an imported note). Hold the per-note lock while
  // confirming and releasing it; an active proof or unknown hash stays reserved.
  for (const entry of notes) {
    if (entry.status !== 'spending' || entry.pending || entry.note.chainId !== config.chainId
      || entry.note.pool.toLowerCase() !== config.pool.toLowerCase()) continue
    const deposit = logs.find(log => log.commitment.toLowerCase() === entry.note.commitment.toLowerCase())
    const nullifierHash = `0x${hash(entry.note.nullifier).toString(16).padStart(64, '0')}`
    if (!deposit || claimed.has(nullifierHash.toLowerCase())) continue
    await withIdleClaimReservation(entry.note, session, async () => {
      if (entry.txHash) {
        const receipt = await rpc<PaymentReceipt | null>(config.mempoolRpc, 'eth_getTransactionReceipt', [entry.txHash], transport)
        assertNoteSession(session)
        if (!receipt) return
        try {
          const verified = verifyDepositReceipt(receipt, { operation: 'deposit', txHash: entry.txHash,
            chainId: entry.note.chainId, pool: entry.note.pool, sender: receipt.from,
            commitment: entry.note.commitment, nonce: 0, amountWei: String(NOTE_VALUE) })
          if (verified.leafIndex !== deposit.leafIndex) return
        } catch { return /* A claim or unverified hash stays reserved. */ }
      }
      await mutateStoredNotes(current => {
        const latest = current.find(value => noteId(value) === noteId(entry))
        if (latest?.status === 'spending' && !latest.pending && latest.txHash === entry.txHash) latest.status = 'unspent'
      }, session)
    })
  }
  return listStoredNotes(session)
}
