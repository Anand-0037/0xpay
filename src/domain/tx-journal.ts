import { Interface, Transaction, ZeroAddress, ZeroHash, getAddress } from 'ethers'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'

export type TransactionKind = 'shield' | 'send'
export type TransactionStatus = 'submitted' | 'unknown' | 'confirmed' | 'reverted'
export type TransactionRecord = Readonly<{
  kind: TransactionKind
  hash: string
  from: string
  status: TransactionStatus
  createdAt: number
  signedTransaction?: string
  nonce?: number
}>

const STORAGE_KEY = '0xpay.transactions.v1'
const HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const KINDS = new Set<TransactionKind>(['shield', 'send'])
const STATUSES = new Set<TransactionStatus>(['submitted', 'unknown', 'confirmed', 'reverted'])

// Exact function fragments from @railgun-community/engine 9.9.1's exported
// ABIRelayAdapt (abi/V2/RelayAdapt.json) and ABIRailgunSmartWallet (abi/V2.1/RailgunSmartWallet.json).
// RelayAdaptV2Contract.populateShieldBaseToken emits wrapBase -> shield via requireSuccess multicall.
// RailgunSmartWalletV2Contract.generateTransact emits direct transact for a private transfer.
// Keep fragments minimal so reading the journal does not eagerly load the entire prover engine.
const relay = new Interface([
  'function multicall(bool _requireSuccess, (address to, bytes data, uint256 value)[] _calls) payable',
  'function wrapBase(uint256 _amount)',
  'function shield(((bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, (bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests)',
])
const smartWallet = new Interface([
  'function transact((((uint256 x, uint256 y) a, (uint256[2] x, uint256[2] y) b, (uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, (uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, (bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, (bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage)[] _transactions) payable',
])
const sepolia = NETWORK_CONFIG[NetworkName.EthereumSepolia]

function decodeCanonical(abi: Interface, name: string, data: string) {
  const decoded = abi.decodeFunctionData(name, data)
  if (abi.encodeFunctionData(name, decoded).toLowerCase() !== data.toLowerCase()) throw new Error('Noncanonical payment calldata')
  return decoded
}

/** Structural operation checks only; this does not independently verify ZK proofs or encrypted recipients. */
function assertPaymentOperation(kind: TransactionKind, transaction: Transaction) {
  try {
    if (kind === 'shield') {
      if (transaction.to !== getAddress(sepolia.relayAdaptContract) || transaction.value <= 0n) throw new Error('Wrong shield target or value')
      const [requireSuccess, calls] = decodeCanonical(relay, 'multicall', transaction.data)
      if (requireSuccess !== true || calls.length !== 2 || calls.some((call: { to: string; value: bigint }) =>
        getAddress(call.to) !== getAddress(sepolia.relayAdaptContract) || call.value !== 0n)) throw new Error('Unexpected shield calls')
      const [amount] = decodeCanonical(relay, 'wrapBase', calls[0].data)
      const [shields] = decodeCanonical(relay, 'shield', calls[1].data)
      if (amount !== transaction.value || shields.length !== 1) throw new Error('Shield amount mismatch')
      const preimage = shields[0].preimage
      if (preimage.value !== amount || preimage.token.tokenType !== 0n || preimage.token.tokenSubID !== 0n ||
        getAddress(preimage.token.tokenAddress) !== getAddress(sepolia.baseToken.wrappedAddress)) throw new Error('Unexpected shield asset')
    } else {
      if (transaction.to !== getAddress(sepolia.proxyContract) || transaction.value !== 0n) throw new Error('Wrong private-send target or value')
      const [transactions] = decodeCanonical(smartWallet, 'transact', transaction.data)
      if (!transactions.length) throw new Error('Empty private send')
      for (const item of transactions) {
        if (item.boundParams.chainID !== 11155111n || item.boundParams.unshield !== 0n ||
          item.boundParams.adaptContract !== ZeroAddress || item.boundParams.adaptParams !== ZeroHash ||
          item.unshieldPreimage.value !== 0n || !item.nullifiers.length || !item.commitments.length ||
          item.boundParams.commitmentCiphertext.length !== item.commitments.length) throw new Error('Unexpected private-send operation')
      }
    }
  } catch { throw new Error(`Saved transaction is not a supported Sepolia RAILGUN ${kind} operation`) }
}

function checked(value: unknown): TransactionRecord {
  if (typeof value !== 'object' || value === null ||
      !('kind' in value) || !KINDS.has(value.kind as TransactionKind) ||
      !('hash' in value) || typeof value.hash !== 'string' || !HASH.test(value.hash) ||
      !('from' in value) || typeof value.from !== 'string' || !ADDRESS.test(value.from) ||
      !('status' in value) || !STATUSES.has(value.status as TransactionStatus) ||
      !('createdAt' in value) || typeof value.createdAt !== 'number' ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new Error('Local transaction history is damaged')
  }
  if ('signedTransaction' in value || 'nonce' in value) {
    if (!('signedTransaction' in value) || typeof value.signedTransaction !== 'string' ||
      value.signedTransaction.length > 2_000_000 || !/^0x(?:[0-9a-f]{2})+$/i.test(value.signedTransaction) ||
      !('nonce' in value) || typeof value.nonce !== 'number' || !Number.isSafeInteger(value.nonce) || value.nonce < 0) {
      throw new Error('Saved signed transaction is damaged')
    }
    try {
      const transaction = Transaction.from(value.signedTransaction)
      if (!transaction.isSigned() || transaction.chainId !== 11155111n ||
        transaction.hash?.toLowerCase() !== value.hash.toLowerCase() ||
        transaction.from?.toLowerCase() !== value.from.toLowerCase() || transaction.nonce !== value.nonce) {
        throw new Error('Signed transaction does not match its saved identity')
      }
    } catch { throw new Error('Saved signed transaction is damaged or does not match this Sepolia payment') }
  }
  return value as TransactionRecord
}

export function readTransactions(storage: Pick<Storage, 'getItem'> = localStorage): TransactionRecord[] {
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Local transaction history is damaged') }
  if (!Array.isArray(parsed) || parsed.length > 50) throw new Error('Local transaction history is damaged')
  return parsed.map(checked)
}

export function unresolvedTransaction(kind: TransactionKind, storage: Pick<Storage, 'getItem'> = localStorage) {
  return readTransactions(storage).find((record) =>
    record.kind === kind && (record.status === 'submitted' || record.status === 'unknown'))
}

/** A funding account must reconcile an uncertain nonce before starting another payment. */
export function unresolvedFundingTransaction(from: string, storage: Pick<Storage, 'getItem'> = localStorage) {
  if (!ADDRESS.test(from)) throw new Error('Invalid funding address')
  return readTransactions(storage).find((record) => record.from.toLowerCase() === from.toLowerCase() &&
    (record.status === 'submitted' || record.status === 'unknown'))
}

export function findTransaction(hash: string, storage: Pick<Storage, 'getItem'> = localStorage) {
  if (!HASH.test(hash)) throw new Error('Invalid transaction hash')
  return readTransactions(storage).find((record) => record.hash.toLowerCase() === hash.toLowerCase())
}

export function recordSubmitted(kind: TransactionKind, hash: string, from: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): TransactionRecord {
  const record = checked({ kind, hash, from, status: 'submitted', createdAt: Date.now() })
  const current = readTransactions(storage)
  const existing = current.find((item) => item.hash.toLowerCase() === hash.toLowerCase())
  if (existing) {
    if (existing.kind !== kind || existing.from.toLowerCase() !== from.toLowerCase()) {
      throw new Error('Transaction hash conflicts with local history')
    }
    return existing
  }
  storage.setItem(STORAGE_KEY, JSON.stringify([record, ...current].slice(0, 50)))
  return record
}

/** Signed bytes are public broadcast data. No mnemonic, password or private key is stored here. */
export function recordSignedTransaction(kind: TransactionKind, signedTransaction: string, from: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): TransactionRecord {
  const parsed = Transaction.from(signedTransaction)
  const record = checked({ kind, hash: parsed.hash, from, signedTransaction, nonce: parsed.nonce,
    status: 'submitted', createdAt: Date.now() })
  assertPaymentOperation(kind, parsed)
  const current = readTransactions(storage)
  const index = current.findIndex((item) => item.hash.toLowerCase() === record.hash.toLowerCase())
  if (index >= 0) {
    const prior = current[index]
    if (prior.kind !== kind || prior.from.toLowerCase() !== from.toLowerCase()) throw new Error('Transaction hash conflicts with local history')
    if (prior.status === 'confirmed' || prior.status === 'reverted') throw new Error('Completed transaction cannot be resubmitted')
    current[index] = { ...record, status: prior.status, createdAt: prior.createdAt }
  } else current.unshift(record)
  storage.setItem(STORAGE_KEY, JSON.stringify(current.slice(0, 50)))
  return index >= 0 ? current[index] : record
}

export function signedTransactionForRecovery(hash: string, from: string,
  storage: Pick<Storage, 'getItem'> = localStorage) {
  const record = findTransaction(hash, storage)
  if (!record || record.from.toLowerCase() !== from.toLowerCase()) throw new Error('Saved transaction does not belong to this funding wallet')
  if (record.status === 'confirmed' || record.status === 'reverted') throw new Error('Completed transaction cannot be resubmitted')
  if (!record.signedTransaction || record.nonce === undefined) throw new Error('This transaction has no saved signed bytes; check its receipt instead')
  assertPaymentOperation(record.kind, Transaction.from(record.signedTransaction))
  return record as TransactionRecord & { signedTransaction: string; nonce: number }
}

export function markTransaction(hash: string, status: Exclude<TransactionStatus, 'submitted'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): TransactionRecord {
  if (!HASH.test(hash) || !STATUSES.has(status)) throw new Error('Invalid transaction result')
  const current = readTransactions(storage)
  const index = current.findIndex((record) => record.hash.toLowerCase() === hash.toLowerCase())
  if (index < 0) throw new Error('Transaction is absent from local history')
  const prior = current[index]
  if ((prior.status === 'confirmed' || prior.status === 'reverted') && prior.status !== status) {
    throw new Error('Confirmed transaction result cannot be changed')
  }
  const next = { ...prior, status }
  current[index] = next
  storage.setItem(STORAGE_KEY, JSON.stringify(current))
  return next
}
