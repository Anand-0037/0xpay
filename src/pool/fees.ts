export const CLAIM_GAS = Object.freeze({
  payment: 600_000n,
  // A payout to a separate fresh recipient needs more than 300k execution gas.
  // The browser's exact-signed simulation exhausted that previous limit.
  sender: 500_000n,
  // Independently simulated for a payout to an existing versus a fresh account.
  senderState: 500_000n,
  maxFeePerGas: 2_000_000_000n,
})
export const NOTE_DENOMINATION = 100_000_000_000_000_000n
export const DEPOSIT_TX = Object.freeze({ gas: 20_000_000n, gasPrice: 2_000_000_000n })
export function depositFundingQuote(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('Invalid note count')
  const noteValueWei = NOTE_DENOMINATION * BigInt(count)
  const maxNetworkFeeWei = DEPOSIT_TX.gas * DEPOSIT_TX.gasPrice * BigInt(count)
  return { noteCount: count, noteValueWei, maxNetworkFeeWei, maximumDebitWei: noteValueWei + maxNetworkFeeWei }
}
// Mirrors the signed frame budget, including intrinsic/signature overhead and pool margin.
export const CLAIM_FEE = (30_000n + CLAIM_GAS.payment + CLAIM_GAS.sender + CLAIM_GAS.senderState + 50_000n) * CLAIM_GAS.maxFeePerGas + 500_000_000_000_000n
export function claimFeeQuote(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('Invalid note count')
  return { noteCount: count, grossWei: NOTE_DENOMINATION * BigInt(count), feePerNoteWei: CLAIM_FEE,
    feeWei: CLAIM_FEE * BigInt(count), recipientWei: (NOTE_DENOMINATION - CLAIM_FEE) * BigInt(count) }
}
