import { test } from 'node:test'
import assert from 'node:assert/strict'
import { perOrderLimitMicros } from '../src/agents/order-limit.ts'
import { createProposal, evaluatePolicy, PaperJournal } from '../src/agents/engine.ts'
import type { OrderBookSnapshot } from '../src/agents/market.ts'

test('a separate per-order cap rejects a stake that fits within the session budget', () => {
  const now = Date.now()
  const book: OrderBookSnapshot = {
    market: { id: 'fixture', version: 'v1', conditionId: `0x${'a'.repeat(64)}`, question: 'Synthetic policy fixture?',
      slug: 'fixture', endDate: null, active: true, acceptingOrders: true,
      outcomes: [{ tokenId: '101', name: 'Yes' }, { tokenId: '102', name: 'No' }] },
    tokenId: '101', outcome: 'Yes', fetchedAt: now, sourceTimestamp: now,
    asks: [{ priceMicros: 500_000, sizeMicros: 100_000_000 }], bids: [{ priceMicros: 490_000, sizeMicros: 100_000_000 }], minOrderSizeMicros: 1_000_000,
  }
  const journal = new PaperJournal({ getItem: () => null, setItem() {} }, 'isolated-order-limit')
  const policy = { allowedMarketIds: ['fixture'], maxOrderMicros: perOrderLimitMicros('5'), sessionBudgetMicros: 20_000_000,
    expiresAt: now + 60_000, maxSnapshotAgeMs: 90_000, maxSpreadMicros: 50_000, maxPriceMicros: 700_000 }
  const proposal = (stakeMicros: number) => createProposal({ book, thesis: 'Synthetic test reasoning, not a market forecast.', estimatedProbabilityMicros: 650_000, stakeMicros }, now)
  const rejected = evaluatePolicy(proposal(6_000_000), book, policy, journal, now)
  assert.equal(rejected.allowed, false)
  assert.match(rejected.reasons.join(' '), /per-order/)
  assert.equal(evaluatePolicy(proposal(5_000_000), book, policy, journal, now).allowed, true)
  assert.equal(policy.maxOrderMicros, 5_000_000)
  assert.equal(journal.snapshot().spentMicros, 0)
})

test('per-order cap preserves micro units and rejects ambiguous or unsafe limits', () => {
  assert.equal(perOrderLimitMicros('5.000001'), 5_000_001)
  for (const value of ['0', '-1', '1e3', '1.0000001', '', '9007199254.740992']) assert.throws(() => perOrderLimitMicros(value))
})
