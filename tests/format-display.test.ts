import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDisplayBalance } from '../src/domain/format-display.ts'

test('compact balances preserve exact bigint rounding without hiding tiny positive funds', () => {
  assert.equal(formatDisplayBalance(0n), '0')
  assert.equal(formatDisplayBalance(39_999_999_983_167_300n), '≈0.04')
  assert.equal(formatDisplayBalance(9_975_000_000_000_000n), '≈0.00998')
  assert.equal(formatDisplayBalance(1n), '<0.00001')
  assert.equal(formatDisplayBalance(9_999_999_999_999n), '<0.00001')
  assert.equal(formatDisplayBalance(10_000_000_000_000n), '0.00001')
  assert.equal(formatDisplayBalance(1_000_000_000_000_000_000n), '1')
  assert.equal(formatDisplayBalance(999_999_999_999_999_999n), '≈1')
  assert.equal(formatDisplayBalance(1234567890123456789012345678901234567890n), '≈1234567890123456789012.34568')
  assert.equal(formatDisplayBalance(1n, 18), '0.000000000000000001')
  assert.throws(() => formatDisplayBalance(-1n), /negative/)
  assert.throws(() => formatDisplayBalance(1n, 19), /precision/)
})
