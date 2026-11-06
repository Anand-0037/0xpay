import { JsonRpcProvider, getAddress, keccak256, Transaction, type HDNodeWallet, type TransactionRequest } from 'ethers'
import { APP_RPC_URL } from '../rpc.ts'
import { assertPrivateRouteReady } from '../rpc/ethers-transport.ts'
import { unlockedFundingWallet, assertUnlockedSession, storedVault } from './lifecycle.ts'
import { recordSignedTransaction, signedTransactionForRecovery, markTransaction, unresolvedFundingTransaction, type TransactionKind } from '../domain/tx-journal.ts'

let submissionActive = false

function beginSubmission() {
  if (submissionActive) throw new Error('A funding transaction is already being prepared or submitted. Wait for its result.')
  submissionActive = true
}

async function withFundingLock<T>(address: string, action: () => Promise<T>): Promise<T> {
  beginSubmission()
  try {
    // Web Locks coordinate same-origin tabs; the in-memory gate also covers browsers without it.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(`0xpay.funding.${address.toLowerCase()}`, { ifAvailable: true }, (lock) => {
        if (!lock) throw new Error('This funding wallet is busy in another tab. Wait for that transaction.')
        return action()
      })
    }
    return await action()
  } finally { submissionActive = false }
}

/** All payment signing uses the encrypted wallet on this device. */
export async function getFundingSigner() {
  assertPrivateRouteReady()
  return unlockedFundingWallet()
}

/** Sign on device, then send only the signed transaction through the pinned private transport. */
export async function broadcastLocalTransaction(wallet: HDNodeWallet, transaction: TransactionRequest,
  assertCurrent: () => void, persistBeforeBroadcast: (hash: string, signedTransaction: string, nonce: number) => void) {
  if (transaction.chainId != null && BigInt(transaction.chainId) !== 11155111n) throw new Error('Only Ethereum Sepolia is supported')
  assertPrivateRouteReady()
  assertCurrent()
  return withFundingLock(wallet.address, async () => {
    const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
    try {
      const connected = wallet.connect(provider)
      const populated = await connected.populateTransaction({ ...transaction, chainId: 11155111 })
      assertCurrent()
      assertPrivateRouteReady()
      const signed = await wallet.signTransaction(populated)
      assertCurrent()
      assertPrivateRouteReady()
      const hash = keccak256(signed)
      // Saving the deterministic hash before the first broadcast makes a reload recoverable.
      // Storage failure aborts before any transaction bytes leave this device.
      persistBeforeBroadcast(hash, signed, populated.nonce!)
      try {
        await provider.broadcastTransaction(signed)
        return { hash, broadcastUnknown: false }
      } catch {
        // A mixnet timeout can lose the response after the node accepted the bytes.
        // Retain the deterministic hash and reconcile instead of signing a new payment.
        return { hash, broadcastUnknown: true }
      }
    } finally { provider.destroy() }
  })
}

export async function sendFundingTransaction(transaction: TransactionRequest, expectedAddress: string, walletId: string,
  kind: TransactionKind, sessionVersion: number) {
  const signer = await getFundingSigner()
  if (getAddress(await signer.getAddress()) !== expectedAddress) throw new Error('Funding wallet changed. Review again.')
  const assertCurrent = () => {
    assertUnlockedSession(walletId, sessionVersion)
    const vault = storedVault()
    if (vault?.walletId !== walletId || vault.backupConfirmed !== true) throw new Error('Confirm your recovery phrase backup before sending funds.')
    if (unlockedFundingWallet().address !== expectedAddress) throw new Error('Funding wallet changed. Review again.')
  }
  assertCurrent()
  assertPrivateRouteReady()
  if (unresolvedFundingTransaction(expectedAddress)) throw new Error('A funding transaction is unresolved. Check its result before starting another payment.')
  const outcome = await broadcastLocalTransaction(unlockedFundingWallet(), transaction, assertCurrent, (_hash, signed) => {
    if (unresolvedFundingTransaction(expectedAddress)) throw new Error('A funding transaction is unresolved. Check its result before starting another payment.')
    recordSignedTransaction(kind, signed, expectedAddress)
  })
  if (outcome.broadcastUnknown) {
    try { markTransaction(outcome.hash, 'unknown') } catch { /* the submitted write-ahead record still blocks duplicates */ }
  }
  return outcome
}

/** Retry exactly the saved signed bytes; never create a new payment or choose a new nonce. */
export async function rebroadcastFundingTransaction(hash: string, walletId: string, sessionVersion: number) {
  const from = unlockedFundingWallet().address
  const initial = signedTransactionForRecovery(hash, from)
  const assertCurrent = () => {
    assertUnlockedSession(walletId, sessionVersion)
    const vault = storedVault()
    if (vault?.walletId !== walletId || vault.backupConfirmed !== true) throw new Error('Confirm your recovery phrase backup before sending funds.')
    if (unlockedFundingWallet().address !== from) throw new Error('Funding wallet changed before retrying this transaction')
    assertPrivateRouteReady()
    const current = signedTransactionForRecovery(hash, from)
    if (current.signedTransaction !== initial.signedTransaction) throw new Error('Saved transaction changed; reload before continuing')
  }
  assertCurrent()
  return withFundingLock(from, async () => {
    assertCurrent()
    const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
    try {
      const receipt = await provider.getTransactionReceipt(hash)
      assertCurrent()
      if (receipt) {
        const signed = Transaction.from(initial.signedTransaction)
        if (receipt.hash.toLowerCase() !== hash.toLowerCase() ||
          receipt.from.toLowerCase() !== from.toLowerCase() || receipt.to?.toLowerCase() !== signed.to?.toLowerCase() ||
          (receipt.status !== 0 && receipt.status !== 1)) throw new Error('Receipt does not match this saved transaction')
        const receiptStatus = receipt.status === 1 ? 'confirmed' : 'reverted'
        markTransaction(hash, receiptStatus)
        return { hash, broadcastUnknown: false, receiptStatus }
      }
      try {
        await provider.broadcastTransaction(initial.signedTransaction)
        return { hash, broadcastUnknown: false }
      } catch {
        try { markTransaction(hash, 'unknown') } catch { /* existing durable record still prevents duplicate intent */ }
        return { hash, broadcastUnknown: true }
      }
    } finally { provider.destroy() }
  })
}
