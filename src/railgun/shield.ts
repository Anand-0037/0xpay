import { JsonRpcProvider, getAddress, keccak256 } from 'ethers'
import {
  calculateGasLimit, EVMGasType, NETWORK_CONFIG, NetworkName, TXIDVersion,
  type TransactionGasDetailsType2,
} from '@railgun-community/shared-models'
import {
  gasEstimateForShieldBaseToken, getShieldPrivateKeySignatureMessage, populateShieldBaseToken,
} from '@railgun-community/wallet'
import { APP_RPC_URL } from '../rpc'
import { findTransaction, markTransaction, recordSubmitted, unresolvedTransaction } from '../domain/tx-journal'
import { getConnectedInjectedSigner } from '../wallet/injected'

const NETWORK = NetworkName.EthereumSepolia
const REVIEW_LIFETIME_MS = 120_000
const EXPLORER_URL = 'https://sepolia.etherscan.io/tx/'

export type ShieldQuote = {
  id: string
  amountWei: bigint
  estimatedProtocolFeeWei: bigint
  estimatedPrivateWethWei: bigint
  maxNetworkFeeWei: bigint
  publicBalanceWei: bigint
  sourceAddress: string
  recipientAddress: string
  expiresAt: number
}

export type ShieldSubmission = { status: 'submitted'; transactionHash: string; explorerUrl: string; journalSaved: boolean }
export type ShieldReceipt =
  | { status: 'confirmed' | 'reverted'; transactionHash: string; explorerUrl: string; blockNumber: number }
  | { status: 'unknown'; transactionHash: string; explorerUrl: string; message: string }

type PendingShield = { quote: ShieldQuote; shieldKey: string; gasDetails: TransactionGasDetailsType2 }
let pendingShield: PendingShield | null = null
let submitting = false
const submittedShields = new Map<string, { sourceAddress: string }>()

export function discardShieldQuote() { pendingShield = null }

function privateProvider() {
  return new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
}

function checkedFeeData(maxFeePerGas: bigint | null, maxPriorityFeePerGas: bigint | null) {
  if (!maxFeePerGas || !maxPriorityFeePerGas || maxFeePerGas <= 0n || maxPriorityFeePerGas <= 0n || maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error('Sepolia gas prices are unavailable through the private route. Try again.')
  }
  return { maxFeePerGas, maxPriorityFeePerGas }
}

export async function quoteEthShield(amountWei: bigint, recipientAddress: string, feeBasisPoints: bigint): Promise<ShieldQuote> {
  if (amountWei <= 0n) throw new Error('Shield amount must be greater than zero')
  if (feeBasisPoints < 0n || feeBasisPoints >= 10_000n) throw new Error('Shield fee is unavailable')
  if (unresolvedTransaction('shield')) throw new Error('A previous shield is unresolved. Check its transaction before sending another.')
  pendingShield = null

  const signer = await getConnectedInjectedSigner()
  const sourceAddress = getAddress(await signer.getAddress())
  // The browser wallet signs this SDK-defined message. The signature never leaves this module.
  const signature = await signer.signMessage(getShieldPrivateKeySignatureMessage())
  const checkedSigner = await getConnectedInjectedSigner()
  if (getAddress(await checkedSigner.getAddress()) !== sourceAddress) throw new Error('Browser wallet account changed during review')
  const shieldKey = keccak256(signature)
  const wrappedAddress = NETWORK_CONFIG[NETWORK].baseToken.wrappedAddress
  const { gasEstimate } = await gasEstimateForShieldBaseToken(
    TXIDVersion.V2_PoseidonMerkle, NETWORK, recipientAddress, shieldKey,
    { tokenAddress: wrappedAddress, amount: amountWei }, sourceAddress,
  )
  if (gasEstimate <= 0n) throw new Error('RAILGUN did not return a usable gas estimate')

  const provider = privateProvider()
  try {
    const [feeData, publicBalanceWei] = await Promise.all([
      provider.getFeeData(), provider.getBalance(sourceAddress),
    ])
    const { maxFeePerGas, maxPriorityFeePerGas } = checkedFeeData(feeData.maxFeePerGas, feeData.maxPriorityFeePerGas)
    const gasDetails: TransactionGasDetailsType2 = {
      evmGasType: EVMGasType.Type2, gasEstimate, maxFeePerGas, maxPriorityFeePerGas,
    }
    const maxNetworkFeeWei = calculateGasLimit(gasEstimate) * maxFeePerGas
    if (publicBalanceWei < amountWei + maxNetworkFeeWei) throw new Error('Not enough Sepolia ETH for the shield amount and maximum network fee')
    const estimatedProtocolFeeWei = amountWei * feeBasisPoints / 10_000n
    const quote: ShieldQuote = {
      id: crypto.randomUUID(), amountWei, estimatedProtocolFeeWei,
      estimatedPrivateWethWei: amountWei - estimatedProtocolFeeWei,
      maxNetworkFeeWei, publicBalanceWei, sourceAddress,
      recipientAddress, expiresAt: Date.now() + REVIEW_LIFETIME_MS,
    }
    pendingShield = { quote, shieldKey, gasDetails }
    return quote
  } finally { provider.destroy() }
}

export async function submitEthShield(quote: ShieldQuote): Promise<ShieldSubmission> {
  if (submitting) throw new Error('A shield request is already being submitted')
  const draft = pendingShield
  if (!draft || draft.quote.id !== quote.id) throw new Error('Review this shield again before submitting')
  if (Date.now() > draft.quote.expiresAt) { pendingShield = null; throw new Error('Shield review expired. Get a fresh estimate.') }
  submitting = true
  try {
    const signer = await getConnectedInjectedSigner()
    if (getAddress(await signer.getAddress()) !== draft.quote.sourceAddress) throw new Error('Browser wallet account changed. Review again.')
    const provider = privateProvider()
    try {
      const [feeData, balance] = await Promise.all([
        provider.getFeeData(), provider.getBalance(draft.quote.sourceAddress),
      ])
      const { maxFeePerGas } = checkedFeeData(feeData.maxFeePerGas, feeData.maxPriorityFeePerGas)
      if (maxFeePerGas > draft.gasDetails.maxFeePerGas) throw new Error('Network fee increased. Review the shield again.')
      if (balance < draft.quote.amountWei + draft.quote.maxNetworkFeeWei) throw new Error('Sepolia ETH balance changed. Review again.')
    } finally { provider.destroy() }

    const { transaction } = await populateShieldBaseToken(
      TXIDVersion.V2_PoseidonMerkle, NETWORK, draft.quote.recipientAddress, draft.shieldKey,
      { tokenAddress: NETWORK_CONFIG[NETWORK].baseToken.wrappedAddress, amount: draft.quote.amountWei },
      draft.gasDetails,
    )
    const expectedTarget = getAddress(NETWORK_CONFIG[NETWORK].relayAdaptContract)
    if (!transaction.to || getAddress(transaction.to) !== expectedTarget || BigInt(transaction.value ?? 0) !== draft.quote.amountWei) {
      throw new Error('RAILGUN prepared an unexpected shield transaction')
    }
    pendingShield = null
    // An extension may broadcast before reporting a transport error. Never reuse this draft.
    const sent = await signer.sendTransaction({ ...transaction, chainId: 11155111 })
    submittedShields.set(sent.hash, { sourceAddress: draft.quote.sourceAddress })
    let journalSaved = true
    try { recordSubmitted('shield', sent.hash, draft.quote.sourceAddress) }
    catch { journalSaved = false }
    return { status: 'submitted', transactionHash: sent.hash, explorerUrl: `${EXPLORER_URL}${sent.hash}`, journalSaved }
  } finally { submitting = false }
}

export async function confirmEthShield(transactionHash: string): Promise<ShieldReceipt> {
  const inSession = submittedShields.get(transactionHash)
  let saved: ReturnType<typeof findTransaction>
  try { saved = findTransaction(transactionHash) }
  catch (cause) { if (!inSession) throw cause }
  const submitted = inSession ?? (saved?.kind === 'shield' ? { sourceAddress: saved.from } : undefined)
  if (!submitted) throw new Error('Unknown shield transaction in this session')
  const provider = privateProvider()
  try {
    const receipt = await provider.waitForTransaction(transactionHash, 1, 180_000)
    if (!receipt) {
      if (saved) try { markTransaction(transactionHash, 'unknown') } catch { /* receipt remains authoritative */ }
      return { status: 'unknown', transactionHash, explorerUrl: `${EXPLORER_URL}${transactionHash}`, message: 'Confirmation is still pending. Check the explorer and retry.' }
    }
    if (!receipt.to || getAddress(receipt.to) !== getAddress(NETWORK_CONFIG[NETWORK].relayAdaptContract) ||
      getAddress(receipt.from) !== submitted.sourceAddress) throw new Error('Confirmed transaction does not match this shield')
    const status = receipt.status === 1 ? 'confirmed' : 'reverted'
    if (saved) try { markTransaction(transactionHash, status) } catch { /* receipt remains authoritative */ }
    return { status, transactionHash, explorerUrl: `${EXPLORER_URL}${transactionHash}`, blockNumber: receipt.blockNumber }
  } catch (cause) {
    return { status: 'unknown', transactionHash, explorerUrl: `${EXPLORER_URL}${transactionHash}`,
      message: cause instanceof Error ? cause.message : 'Could not verify the shield transaction' }
  } finally { provider.destroy() }
}
