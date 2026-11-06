import { decodeEventLog, keccak256, parseAbiItem, type Hex } from 'viem'

export const NOTE_VALUE = 100_000_000_000_000_000n
type BaseIntent = { txHash: Hex; chainId: number; pool: Hex; sender: Hex; amountWei: string }
export type DepositIntent = BaseIntent & { operation: 'deposit'; commitment: Hex; nonce: number }
export type ClaimIntent = BaseIntent & { operation: 'claim'; recipient: Hex; nullifierHash: Hex; feeWei: string }
export type PreparedPayment = DepositIntent | ClaimIntent
export type PaymentLog = { address: Hex; topics: Hex[]; data: Hex; removed?: boolean }
export type PaymentReceipt = {
  transactionHash: Hex; blockHash: Hex; blockNumber: Hex; status: Hex; from: Hex; to: Hex | null;
  type?: Hex; payer?: Hex; frameReceipts?: { status: Hex }[]; logs: PaymentLog[];
}
export const claimEvent = parseAbiItem('event Claim(address indexed recipient, bytes32 indexed nullifierHash, uint256 fee)')
export const depositEvent = parseAbiItem('event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)')
const same = (left: unknown, right: string) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase()
export function assertReturnedHash(returned: unknown, expected: Hex): asserts returned is Hex {
  if (!same(returned, expected) || !/^0x[\da-f]{64}$/i.test(String(returned))) throw new Error(`Submission returned a different hash. Check ${expected} before another operation.`)
}
export function receiptBlock(receipt: PaymentReceipt, intent: PreparedPayment): bigint {
  assertReturnedHash(receipt.transactionHash, intent.txHash)
  if (receipt.status !== '0x1') throw new Error(`Transaction did not succeed: ${intent.txHash}`)
  if (!/^0x[\da-f]{64}$/i.test(receipt.blockHash) || !/^0x[\da-f]+$/i.test(receipt.blockNumber) || BigInt(receipt.blockNumber) === 0n) throw new Error('Receipt has no confirmed block identity')
  if (!same(receipt.from, intent.sender)) throw new Error('Receipt sender does not match the prepared payment')
  return BigInt(receipt.blockNumber)
}
export function verifyDepositReceipt(receipt: PaymentReceipt, intent: DepositIntent): { blockNumber: bigint; leafIndex: number } {
  const blockNumber = receiptBlock(receipt, intent)
  if (!same(receipt.to, intent.pool)) throw new Error('Deposit receipt targets a different pool')
  const logs = receipt.logs.filter(log => same(log.address, intent.pool) && same(log.topics[0], keccak256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)'))))
  if (logs.length !== 1 || logs[0].removed) throw new Error('Matching deposit event is missing or ambiguous')
  const event = decodeEventLog({ abi: [depositEvent], data: logs[0].data, topics: logs[0].topics as [Hex, ...Hex[]] })
  if (!same(event.args.commitment, intent.commitment)) throw new Error('Deposit event belongs to another note')
  const leafIndex = Number(event.args.leafIndex)
  if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= 65536) throw new Error('Deposit leaf index is invalid')
  return { blockNumber, leafIndex }
}
export function verifyClaimReceipt(receipt: PaymentReceipt, intent: ClaimIntent): { blockNumber: bigint; amountWei: bigint } {
  const blockNumber = receiptBlock(receipt, intent)
  if (receipt.type !== '0x6' || !same(receipt.payer, intent.pool)) throw new Error('Claim receipt does not identify the pool as frame gas payer')
  if (receipt.frameReceipts?.length !== 3 || receipt.frameReceipts.some(frame => frame.status !== '0x1')) throw new Error('All three claim frames must succeed')
  const logs = receipt.logs.filter(log => same(log.address, intent.pool) && same(log.topics[0], keccak256(new TextEncoder().encode('Claim(address,bytes32,uint256)'))))
  if (logs.length !== 1 || logs[0].removed) throw new Error('Matching claim event is missing or ambiguous')
  const event = decodeEventLog({ abi: [claimEvent], data: logs[0].data, topics: logs[0].topics as [Hex, ...Hex[]] })
  if (!same(event.args.recipient, intent.recipient) || !same(event.args.nullifierHash, intent.nullifierHash) || event.args.fee !== BigInt(intent.feeWei)) throw new Error('Claim event does not match the prepared recipient, note and fee')
  const amountWei = NOTE_VALUE - event.args.fee
  if (amountWei <= 0n || amountWei !== BigInt(intent.amountWei)) throw new Error('Claim amount does not match the prepared payment')
  return { blockNumber, amountWei }
}
// Ethrex emits EIP-7708 ETH transfers from the protocol system address, not the pool.
// Source: crates/vm/levm/src/utils.rs::create_eth_transfer_log in the workshop ethrex.
export const NATIVE_TRANSFER_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe' as Hex
export const nativeTransferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
export function verifyNativePayout(receipt: PaymentReceipt, intent: ClaimIntent, amount: bigint): void {
  const topic = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))
  const transfers = receipt.logs.filter(log => same(log.address, NATIVE_TRANSFER_ADDRESS) && same(log.topics[0], topic))
  const matches = transfers.filter(log => {
    if (log.removed) return false
    try {
      const event = decodeEventLog({ abi: [nativeTransferEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true })
      return same(event.args.from, intent.pool) && same(event.args.to, intent.recipient) && event.args.value === amount
    } catch { return false }
  })
  if (matches.length !== 1) throw new Error('Exact native ETH payout is not verified by the protocol transfer log; check the existing transaction')
}
export function verifyRecipientDelta(before: bigint, after: bigint, expected: bigint, spent: boolean): void {
  if (!spent || before < 0n || after - before !== expected) throw new Error('Claim is included but its exact recipient payout is not verified; check the existing transaction')
}
/** Callback completion is the durable-intent barrier, not a fire-and-forget UI event. */
export async function broadcastPrepared<T>(intent: PreparedPayment, prepare: ((intent: PreparedPayment) => Promise<void>) | undefined, send: () => Promise<T>): Promise<T> {
  await prepare?.(intent)
  return send()
}
type CanonicalSimulation = { canonicalMempoolValid?: boolean; canonicalMempoolViolation?: string | null; executionStatus?: string | null; frames?: { succeeded: boolean }[] | null }
export function isCanonicalPolicyRejection(error: unknown, simulation: CanonicalSimulation): boolean {
  if (simulation.executionStatus !== 'success' || simulation.frames?.length !== 3 || simulation.frames.some(frame => !frame.succeeded) || simulation.canonicalMempoolValid !== false) return false
  const reason = String(error), violation = simulation.canonicalMempoolViolation ?? ''
  if (!/eth_sendRawTransaction: -\d+\b/.test(reason)) return false
  return /MAX_VERIFY_GAS|prefix gas budget/i.test(violation) && /MAX_VERIFY_GAS|prefix gas budget/i.test(reason)
    || /StorageReadNonSender/.test(violation) && /StorageReadNonSender/.test(reason)
    || /StorageWriteNonSender/.test(violation) && /StorageWriteNonSender/.test(reason)
}
