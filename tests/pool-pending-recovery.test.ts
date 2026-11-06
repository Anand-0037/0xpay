import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem'
import { createLocalWallet, lockLocalWallet } from '../src/wallet/lifecycle.ts'
import { createPoolApi } from '../src/pool/api.ts'
import { config, createNote, hash } from '../src/pool/index.ts'
import { listStoredNotes, reconcileNotes, saveStoredNotes } from '../src/pool/notes.ts'
import { claimEvent, depositEvent, nativeTransferEvent, NATIVE_TRANSFER_ADDRESS, NOTE_VALUE, type ClaimIntent, type DepositIntent, type PaymentReceipt } from '../src/pool/payment-records.ts'
import type { PrivateRpc } from '../src/rpc.ts'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
} })
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
const txHash = `0x${'a'.repeat(64)}` as Hex
const blockHash = `0x${'b'.repeat(64)}` as Hex
const sender = `0x${'1'.repeat(40)}` as Hex
const recipient = `0x${'2'.repeat(40)}` as Hex
const other = `0x${'3'.repeat(40)}` as Hex

function routeFor(receipt: PaymentReceipt | null, options: { down?: boolean; spent?: boolean } = {}) {
  const methods: string[] = []
  const route = { chain: 'devnet', network: 'nym', stats: { attempted: 0 }, fetchRpc: async (body: string) => {
    const request = JSON.parse(body) as { id: number; method: string; params: unknown[] }
    methods.push(request.method)
    if (options.down) throw new Error('Private route disconnected')
    let result: unknown
    switch (request.method) {
      case 'eth_chainId': result = toHex(config.chainId); break
      case 'eth_getTransactionReceipt': assert.deepEqual(request.params, [txHash]); result = receipt; break
      case 'eth_getBlockByNumber': result = { hash: blockHash }; break
      case 'eth_getBalance': result = toHex(6n); break
      case 'eth_call': result = encodeAbiParameters([{ type: 'bool' }], [options.spent ?? true]); break
      case 'eth_getLogs': result = []; break
      default: throw new Error(`Unexpected RPC ${request.method}`)
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
  } } as unknown as PrivateRpc
  return { route, methods }
}
beforeEach(async () => { await lockLocalWallet(); storage.clear(); await createLocalWallet('disposable test password', 0) })
afterEach(async () => { await lockLocalWallet() })

test('lost deposit response survives reload, stays reserved until exact receipt, then verifies once', async () => {
  const note = createNote(config.pool, config.chainId)
  const intent: DepositIntent = { operation: 'deposit', txHash, chainId: config.chainId, pool: config.pool, sender, commitment: note.commitment, nonce: 0, amountWei: String(NOTE_VALUE) }
  await saveStoredNotes([{ note, status: 'pending-deposit', txHash, pending: intent }])
  const saved = await listStoredNotes()
  assert.equal(saved[0].pending?.txHash, txHash)
  const missing = routeFor(null), first = createPoolApi(missing.route)
  assert.equal((await first.checkPendingPayment(txHash)).status, 'pending')
  await assert.rejects(first.depositNotes(1), /Check the existing pending deposit/)
  assert.equal((await listStoredNotes())[0].status, 'pending-deposit')
  assert.deepEqual(missing.methods, ['eth_chainId', 'eth_getTransactionReceipt'])
  const goodReceipt: PaymentReceipt = { transactionHash: txHash, blockHash, blockNumber: '0x7', status: '0x1', from: sender, to: config.pool,
    logs: [{ address: config.pool, topics: encodeEventTopics({ abi: [depositEvent], args: { commitment: note.commitment } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [0, 1n]) }] }
  const wrong = createPoolApi(routeFor({ ...goodReceipt, from: other }).route)
  await assert.rejects(wrong.checkPendingPayment(txHash), /sender does not match/)
  assert.equal((await listStoredNotes())[0].status, 'pending-deposit')
  const disconnected = createPoolApi(routeFor(goodReceipt, { down: true }).route)
  await assert.rejects(disconnected.checkPendingPayment(txHash), /Private route disconnected/)
  assert.equal((await listStoredNotes())[0].status, 'pending-deposit')
  const valid = routeFor(goodReceipt), checked = await createPoolApi(valid.route).checkPendingPayment(txHash)
  assert.equal(checked.status, 'verified')
  assert.equal(checked.blockNumber, 7n)
  assert.equal((await listStoredNotes())[0].status, 'unspent')
  assert.equal((await listStoredNotes())[0].pending, undefined)
  assert.equal(valid.methods.includes('eth_sendRawTransaction'), false)
})

test('claim remains reserved until exact payout, spent state and stable block verify', async () => {
  const note = createNote(config.pool, config.chainId)
  const fee = 2_860_000_000_000_000n, amount = NOTE_VALUE - fee
  const nullifierHash = toHex(hash(note.nullifier), { size: 32 })
  const intent: ClaimIntent = { operation: 'claim', txHash, chainId: config.chainId, pool: config.pool, sender, recipient, nullifierHash, feeWei: String(fee), amountWei: String(amount) }
  await saveStoredNotes([{ note, status: 'spending', txHash, pending: intent }])
  const claimLog = { address: config.pool, topics: encodeEventTopics({ abi: [claimEvent], args: { recipient, nullifierHash } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [fee]) }
  const payoutLog = { address: NATIVE_TRANSFER_ADDRESS, topics: encodeEventTopics({ abi: [nativeTransferEvent], args: { from: config.pool, to: recipient } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]) }
  const receipt: PaymentReceipt = { transactionHash: txHash, blockHash, blockNumber: '0x8', status: '0x1', type: '0x6', from: sender, to: config.pool, payer: config.pool,
    frameReceipts: [{ status: '0x1' }, { status: '0x1' }, { status: '0x1' }], logs: [claimLog, payoutLog] }
  await assert.rejects(createPoolApi(routeFor({ ...receipt, logs: [claimLog] }).route).checkPendingPayment(txHash), /payout is not verified/)
  assert.equal((await listStoredNotes())[0].status, 'spending')
  await assert.rejects(createPoolApi(routeFor(receipt, { spent: false }).route).checkPendingPayment(txHash), /nullifier is not spent/)
  assert.equal((await listStoredNotes())[0].status, 'spending')
  const valid = routeFor(receipt), result = await createPoolApi(valid.route).checkPendingPayment(txHash)
  assert.equal(result.status, 'verified')
  assert.equal((await listStoredNotes())[0].status, 'spent')
  assert.equal(valid.methods.includes('eth_sendFrameTransaction'), false)
})

test('ordinary reconciliation cannot release an exact pending intent but updates other notes', async () => {
  const pending = createNote(config.pool, config.chainId), ordinary = createNote(config.pool, config.chainId)
  const intent: DepositIntent = { operation: 'deposit', txHash, chainId: config.chainId, pool: config.pool, sender, commitment: pending.commitment, nonce: 0, amountWei: String(NOTE_VALUE) }
  await saveStoredNotes([{ note: pending, status: 'pending-deposit', txHash, pending: intent }, { note: ordinary, status: 'pending-deposit' }])
  const depositTopic = keccak256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)'))
  const makeLog = (commitment: Hex, index: number) => ({ address: config.pool,
    topics: encodeEventTopics({ abi: [depositEvent], args: { commitment } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [index, 1n]) })
  const logs = [makeLog(pending.commitment, 0), makeLog(ordinary.commitment, 1)]
  await reconcileNotes(async (_url, body) => {
    const request = body as { id: number; method: string; params: [{ topics: Hex[] }] }
    assert.equal(request.method, 'eth_getLogs')
    return { jsonrpc: '2.0', id: request.id, result: request.params[0].topics[0] === depositTopic ? logs : [] }
  })
  const records = await listStoredNotes()
  assert.equal(records[0].status, 'pending-deposit')
  assert.equal(records[0].pending?.txHash, txHash)
  assert.equal(records[1].status, 'unspent')
})
