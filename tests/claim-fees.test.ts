import test from 'node:test'
import assert from 'node:assert/strict'
import { claimFeeQuote, CLAIM_FEE, depositFundingQuote, DEPOSIT_TX } from '../src/pool/fees.ts'

test('review quote reconciles exact per-note fee and net payout for multiple claims', () => {
  const quote = claimFeeQuote(2)
  assert.equal(CLAIM_FEE, 3_860_000_000_000_000n)
  assert.equal(quote.recipientWei, 192_280_000_000_000_000n)
  assert.equal(quote.grossWei, quote.feeWei + quote.recipientWei)
  assert.equal(quote.feeWei, quote.feePerNoteWei * 2n)
  for (const invalid of [0, -1, 1.5, 21, NaN, Infinity]) assert.throws(() => claimFeeQuote(invalid))
})

test('deposit review quotes the signed transaction maximum, not a measured fee', () => {
  const one = depositFundingQuote(1)
  assert.equal(DEPOSIT_TX.gas, 20_000_000n)
  assert.equal(DEPOSIT_TX.gasPrice, 2_000_000_000n)
  assert.equal(one.noteValueWei, 100_000_000_000_000_000n)
  assert.equal(one.maxNetworkFeeWei, 40_000_000_000_000_000n)
  assert.equal(one.maximumDebitWei, 140_000_000_000_000_000n)
  const two = depositFundingQuote(2)
  assert.equal(two.maximumDebitWei, 2n * one.maximumDebitWei)
  for (const invalid of [0, -1, 1.5, 21, NaN, Infinity]) assert.throws(() => depositFundingQuote(invalid))
})
