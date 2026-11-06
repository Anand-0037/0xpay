/** Synthetic receipt fixtures only. These tests do not submit transactions. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { assertReturnedHash, broadcastPrepared, claimEvent, depositEvent, isCanonicalPolicyRejection, NOTE_VALUE,
  verifyClaimReceipt, verifyDepositReceipt, verifyRecipientDelta, verifyNativePayout, nativeTransferEvent, NATIVE_TRANSFER_ADDRESS, type ClaimIntent, type DepositIntent, type PaymentReceipt } from '../src/pool/payment-records.ts'

const address = (byte: string) => `0x${byte.repeat(40)}` as Hex
const digest = (byte: string) => `0x${byte.repeat(64)}` as Hex
const fee = 2_860_000_000_000_000n
const intent: ClaimIntent = { operation: 'claim', txHash: digest('a'), chainId: 1337, pool: address('2'), sender: address('1'), recipient: address('3'), nullifierHash: digest('c'), feeWei: String(fee), amountWei: String(NOTE_VALUE - fee) }
function claimReceipt(): PaymentReceipt {
  return { transactionHash: intent.txHash, blockHash: digest('b'), blockNumber: '0x89', status: '0x1', from: intent.sender, to: intent.pool,
    type: '0x6', payer: intent.pool, frameReceipts: Array.from({ length: 3 }, () => ({ status: '0x1' as Hex })), logs: [{
      address: intent.pool, data: encodeAbiParameters([{ type: 'uint256' }], [fee]),
      topics: encodeEventTopics({ abi: [claimEvent], args: { recipient: intent.recipient, nullifierHash: intent.nullifierHash } }) as Hex[],
    }] }
}
test('a matching synthetic receipt needs all three frames and the exact Claim event', () => {
  assert.deepEqual(verifyClaimReceipt(claimReceipt(), intent), { blockNumber: 137n, amountWei: NOTE_VALUE - fee })
  verifyRecipientDelta(0n, NOTE_VALUE - fee, NOTE_VALUE - fee, true)
})
test('inclusion alone does not complete a payment with missing/failed frames or wrong payer', () => {
  for (const change of [
    (receipt: PaymentReceipt) => { receipt.frameReceipts = undefined },
    (receipt: PaymentReceipt) => { receipt.frameReceipts = [{ status: '0x1' }] },
    (receipt: PaymentReceipt) => { receipt.frameReceipts![2].status = '0x0' },
    (receipt: PaymentReceipt) => { receipt.payer = intent.sender },
    (receipt: PaymentReceipt) => { receipt.transactionHash = digest('d') },
    (receipt: PaymentReceipt) => { receipt.status = '0x0' },
  ]) {
    const receipt = claimReceipt(); change(receipt)
    assert.throws(() => verifyClaimReceipt(receipt, intent))
  }
})
test('synthetic receipts for another recipient, nullifier, fee or event source do not complete this payment', () => {
  for (const change of [
    (receipt: PaymentReceipt) => { receipt.logs[0].address = address('4') },
    (receipt: PaymentReceipt) => { receipt.logs[0].topics[1] = `0x${'0'.repeat(24)}${address('4').slice(2)}` },
    (receipt: PaymentReceipt) => { receipt.logs[0].topics[2] = digest('d') },
    (receipt: PaymentReceipt) => { receipt.logs[0].data = encodeAbiParameters([{ type: 'uint256' }], [fee + 1n]) },
    (receipt: PaymentReceipt) => { receipt.logs.push(receipt.logs[0]) },
    (receipt: PaymentReceipt) => { receipt.logs[0].removed = true },
  ]) {
    const receipt = claimReceipt(); change(receipt)
    assert.throws(() => verifyClaimReceipt(receipt, intent))
  }
  assert.throws(() => verifyRecipientDelta(0n, NOTE_VALUE - fee - 1n, NOTE_VALUE - fee, true))
  assert.throws(() => verifyRecipientDelta(0n, NOTE_VALUE - fee, NOTE_VALUE - fee, false))
})
test('ordinary deposits use their own pool/commitment receipt rather than frame-claim rules', () => {
  const deposit: DepositIntent = { operation: 'deposit', txHash: digest('e'), chainId: 1337, pool: intent.pool, sender: intent.sender, commitment: digest('f'), nonce: 0, amountWei: String(NOTE_VALUE) }
  const receipt: PaymentReceipt = { transactionHash: deposit.txHash, blockHash: digest('b'), blockNumber: '0x88', status: '0x1', type: '0x0', from: deposit.sender, to: deposit.pool,
    logs: [{ address: deposit.pool, topics: encodeEventTopics({ abi: [depositEvent], args: { commitment: deposit.commitment } }) as Hex[], data: encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [3, 123n]) }] }
  assert.deepEqual(verifyDepositReceipt(receipt, deposit), { blockNumber: 136n, leafIndex: 3 })
  receipt.logs[0].topics[1] = digest('a')
  assert.throws(() => verifyDepositReceipt(receipt, deposit), /another note/)
})
test('broadcast waits for the durable public-intent callback and never runs after storage failure', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const result = broadcastPrepared(intent, async prepared => {
    assert.equal(prepared.txHash, intent.txHash)
    assert.equal('privateKey' in prepared, false)
    assert.equal('secret' in prepared, false)
    order.push('saving'); await pending; order.push('saved')
  }, async () => { order.push('broadcast'); return intent.txHash })
  await Promise.resolve()
  assert.deepEqual(order, ['saving'])
  release()
  assert.equal(await result, intent.txHash)
  assert.deepEqual(order, ['saving', 'saved', 'broadcast'])
  let sent = false
  await assert.rejects(broadcastPrepared(intent, async () => { throw new Error('Storage unavailable') }, async () => { sent = true }), /Storage unavailable/)
  assert.equal(sent, false)
})
test('only a documented native policy rejection after successful preflight gets the policy label', () => {
  const simulation = { executionStatus: 'success', frames: Array.from({ length: 3 }, () => ({ succeeded: true })), canonicalMempoolValid: false, canonicalMempoolViolation: 'prefix gas budget exceeded: 632800 > 100000 (MAX_VERIFY_GAS)' }
  assert.equal(isCanonicalPolicyRejection(new Error('eth_sendRawTransaction: -32000 exceeds MAX_VERIFY_GAS'), simulation), true)
  for (const error of [new Error('Private RPC read timed out'), new Error('eth_sendRawTransaction: -32000 nonce too low'), new Error('HTTP 502')]) assert.equal(isCanonicalPolicyRejection(error, simulation), false)
  assert.equal(isCanonicalPolicyRejection(new Error('eth_sendRawTransaction: -32000 exceeds MAX_VERIFY_GAS'), { ...simulation, executionStatus: 'reverted' }), false)
  assert.equal(isCanonicalPolicyRejection(new Error('eth_sendRawTransaction: -32000 exceeds MAX_VERIFY_GAS'), { ...simulation, canonicalMempoolValid: true }), false)
  assert.throws(() => assertReturnedHash(digest('d'), intent.txHash), /different hash/)
})

test('only the system native-transfer log for this pool, recipient and exact amount proves the payout', () => {
  const receipt = claimReceipt()
  const transfer = { address: NATIVE_TRANSFER_ADDRESS, topics: encodeEventTopics({ abi: [nativeTransferEvent], args: { from: intent.pool, to: intent.recipient } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [NOTE_VALUE - fee]) }
  receipt.logs.push(transfer)
  verifyNativePayout(receipt, intent, NOTE_VALUE - fee)
  for (const change of [
    (log: typeof transfer) => { log.address = intent.pool },
    (log: typeof transfer) => { log.topics[1] = digest('f') },
    (log: typeof transfer) => { log.topics[2] = digest('d') },
    (log: typeof transfer) => { log.data = encodeAbiParameters([{ type: 'uint256' }], [NOTE_VALUE - fee + 1n]) },
  ]) {
    const bad = { ...transfer, topics: [...transfer.topics] }; change(bad)
    assert.throws(() => verifyNativePayout({ ...receipt, logs: [receipt.logs[0], bad] }, intent, NOTE_VALUE - fee))
  }
  assert.throws(() => verifyNativePayout({ ...receipt, logs: [...receipt.logs, transfer] }, intent, NOTE_VALUE - fee))
})
