import { JsonRpcProvider, getAddress } from 'ethers'
import {
  calculateGasLimit, EVMGasType, NETWORK_CONFIG, NetworkName, TXIDVersion,
  type RailgunERC20AmountRecipient, type TransactionGasDetailsType2,
} from '@railgun-community/shared-models'
import {
  assertValidRailgunAddress, gasEstimateForUnprovenTransfer, generateTransferProof,
  populateProvedTransfer,
} from '@railgun-community/wallet'
import { APP_RPC_URL } from '../rpc'
import { findTransaction, markTransaction, recordSubmitted, unresolvedTransaction } from '../domain/tx-journal'
import { getConnectedInjectedSigner } from '../wallet/injected'
import { unlockedEncryptionKey, unlockedWalletId } from '../wallet/lifecycle'
import { verifiedSpendableWeth } from './balance'

const NETWORK = NetworkName.EthereumSepolia
const REVIEW_LIFETIME_MS = 120_000
const EXPLORER_URL = 'https://sepolia.etherscan.io/tx/'

export type PrivateSendQuote = {
  id: string
  walletId: string
  amountWei: bigint
  recipientAddress: string
  publicGasPayer: string
  spendableWethWei: bigint
  publicGasBalanceWei: bigint
  maxNetworkFeeWei: bigint
  expiresAt: number
}
export type PrivateSendSubmission = { status: 'submitted'; transactionHash: string; explorerUrl: string; journalSaved: boolean }
export type PrivateSendReceipt =
  | { status: 'confirmed' | 'reverted'; transactionHash: string; explorerUrl: string; blockNumber: number }
  | { status: 'unknown'; transactionHash: string; explorerUrl: string; message: string }

type PendingSend = { quote: PrivateSendQuote; gasDetails: TransactionGasDetailsType2 }
let pendingSend: PendingSend | null = null
let submitting = false
const sent = new Map<string, { gasPayer: string }>()

export function discardPrivateSendQuote() { pendingSend = null }

function privateProvider() {
  return new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
}

function checkedFeeData(maxFeePerGas: bigint | null, maxPriorityFeePerGas: bigint | null) {
  if (!maxFeePerGas || !maxPriorityFeePerGas || maxFeePerGas <= 0n ||
    maxPriorityFeePerGas <= 0n || maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error('Sepolia gas prices are unavailable through the private route. Try again.')
  }
  return { maxFeePerGas, maxPriorityFeePerGas }
}

function recipients(amountWei: bigint, recipientAddress: string): RailgunERC20AmountRecipient[] {
  return [{
    tokenAddress: NETWORK_CONFIG[NETWORK].baseToken.wrappedAddress,
    amount: amountWei,
    recipientAddress,
  }]
}

/** Quote a self-broadcast private WETH transfer; the public gas payer stays visible onchain. */
export async function quotePrivateWethSend(amountWei: bigint, recipientAddress: string): Promise<PrivateSendQuote> {
  if (amountWei <= 0n) throw new Error('Send amount must be greater than zero')
  assertValidRailgunAddress(recipientAddress)
  if (unresolvedTransaction('send')) throw new Error('A previous private send is unresolved. Check its transaction before sending another.')
  pendingSend = null
  const walletId = unlockedWalletId()
  const encryptionKey = unlockedEncryptionKey()
  const signer = await getConnectedInjectedSigner()
  const publicGasPayer = getAddress(await signer.getAddress())
  const spendableWethWei = await verifiedSpendableWeth(walletId)
  if (spendableWethWei < amountWei) throw new Error('Not enough spendable private WETH')

  const provider = privateProvider()
  try {
    const feeData = await provider.getFeeData()
    const { maxFeePerGas, maxPriorityFeePerGas } = checkedFeeData(feeData.maxFeePerGas, feeData.maxPriorityFeePerGas)
    const originalGasDetails: TransactionGasDetailsType2 = {
      evmGasType: EVMGasType.Type2, gasEstimate: 0n, maxFeePerGas, maxPriorityFeePerGas,
    }
    const { gasEstimate } = await gasEstimateForUnprovenTransfer(
      TXIDVersion.V2_PoseidonMerkle, NETWORK, walletId, encryptionKey,
      undefined, recipients(amountWei, recipientAddress), [], originalGasDetails,
      undefined, true,
    )
    if (gasEstimate <= 0n) throw new Error('RAILGUN did not return a usable gas estimate')
    const publicGasBalanceWei = await provider.getBalance(publicGasPayer)
    const maxNetworkFeeWei = calculateGasLimit(gasEstimate) * maxFeePerGas
    if (publicGasBalanceWei < maxNetworkFeeWei) throw new Error('Not enough Sepolia ETH in the public gas wallet')
    const quote: PrivateSendQuote = {
      id: crypto.randomUUID(), walletId, amountWei, recipientAddress, publicGasPayer,
      spendableWethWei, publicGasBalanceWei, maxNetworkFeeWei,
      expiresAt: Date.now() + REVIEW_LIFETIME_MS,
    }
    pendingSend = {
      quote, gasDetails: { ...originalGasDetails, gasEstimate },
    }
    return quote
  } finally { provider.destroy() }
}

export async function submitPrivateWethSend(quote: PrivateSendQuote,
  onProofProgress: (progress: number, status: string) => void): Promise<PrivateSendSubmission> {
  if (submitting) throw new Error('A private send is already being submitted')
  const draft = pendingSend
  if (!draft || draft.quote.id !== quote.id) throw new Error('Review this send again before submitting')
  if (Date.now() > draft.quote.expiresAt) { pendingSend = null; throw new Error('Send review expired. Get a fresh estimate.') }
  if (unlockedWalletId() !== draft.quote.walletId) throw new Error('Private wallet changed. Review again.')
  submitting = true
  pendingSend = null
  try {
    const signer = await getConnectedInjectedSigner()
    if (getAddress(await signer.getAddress()) !== draft.quote.publicGasPayer) throw new Error('Public gas wallet changed. Review again.')
    if (await verifiedSpendableWeth(draft.quote.walletId) < draft.quote.amountWei) throw new Error('Private WETH balance changed. Review again.')
    const provider = privateProvider()
    try {
      const [feeData, gasBalance] = await Promise.all([
        provider.getFeeData(), provider.getBalance(draft.quote.publicGasPayer),
      ])
      const { maxFeePerGas } = checkedFeeData(feeData.maxFeePerGas, feeData.maxPriorityFeePerGas)
      if (maxFeePerGas > draft.gasDetails.maxFeePerGas || gasBalance < draft.quote.maxNetworkFeeWei) {
        throw new Error('Gas conditions changed. Review this send again.')
      }
    } finally { provider.destroy() }

    const transfer = recipients(draft.quote.amountWei, draft.quote.recipientAddress)
    const overallBatchMinGasPrice = draft.gasDetails.maxFeePerGas
    await generateTransferProof(
      TXIDVersion.V2_PoseidonMerkle, NETWORK, draft.quote.walletId, unlockedEncryptionKey(),
      false, undefined, transfer, [], undefined, true, overallBatchMinGasPrice,
      (progress, status) => onProofProgress(progress, status),
    )
    const { transaction } = await populateProvedTransfer(
      TXIDVersion.V2_PoseidonMerkle, NETWORK, draft.quote.walletId,
      false, undefined, transfer, [], undefined, true, overallBatchMinGasPrice,
      draft.gasDetails,
    )
    if (!transaction.to || getAddress(transaction.to) !== getAddress(NETWORK_CONFIG[NETWORK].proxyContract) ||
      BigInt(transaction.value ?? 0) !== 0n) throw new Error('RAILGUN prepared an unexpected transfer transaction')
    const checkedSigner = await getConnectedInjectedSigner()
    if (getAddress(await checkedSigner.getAddress()) !== draft.quote.publicGasPayer) throw new Error('Public gas wallet changed before sending')
    const response = await checkedSigner.sendTransaction({ ...transaction, chainId: 11155111 })
    sent.set(response.hash, { gasPayer: draft.quote.publicGasPayer })
    let journalSaved = true
    try { recordSubmitted('send', response.hash, draft.quote.publicGasPayer) }
    catch { journalSaved = false }
    return { status: 'submitted', transactionHash: response.hash, explorerUrl: `${EXPLORER_URL}${response.hash}`, journalSaved }
  } finally { submitting = false }
}

export async function confirmPrivateWethSend(transactionHash: string): Promise<PrivateSendReceipt> {
  const inSession = sent.get(transactionHash)
  let saved: ReturnType<typeof findTransaction>
  try { saved = findTransaction(transactionHash) }
  catch (cause) { if (!inSession) throw cause }
  const prior = inSession ?? (saved?.kind === 'send' ? { gasPayer: saved.from } : undefined)
  if (!prior) throw new Error('Unknown private send transaction in this session')
  const provider = privateProvider()
  try {
    const receipt = await provider.waitForTransaction(transactionHash, 1, 180_000)
    if (!receipt) {
      if (saved) try { markTransaction(transactionHash, 'unknown') } catch { /* receipt remains authoritative */ }
      return { status: 'unknown', transactionHash, explorerUrl: `${EXPLORER_URL}${transactionHash}`, message: 'Confirmation is still pending. Check the explorer and retry.' }
    }
    if (!receipt.to || getAddress(receipt.to) !== getAddress(NETWORK_CONFIG[NETWORK].proxyContract) ||
      getAddress(receipt.from) !== prior.gasPayer) throw new Error('Confirmed transaction does not match this private send')
    const status = receipt.status === 1 ? 'confirmed' : 'reverted'
    if (saved) try { markTransaction(transactionHash, status) } catch { /* receipt remains authoritative */ }
    return { status, transactionHash, explorerUrl: `${EXPLORER_URL}${transactionHash}`, blockNumber: receipt.blockNumber }
  } catch (cause) {
    return { status: 'unknown', transactionHash, explorerUrl: `${EXPLORER_URL}${transactionHash}`,
      message: cause instanceof Error ? cause.message : 'Could not verify the send transaction' }
  } finally { provider.destroy() }
}
