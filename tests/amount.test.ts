import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEthAmount } from '../src/domain/amount.ts'

test('ETH amount preserves exact wei', () => {
  assert.equal(parseEthAmount('0.1'), 100000000000000000n)
  assert.equal(parseEthAmount(' 1.000000000000000001 '), 1000000000000000001n)
})

test('ETH amount rejects unsafe or ambiguous inputs', () => {
  for (const input of ['-1', '+1', '1e3', '0.0000000000000000001', '', '1,000', '0', '01', '1.']) {
    assert.throws(() => parseEthAmount(input), /amount|Amount/)
  }
})
