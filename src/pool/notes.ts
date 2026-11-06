import type { Note } from './index.ts'
import { hash, syncDeposits } from './index.ts'
import type { RpcTransport } from './index.ts'
import { rpc } from './network.ts'
import { config } from './index.ts'
import { unlockedEncryptionKey, unlockedWalletId } from '../wallet/lifecycle.ts'
import { keccak256, toHex, type Hex } from 'viem'
export type NoteStatus = 'pending-deposit' | 'unspent' | 'spending' | 'spent'
export type StoredNote = { note: Note; status: NoteStatus; txHash?: `0x${string}` }
const prefix = '0xpay.notes.v1.'
const claimTopic = keccak256(toHex('Claim(address,bytes32,uint256)'))
function storageKey() { return prefix + unlockedWalletId() }
function bytes(hex: string) { return Uint8Array.from(hex.match(/../g)!.map(x => parseInt(x, 16))) }
async function key() { return crypto.subtle.importKey('raw', bytes(unlockedEncryptionKey()), 'AES-GCM', false, ['encrypt', 'decrypt']) }
export async function listStoredNotes(): Promise<StoredNote[]> {
  const raw = localStorage.getItem(storageKey()); if (!raw) return []
  const envelope = JSON.parse(raw) as { iv: string; data: string }
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv) }, await key(), bytes(envelope.data))
  const serialized = JSON.parse(new TextDecoder().decode(plain)) as { note: Omit<Note, 'nullifier' | 'secret'> & { nullifier: string; secret: string }; status: NoteStatus; txHash?: `0x${string}` }[]
  return serialized.map(x => ({ ...x, note: { ...x.note, nullifier: BigInt(x.note.nullifier), secret: BigInt(x.note.secret) } }))
}
export async function saveStoredNotes(notes: StoredNote[]) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(notes, (_, v) => typeof v === 'bigint' ? v.toString() : v))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), data))
  const hex = (v: Uint8Array) => Array.from(v, x => x.toString(16).padStart(2, '0')).join('')
  localStorage.setItem(storageKey(), JSON.stringify({ iv: hex(iv), data: hex(encrypted) }))
}
export async function claimedNullifiers(transport: RpcTransport): Promise<Set<string>> {
  const logs = await rpc<{ topics: Hex[] }[]>(config.mempoolRpc, 'eth_getLogs', [{
    address: config.pool, fromBlock: '0x0', toBlock: 'latest', topics: [claimTopic],
  }], transport)
  const claimed = new Set<string>()
  for (const log of logs) {
    if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== claimTopic.toLowerCase()
      || !/^0x[0-9a-f]{64}$/i.test(log.topics[2])) throw new Error('Invalid Claim event log')
    claimed.add(log.topics[2].toLowerCase())
  }
  return claimed
}
export async function reconcileNotes(transport: RpcTransport) {
  const notes = await listStoredNotes(); if (!notes.length) return notes
  const { logs } = await syncDeposits(config.pool, transport)
  const claimed = await claimedNullifiers(transport)
  for (const entry of notes) {
    const exists = logs.some(x => x.commitment.toLowerCase() === entry.note.commitment.toLowerCase())
    if (!exists) { entry.status = 'pending-deposit'; continue }
    const nullifierHash = `0x${hash(entry.note.nullifier).toString(16).padStart(64, '0')}` as const
    entry.status = claimed.has(nullifierHash.toLowerCase()) ? 'spent' : entry.status === 'spending' ? 'spending' : 'unspent'
  }
  await saveStoredNotes(notes); return notes
}
