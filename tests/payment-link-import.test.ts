import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { createPoolApi } from '../src/pool/api.ts'
import { config, createNote, encodeNoteLink } from '../src/pool/index.ts'
import { listStoredNotes, mutateStoredNotes } from '../src/pool/notes.ts'
import { createLocalWallet, lockLocalWallet, unlockedWalletId } from '../src/wallet/lifecycle.ts'
import type { PrivateRpc } from '../src/rpc.ts'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
} })
const methods: string[] = []
const route = { chain: 'devnet', fetchRpc: async (body: string) => {
  const request = JSON.parse(body) as { id: number; method: string }
  methods.push(request.method)
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [] }))
} } as unknown as PrivateRpc

beforeEach(async () => { await lockLocalWallet(); storage.clear(); methods.length = 0; await createLocalWallet('disposable link-test password', 0) })
afterEach(async () => { await lockLocalWallet() })

test('link import stores the note encrypted and reserved until a routed chain check', async () => {
  const note = createNote(config.pool, config.chainId)
  const link = encodeNoteLink(note, 'https://0xpay.fun/alt-mempool-wallet/?view=wallet')
  const api = createPoolApi(route)

  assert.equal(await api.importPaymentLink(link), note.commitment)
  const stored = await listStoredNotes()
  assert.equal(stored.length, 1)
  assert.equal(stored[0].source, 'link')
  assert.equal(stored[0].status, 'pending-deposit')
  assert.equal(stored[0].note.secret, note.secret)
  const encrypted = storage.get(`0xpay.notes.v1.${unlockedWalletId()}`)!
  assert.equal(encrypted.includes(note.secret.toString()), false)
  assert.equal(encrypted.includes(link.split('#')[1]), false)
  assert.deepEqual(methods, [])

  await assert.rejects(api.claimImportedLink(note.commitment, () => {}), /not yet verified as spendable/)
  assert.deepEqual(methods, ['eth_getLogs', 'eth_getLogs'])
  assert.equal((await listStoredNotes())[0].status, 'pending-deposit')
  assert.equal(methods.some(method => method.startsWith('eth_send')), false)
})

test('reimport is idempotent for a live note but refuses spent or uncertain notes', async () => {
  const note = createNote(config.pool, config.chainId)
  const link = encodeNoteLink(note, 'https://0xpay.fun/')
  const api = createPoolApi(route)
  await api.importPaymentLink(link)
  await mutateStoredNotes(notes => { notes[0].status = 'unspent' })
  assert.equal(await api.importPaymentLink(link), note.commitment)
  assert.equal((await listStoredNotes()).length, 1)

  await mutateStoredNotes(notes => { notes[0].status = 'spending' })
  await assert.rejects(api.importPaymentLink(link), /already used or awaiting verification/)
  await mutateStoredNotes(notes => { notes[0].status = 'spent' })
  await assert.rejects(api.importPaymentLink(link), /already used or awaiting verification/)
  assert.equal((await listStoredNotes()).length, 1)
})

test('wrong-pool and invalid links never write notes', async () => {
  const otherPool = `0x${'a'.repeat(40)}` as const
  const note = createNote(otherPool, config.chainId)
  const api = createPoolApi(route)
  await assert.rejects(api.importPaymentLink(encodeNoteLink(note, 'https://0xpay.fun/')), /another network or pool/)
  await assert.rejects(api.importPaymentLink('https://0xpay.fun/#claim=invalid'), /./)
  assert.deepEqual(await listStoredNotes(), [])
  assert.deepEqual(methods, [])
})
