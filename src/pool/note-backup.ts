import { config, hash, type Note } from './index.ts'
import { assertNoteSession, captureNoteSession, listStoredNotes, mutateStoredNotes, type StoredNote } from './notes.ts'
import { NOTE_VALUE, type PreparedPayment } from './payment-records.ts'

const FORMAT = '0xpay-private-notes'
const ITERATIONS = 310_000
const MAX_NOTES = 4096
const MAX_PLAIN_BYTES = 2 * 1024 * 1024
export const MAX_NOTE_BACKUP_BYTES = 3 * 1024 * 1024
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
export type BackupContext = { walletId: string; chainId: number; pool: string }
export type NoteRestoreResult = { added: number; existing: number; reserved: number; total: number }
type RecordValue = Record<string, unknown>
function json(text: string): unknown { try { return JSON.parse(text) } catch { throw new Error('Invalid note backup data') } }
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid note backup record')
  return value as RecordValue
}
function shape(value: RecordValue, required: string[], optional: string[] = []) {
  if (required.some(name => !(name in value)) || Object.keys(value).some(name => !required.includes(name) && !optional.includes(name))) throw new Error('Unsupported note backup fields')
}
function hex(value: unknown, bytes: number): `0x${string}` {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) throw new Error('Invalid note backup identifier')
  return value.toLowerCase() as `0x${string}`
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid note backup number')
  return BigInt(value)
}
function context(value: BackupContext): BackupContext {
  if (!Number.isSafeInteger(value.chainId) || value.chainId < 1) throw new Error('Invalid backup network')
  return { walletId: hex(value.walletId, 20), chainId: value.chainId, pool: hex(value.pool, 20) }
}
function checkContext(actual: BackupContext, expected: BackupContext) {
  if (actual.walletId !== expected.walletId) throw new Error('Unlock the original wallet before restoring its notes')
  if (actual.chainId !== expected.chainId || actual.pool !== expected.pool) throw new Error('This backup belongs to another network or pool')
}
function pending(value: unknown, note: Note): PreparedPayment {
  const record = object(value)
  const base = ['operation', 'txHash', 'chainId', 'pool', 'sender', 'amountWei']
  if (record.operation === 'deposit') shape(record, [...base, 'commitment', 'nonce'])
  else if (record.operation === 'claim') shape(record, [...base, 'recipient', 'nullifierHash', 'feeWei'])
  else throw new Error('Invalid pending backup operation')
  const common = { txHash: hex(record.txHash, 32), chainId: record.chainId as number, pool: hex(record.pool, 20), sender: hex(record.sender, 20), amountWei: decimal(record.amountWei).toString() }
  if (common.chainId !== note.chainId || common.pool !== note.pool) throw new Error('Pending payment belongs to another note context')
  if (record.operation === 'deposit') {
    if (!Number.isSafeInteger(record.nonce) || Number(record.nonce) < 0 || hex(record.commitment, 32) !== note.commitment || BigInt(common.amountWei) !== NOTE_VALUE) throw new Error('Invalid pending deposit backup')
    return { ...common, operation: 'deposit', commitment: note.commitment, nonce: Number(record.nonce) }
  }
  const fee = decimal(record.feeWei), recipient = hex(record.recipient, 20), nullifierHash = hex(record.nullifierHash, 32)
  if (fee >= NOTE_VALUE || BigInt(common.amountWei) !== NOTE_VALUE - fee || BigInt(recipient) === 0n || BigInt(nullifierHash) !== hash(note.nullifier)) throw new Error('Invalid pending claim backup')
  return { ...common, operation: 'claim', recipient, nullifierHash, feeWei: fee.toString() }
}
function parseRecord(value: unknown, expected: BackupContext): StoredNote {
  const record = object(value); shape(record, ['note', 'status'], ['source', 'txHash', 'pending'])
  const raw = object(record.note); shape(raw, ['nullifier', 'secret', 'commitment', 'pool', 'chainId'])
  const note: Note = { nullifier: decimal(raw.nullifier), secret: decimal(raw.secret), commitment: hex(raw.commitment, 32), pool: hex(raw.pool, 20), chainId: raw.chainId as number }
  if (note.nullifier <= 0n || note.nullifier >= FIELD || note.secret <= 0n || note.secret >= FIELD || !Number.isSafeInteger(note.chainId)) throw new Error('Invalid private note fields')
  if (note.chainId !== expected.chainId || note.pool !== expected.pool) throw new Error('This backup contains notes for another network or pool; no partial backup was created')
  if (hash(note.nullifier, note.secret) !== BigInt(note.commitment)) throw new Error('Note backup commitment does not match its private fields')
  if (!['pending-deposit', 'unspent', 'spending', 'spent'].includes(String(record.status))) throw new Error('Invalid backed-up note status')
  const result: StoredNote = { note, status: record.status as StoredNote['status'] }
  if (record.source !== undefined) {
    if (record.source !== 'link') throw new Error('Invalid note backup source')
    result.source = 'link'
  }
  if (record.txHash !== undefined) result.txHash = hex(record.txHash, 32)
  if (record.pending !== undefined) {
    result.pending = pending(record.pending, note)
    if (result.txHash !== result.pending.txHash) throw new Error('Pending note backup hash is inconsistent')
  }
  return result
}
function serialized(records: StoredNote[]) { return JSON.parse(JSON.stringify(records, (_, value) => typeof value === 'bigint' ? value.toString() : value)) as unknown[] }
function parseRecords(value: unknown, expected: BackupContext): StoredNote[] {
  if (!Array.isArray(value) || value.length > MAX_NOTES) throw new Error('Invalid note backup size')
  const records = value.map(record => parseRecord(record, expected))
  const keys = records.map(record => record.note.commitment)
  if (new Set(keys).size !== keys.length) throw new Error('Note backup contains duplicate records')
  return records
}
function base64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 16384) text += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
  return btoa(text)
}
function unbase64(value: unknown, exact?: number): Uint8Array {
  if (typeof value !== 'string' || value.length > MAX_NOTE_BACKUP_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encrypted backup encoding')
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0)) } catch { throw new Error('Invalid encrypted backup encoding') }
  if ((exact !== undefined && bytes.length !== exact) || base64(bytes) !== value) throw new Error('Invalid encrypted backup encoding')
  return bytes
}
async function backupKey(password: string, salt: Uint8Array) {
  if (password.length < 12 || password.length > 1024) throw new Error('Use a backup password with 12 to 1024 characters')
  const bytes = new TextEncoder().encode(password)
  try {
    const source = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey'])
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: ITERATIONS }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } finally { bytes.fill(0) }
}

export async function encryptNoteBackup(records: StoredNote[], owner: BackupContext, password: string): Promise<string> {
  const expected = context(owner)
  const checked = parseRecords(serialized(records), expected)
  const plain = new TextEncoder().encode(JSON.stringify({ version: 1, ...expected, notes: serialized(checked) }))
  if (plain.byteLength > MAX_PLAIN_BYTES) { plain.fill(0); throw new Error('Private-note backup is too large') }
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await backupKey(password, salt), plain))
    return JSON.stringify({ format: FORMAT, version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: base64(salt) }, cipher: { name: 'AES-GCM', iv: base64(iv), data: base64(ciphertext) } })
  } finally { plain.fill(0) }
}
export async function decryptNoteBackup(encoded: string, password: string, owner: BackupContext): Promise<StoredNote[]> {
  if (new TextEncoder().encode(encoded).length > MAX_NOTE_BACKUP_BYTES) throw new Error('Private-note backup is too large')
  const envelope = object(json(encoded)); shape(envelope, ['format', 'version', 'kdf', 'cipher'])
  const kdf = object(envelope.kdf), cipher = object(envelope.cipher)
  shape(kdf, ['name', 'hash', 'iterations', 'salt']); shape(cipher, ['name', 'iv', 'data'])
  if (envelope.format !== FORMAT || envelope.version !== 1 || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || kdf.iterations !== ITERATIONS || cipher.name !== 'AES-GCM') throw new Error('Unsupported encrypted note backup format')
  const salt = unbase64(kdf.salt, 16), iv = unbase64(cipher.iv, 12), ciphertext = unbase64(cipher.data)
  if (ciphertext.length < 16 || ciphertext.length > MAX_PLAIN_BYTES + 16) throw new Error('Invalid encrypted backup size')
  let plain: Uint8Array
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, await backupKey(password, salt), new Uint8Array(ciphertext))) }
  catch { throw new Error('Could not decrypt this note backup. Check its password and file.') }
  try {
    const payload = object(json(new TextDecoder('utf-8', { fatal: true }).decode(plain)))
    shape(payload, ['version', 'walletId', 'chainId', 'pool', 'notes'])
    if (payload.version !== 1) throw new Error('Unsupported private-note payload')
    const expected = context(owner), actual = context(payload as unknown as BackupContext)
    checkContext(actual, expected)
    return parseRecords(payload.notes, expected)
  } finally { plain.fill(0) }
}

/** Offline restore never makes an imported note immediately spendable. */
export function mergeRestoredNotes(current: StoredNote[], imported: StoredNote[]): { notes: StoredNote[]; result: NoteRestoreResult } {
  const key = (record: StoredNote) => `${record.note.chainId}:${record.note.pool.toLowerCase()}:${record.note.commitment.toLowerCase()}`
  const merged: StoredNote[] = []
  const rank = { 'pending-deposit': 0, unspent: 1, spending: 2, spent: 3 }
  const combine = (record: StoredNote) => {
    const index = merged.findIndex(candidate => key(candidate) === key(record))
    if (index < 0) { merged.push({ ...record, note: { ...record.note } }); return false }
    const previous = merged[index]
    if (previous.note.nullifier !== record.note.nullifier || previous.note.secret !== record.note.secret) throw new Error('Existing note does not match this backup')
    if (previous.pending && record.pending) {
      const fields = (intent: typeof previous.pending) => JSON.stringify(Object.entries(intent!).sort(([a], [b]) => a.localeCompare(b)))
      if (fields(previous.pending) !== fields(record.pending)) throw new Error('This note has conflicting pending payments; reconcile the existing payment before restoring')
    }
    // An exact signed intent must survive a restore even when both records have
    // the same status. Its hash is needed to reconcile an uncertain broadcast.
    if (previous.status !== 'spent' && (record.status === 'spent'
      || (record.pending && !previous.pending)
      || (!previous.pending && rank[record.status] > rank[previous.status]))) {
      merged[index] = { ...record, note: { ...record.note } }
    }
    if (previous.source === 'link' || record.source === 'link') merged[index].source = 'link'
    return true
  }
  for (const record of current) combine(record)
  let added = 0, existing = 0
  for (const record of imported) {
    const incoming: StoredNote = { ...record, note: { ...record.note }, status: record.status === 'spent' ? 'spent' : record.status === 'spending' || record.pending?.operation === 'claim' ? 'spending' : 'pending-deposit' }
    if (combine(incoming)) existing++
    else added++
  }
  if (merged.length > MAX_NOTES) throw new Error('Combined note backup is too large; no notes were restored')
  return { notes: merged, result: { added, existing, reserved: merged.filter(record => record.status === 'spending' || record.status === 'pending-deposit').length, total: merged.length } }
}
export async function exportPrivateNoteBackup(password: string): Promise<{ contents: string; noteCount: number }> {
  const session = captureNoteSession(), owner = { walletId: session.id, chainId: config.chainId, pool: config.pool }
  const records = await listStoredNotes(session)
  if (!records.length) throw new Error('There are no private notes to back up yet')
  const contents = await encryptNoteBackup(records, owner, password)
  assertNoteSession(session)
  return { contents, noteCount: records.length }
}
export async function restorePrivateNoteBackup(contents: string, password: string): Promise<NoteRestoreResult> {
  const session = captureNoteSession(), owner = { walletId: session.id, chainId: config.chainId, pool: config.pool }
  const imported = await decryptNoteBackup(contents, password, owner)
  assertNoteSession(session)
  let result: NoteRestoreResult | undefined
  await mutateStoredNotes(current => {
    const merged = mergeRestoredNotes(current, imported)
    current.splice(0, current.length, ...merged.notes)
    result = merged.result
  }, session)
  return result!
}
