/** Offchain signing and synthetic RPC fixtures; no network or funded wallet. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { claimEvent, depositEvent, nativeTransferEvent, NATIVE_TRANSFER_ADDRESS, NOTE_VALUE, type ClaimIntent, type DepositIntent, type PaymentReceipt, type PreparedPayment } from '../src/pool/payment-records.ts'
import { config, confirmClaimPayment, createNote, deposit, type RpcTransport } from '../src/pool/index.ts'
import { createPoolApi } from '../src/pool/api.ts'
import { listStoredNotes } from '../src/pool/notes.ts'
import { createLocalWallet, lockLocalWallet } from '../src/wallet/lifecycle.ts'
import type { PrivateRpc } from '../src/rpc.ts'

const recipient = `0x${'3'.repeat(40)}` as Hex, sender = `0x${'1'.repeat(40)}` as Hex
const reviewedPoolCode = readFileSync(new URL('./fixtures/pool-runtime.hex', import.meta.url), 'utf8').trim() as Hex
assert.equal(keccak256(reviewedPoolCode), config.poolCodeHash)
const transactionHash = `0x${'a'.repeat(64)}` as Hex, blockHash = `0x${'b'.repeat(64)}` as Hex
test('deposit signs and saves its exact hash before its first synthetic broadcast', async () => {
  const note = createNote(config.pool, config.chainId)
  let prepared: DepositIntent | undefined
  const order: string[] = []
  const transport: RpcTransport = async (_url, body) => {
    const request = body as { id: number; method: string; params: Hex[] }
    let result: unknown
    if (request.method === 'eth_getTransactionCount') result = '0x0'
    else if (request.method === 'eth_sendRawTransaction') {
      order.push('broadcast')
      assert.ok(prepared)
      assert.equal(keccak256(request.params[0]), prepared.txHash)
      result = prepared.txHash
    } else if (request.method === 'eth_getTransactionReceipt') {
      assert.ok(prepared)
      result = { transactionHash: prepared.txHash, blockHash, blockNumber: '0x88', status: '0x1', from: prepared.sender, to: note.pool, logs: [{ address: note.pool,
        topics: encodeEventTopics({ abi: [depositEvent], args: { commitment: note.commitment } }), data: encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [3, 123n]),
      }] }
    } else throw new Error(`Unexpected fixture request: ${request.method}`)
    return { jsonrpc: '2.0', id: request.id, result }
  }
  const result = await deposit(note, { privateKey: generatePrivateKey(), transport, onPrepared: async (intent: PreparedPayment) => {
    assert.equal(intent.operation, 'deposit')
    prepared = intent as DepositIntent
    assert.equal(JSON.stringify(intent).includes(note.secret.toString()), false)
    order.push('saved')
  } })
  assert.deepEqual(order, ['saved', 'broadcast'])
  assert.equal(result.txHash, prepared!.txHash)
  assert.equal(result.leafIndex, 3)
})

const fee = 2_860_000_000_000_000n, amount = NOTE_VALUE - fee
const intent: ClaimIntent = { operation: 'claim', txHash: transactionHash, chainId: config.chainId, pool: config.pool, sender, recipient, nullifierHash: `0x${'c'.repeat(64)}`, feeWei: String(fee), amountWei: String(amount) }
const receipt: PaymentReceipt = { transactionHash, blockHash, blockNumber: '0x89', status: '0x1', type: '0x6', from: sender, to: config.pool, payer: config.pool,
  frameReceipts: Array.from({ length: 3 }, () => ({ status: '0x1' })), logs: [{ address: config.pool, topics: encodeEventTopics({ abi: [claimEvent], args: { recipient, nullifierHash: intent.nullifierHash } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [fee]) }, { address: NATIVE_TRANSFER_ADDRESS, topics: encodeEventTopics({ abi: [nativeTransferEvent], args: { from: config.pool, to: recipient } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [amount]) }] }
function fixture(options: { extraBalance?: bigint; changedHeader?: boolean } = {}) {
  const calls: { method: string; params: unknown[] }[] = []
  let headerReads = 0
  const transport: RpcTransport = async (_url, body) => {
    const request = body as { id: number; method: string; params: unknown[] }
    calls.push(request)
    let result: unknown
    if (request.method === 'eth_chainId') result = toHex(config.chainId)
    else if (request.method === 'eth_getBlockByNumber') result = { hash: ++headerReads === 2 && options.changedHeader ? `0x${'d'.repeat(64)}` : blockHash }
    else if (request.method === 'eth_getBalance') result = toHex(request.params[1] === '0x88' ? 7n : 7n + amount + (options.extraBalance ?? 0n))
    else if (request.method === 'eth_call') result = encodeAbiParameters([{ type: 'bool' }], [true])
    else throw new Error(`Unexpected fixture request: ${request.method}`)
    return { jsonrpc: '2.0', id: request.id, result }
  }
  return { transport, calls }
}
test('claim completion checks exact protocol payout, spent flag and stable receipt block without historical balance support', async () => {
  const source = fixture()
  const result = await confirmClaimPayment(receipt, intent, source.transport)
  assert.equal(result.amountWei, amount)
  assert.equal(result.recipientBalance, 7n + amount)
  assert.deepEqual(source.calls.filter(call => call.method === 'eth_getBalance').map(call => call.params[1]), ['latest'])
  assert.equal(result.payoutEvidence, 'eip-7708-transfer')
  assert.deepEqual(source.calls.find(call => call.method === 'eth_call')?.params[1], 'latest')
  assert.equal(source.calls.filter(call => call.method === 'eth_getBlockByNumber').length, 2)
})
test('unrelated balance changes do not substitute for payout evidence, and a changed receipt block prevents completion', async () => {
  const extra = await confirmClaimPayment(receipt, intent, fixture({ extraBalance: 1n }).transport)
  assert.equal(extra.amountWei, amount)
  await assert.rejects(confirmClaimPayment({ ...receipt, logs: receipt.logs.slice(0, 1) }, intent, fixture({ extraBalance: amount }).transport), /payout is not verified/)
  await assert.rejects(confirmClaimPayment(receipt, intent, fixture({ changedHeader: true }).transport), /block changed/)
})

test('API keeps the encrypted prepared deposit hash when its submission response is lost', async () => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  }, configurable: true })
  await createLocalWallet('disposable test password', 0)
  let submittedHash: Hex | undefined
  let submissions = 0
  const route = { fetchRpc: async (body: string) => {
    const request = JSON.parse(body) as { id: number; method: string; params: Hex[] }
    if (request.method === 'eth_getCode') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: reviewedPoolCode }))
    if (request.method === 'eth_getTransactionCount') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x0' }))
    if (request.method === 'eth_sendRawTransaction') {
      submissions++
      submittedHash = keccak256(request.params[0])
      const [stored] = await listStoredNotes()
      assert.equal(stored.txHash, submittedHash)
      assert.equal(stored.pending?.txHash, submittedHash)
      throw new Error('Private RPC read timed out')
    }
    throw new Error(`Unexpected fixture request: ${request.method}`)
  } } as unknown as PrivateRpc
  try {
    await assert.rejects(createPoolApi(route).depositNotes(1), /timed out/)
    const [stored] = await listStoredNotes()
    assert.equal(submissions, 1)
    assert.equal(stored.status, 'pending-deposit')
    assert.equal(stored.txHash, submittedHash)
    assert.equal(stored.pending?.operation, 'deposit')
    assert.equal('privateKey' in stored.pending!, false)
    assert.equal(JSON.stringify(stored.pending).includes(stored.note.secret.toString()), false)
    assert.equal([...storage.values()].some(value => value.includes(stored.note.secret.toString())), false)
  } finally { await lockLocalWallet() }
})


test('pre-signing deposit failure removes its orphan note and never broadcasts', async () => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  }, configurable: true })
  await createLocalWallet('disposable test password', 0)
  let broadcasts = 0
  const route = { fetchRpc: async (body: string) => {
    const request = JSON.parse(body) as { id: number; method: string }
    if (request.method === 'eth_getCode') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: reviewedPoolCode }))
    if (request.method === 'eth_getTransactionCount') throw new Error('Private route failed before signing')
    if (request.method === 'eth_sendRawTransaction') broadcasts++
    throw new Error(`Unexpected fixture request: ${request.method}`)
  } } as unknown as PrivateRpc
  try {
    await assert.rejects(createPoolApi(route).depositNotes(1), /failed before signing/)
    assert.equal(broadcasts, 0)
    assert.deepEqual(await listStoredNotes(), [])
  } finally { await lockLocalWallet() }
})


for (const [scenario, code, message] of [
  ['missing pool', '0x', /Pool contract is unavailable/],
  ['different pool code', '0x6000', /Pool contract code differs/],
] as const) test(`${scenario} blocks value-bearing deposit before a note or transaction exists`, async () => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  }, configurable: true })
  await createLocalWallet('disposable test password', 0)
  const methods: string[] = []
  const route = { fetchRpc: async (body: string) => {
    const request = JSON.parse(body) as { id: number; method: string }
    methods.push(request.method)
    if (request.method !== 'eth_getCode') throw new Error(`Unexpected request ${request.method}`)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: code }))
  } } as unknown as PrivateRpc
  try {
    await assert.rejects(createPoolApi(route).depositNotes(1), message)
    assert.deepEqual(methods, ['eth_getCode'])
    assert.deepEqual(await listStoredNotes(), [])
  } finally { await lockLocalWallet() }
})
