import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProposal, evaluatePolicy, evaluateProposalForReview, executePaper, outcomeUnitsToMicros, PaperJournal, type AgentPolicy, type OutcomeExposureContext } from '../src/agents/engine.ts'
import type { OrderBookSnapshot } from '../src/agents/market.ts'

const NOW = 1_700_000_000_000
const KEY = 'paper-test'
class MemoryStore {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}
function book(): OrderBookSnapshot {
  return { market: { id: 'market-1', version: 'v1', conditionId: `0x${'1'.repeat(64)}`, question: 'Will this fixture resolve YES?', slug: 'test-market',
    endDate: new Date(NOW + 86_400_000).toISOString(), active: true, acceptingOrders: true,
    outcomes: [{ tokenId: '101', name: 'Yes' }, { tokenId: '102', name: 'No' }] },
    tokenId: '101', outcome: 'Yes', fetchedAt: NOW, sourceTimestamp: NOW - 100,
    asks: [{ priceMicros: 400_000, sizeMicros: 2_000_000 }, { priceMicros: 500_000, sizeMicros: 100_000_000 }],
    bids: [{ priceMicros: 390_000, sizeMicros: 100_000_000 }], minOrderSizeMicros: 1_000_000 }
}
function setup() {
  const store = new MemoryStore(), journal = new PaperJournal(store, KEY), current = book()
  const policy: AgentPolicy = { allowedMarketIds: ['market-1'], maxOrderMicros: 3_000_000, sessionBudgetMicros: 5_000_000,
    expiresAt: NOW + 60_000, maxSnapshotAgeMs: 10_000, maxSpreadMicros: 100_000, maxPriceMicros: 600_000 }
  const proposal = createProposal({ book: current, thesis: 'A user-supplied test thesis, not a model forecast.',
    estimatedProbabilityMicros: 650_000, stakeMicros: 2_000_000 }, NOW)
  return { store, journal, current, policy, proposal }
}

for (const version of [undefined, null, 'v2', 'V1']) {
  test(`proposal review and execution reject unsupported market version ${String(version)}`, async () => {
    const state = setup()
    const unchecked = state.current as unknown as { market: { version?: unknown } }
    if (version === undefined) delete unchecked.market.version
    else unchecked.market.version = version
    assert.throws(() => createProposal({ book: state.current, thesis: 'Test thesis', estimatedProbabilityMicros: 650_000,
      stakeMicros: 2_000_000 }, NOW), /Only explicit Polymarket v1/)
    assert.equal(evaluatePolicy(state.proposal, state.current, state.policy, state.journal, NOW).allowed, false)
    assert.equal(evaluateProposalForReview(state.proposal, state.current, state.policy, state.journal, NOW).allowed, false)
    await assert.rejects(executePaper(state.proposal, state.current, state.policy, state.journal, NOW), /Only explicit Polymarket v1/)
    assert.equal(state.journal.snapshot().records.length, 0)
    assert.equal(state.journal.snapshot().spentMicros, 0)
  })
}

test('paper execution walks displayed depth, rounds costs up and reloads exactly once without venue calls', async () => {
  const { store, journal, current, policy, proposal } = setup()
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('The policy engine must never call a venue or wallet.') }
  try {
    const decision = evaluatePolicy(proposal, current, policy, journal, NOW)
    assert.equal(decision.allowed, true)
    assert.deepEqual(decision.quote?.fills, [
      { priceMicros: 400_000, sizeMicros: 2_000_000, costMicros: 800_000 },
      { priceMicros: 500_000, sizeMicros: 2_400_000, costMicros: 1_200_000 },
    ])
    assert.equal(decision.quote?.averagePriceMicros, 454_546)
    const result = await executePaper(proposal, current, policy, journal, NOW)
    assert.equal(result.mode, 'paper')
    assert.equal(result.sharesMicros, 4_400_000)
    assert.equal(result.spentMicros, 2_000_000)
    assert.equal(result.edgeMicros, 195_454)
    assert.equal(journal.snapshot().records.length, 1)
    assert.equal(JSON.stringify(journal.snapshot()).includes(proposal.thesis), false)
    const reloaded = new PaperJournal(store, KEY)
    assert.equal(reloaded.snapshot().spentMicros, 2_000_000)
    await assert.rejects(executePaper(proposal, current, policy, reloaded, NOW), /already been/)
    assert.equal(reloaded.snapshot().records.length, 1)
  } finally { globalThis.fetch = oldFetch }
})

for (const [name, mutate, reason] of [
  ['expiry', (x: ReturnType<typeof setup>) => { x.policy.expiresAt = NOW }, /expired/],
  ['allowlist', (x: ReturnType<typeof setup>) => { x.policy.allowedMarketIds = [] }, /allowlist/],
  ['per-order budget', (x: ReturnType<typeof setup>) => { x.policy.maxOrderMicros = 1_000_000 }, /per-order/],
  ['session budget', (x: ReturnType<typeof setup>) => { x.policy.sessionBudgetMicros = 1_000_000 }, /session budget/],
  ['maximum price', (x: ReturnType<typeof setup>) => { x.policy.maxPriceMicros = 450_000 }, /maximum buy price/],
  ['maximum spread', (x: ReturnType<typeof setup>) => { x.policy.maxSpreadMicros = 9_999 }, /spread/],
  ['no positive edge', (x: ReturnType<typeof setup>) => { x.proposal.estimatedProbabilityMicros = 454_546 }, /estimated probability/],
  ['future proposal', (x: ReturnType<typeof setup>) => { x.proposal.createdAt = NOW + 1 }, /future/],
  ['fractional stake', (x: ReturnType<typeof setup>) => { x.proposal.stakeMicros = 1.5 }, /Invalid paper proposal/],
  ['unsafe integer stake', (x: ReturnType<typeof setup>) => { x.proposal.stakeMicros = Number.MAX_SAFE_INTEGER + 1 }, /Invalid paper proposal/],
  ['negative policy', (x: ReturnType<typeof setup>) => { x.policy.sessionBudgetMicros = -1 }, /policy limits/],
] as const) {
  test(`policy rejects ${name} without recording a paper fill`, async () => {
    const state = setup(); mutate(state)
    const result = evaluatePolicy(state.proposal, state.current, state.policy, state.journal, NOW)
    assert.equal(result.allowed, false)
    assert.match(result.reasons.join(' '), reason)
    await assert.rejects(executePaper(state.proposal, state.current, state.policy, state.journal, NOW), reason)
    assert.equal(state.journal.snapshot().spentMicros, 0)
  })
}

test('a refreshed or changed book, wrong token/condition/question and malformed levels invalidate proposals', () => {
  for (const mutate of [
    (b: OrderBookSnapshot) => { b.fetchedAt++ },
    (b: OrderBookSnapshot) => { b.asks[0].sizeMicros++ },
    (b: OrderBookSnapshot) => { b.market.conditionId = `0x${'2'.repeat(64)}` },
    (b: OrderBookSnapshot) => { b.market.question = 'A different market question' },
    (b: OrderBookSnapshot) => { b.tokenId = '102'; b.outcome = 'No' },
    (b: OrderBookSnapshot) => { b.market.active = false },
    (b: OrderBookSnapshot) => { b.asks[1].priceMicros = b.asks[0].priceMicros },
    (b: OrderBookSnapshot) => { b.asks[0].priceMicros = 0 },
    (b: OrderBookSnapshot) => { b.asks[0].sizeMicros = Number.MAX_SAFE_INTEGER + 1 },
    (b: OrderBookSnapshot) => { b.bids[0].priceMicros = 600_000 },
  ]) {
    const state = setup(); mutate(state.current)
    assert.equal(evaluatePolicy(state.proposal, state.current, state.policy, state.journal, NOW).allowed, false)
  }
})

test('stale, missing and future source timestamps fail even on newly fetched books', () => {
  for (const timestamps of [
    { fetchedAt: NOW - 10_001, sourceTimestamp: NOW },
    { fetchedAt: NOW, sourceTimestamp: NOW - 10_001 },
    { fetchedAt: NOW, sourceTimestamp: null },
    { fetchedAt: NOW + 1, sourceTimestamp: NOW },
    { fetchedAt: NOW, sourceTimestamp: NOW + 1 },
  ]) {
    const state = setup(); Object.assign(state.current, timestamps)
    const proposal = createProposal({ book: state.current, thesis: 'Test thesis', estimatedProbabilityMicros: 650_000, stakeMicros: 2_000_000 }, NOW)
    const result = evaluatePolicy(proposal, state.current, state.policy, state.journal, NOW)
    assert.equal(result.allowed, false); assert.match(result.reasons.join(' '), /timestamp/)
  }
})

test('insufficient depth, unknown spread, minimum size and numeric overflow never invent a complete fill', async () => {
  for (const [mutate, reason] of [
    [(b: OrderBookSnapshot) => { b.asks = [{ priceMicros: 400_000, sizeMicros: 1_000_000 }] }, /depth/],
    [(b: OrderBookSnapshot) => { b.bids = [] }, /bid depth/],
    [(b: OrderBookSnapshot) => { b.minOrderSizeMicros = 100_000_000 }, /minimum size/],
  ] as const) {
    const state = setup(); mutate(state.current)
    const proposal = createProposal({ book: state.current, thesis: 'Test thesis', estimatedProbabilityMicros: 650_000, stakeMicros: 2_000_000 }, NOW)
    await assert.rejects(executePaper(proposal, state.current, state.policy, state.journal, NOW), reason)
    assert.equal(state.journal.snapshot().records.length, 0)
  }
  const state = setup()
  state.current.asks = [{ priceMicros: 1, sizeMicros: Number.MAX_SAFE_INTEGER }, { priceMicros: 2, sizeMicros: Number.MAX_SAFE_INTEGER }]
  state.current.bids = [{ priceMicros: 1, sizeMicros: 1 }]
  state.policy.maxOrderMicros = state.policy.sessionBudgetMicros = Number.MAX_SAFE_INTEGER
  const proposal = createProposal({ book: state.current, thesis: 'Test thesis', estimatedProbabilityMicros: 650_000,
    stakeMicros: 10_000_000_000 }, NOW)
  await assert.rejects(executePaper(proposal, state.current, state.policy, state.journal, NOW), /supported integer range/)
})

test('concurrent same-ID execution records once; different IDs share the persisted cumulative budget', async () => {
  const state = setup()
  const duplicate = await Promise.allSettled([
    executePaper(state.proposal, state.current, state.policy, state.journal, NOW),
    executePaper(state.proposal, state.current, state.policy, new PaperJournal(state.store, KEY), NOW),
  ])
  assert.equal(duplicate.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(state.journal.snapshot().records.length, 1)
  const firstBook = book(), secondBook = book()
  firstBook.asks[1].sizeMicros++; secondBook.asks[1].sizeMicros += 2
  const proposal = (current: OrderBookSnapshot) => createProposal({ book: current, thesis: 'Test thesis', estimatedProbabilityMicros: 650_000, stakeMicros: 2_000_000 }, NOW)
  const budget = await Promise.allSettled([
    executePaper(proposal(firstBook), firstBook, state.policy, state.journal, NOW),
    executePaper(proposal(secondBook), secondBook, state.policy, new PaperJournal(state.store, KEY), NOW),
  ])
  assert.equal(budget.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(new PaperJournal(state.store, KEY).snapshot().spentMicros, 4_000_000)
})

test('new proposal IDs, a newer fetch timestamp or changed bids cannot reuse the same displayed asks after reload', async () => {
  const state = setup()
  await executePaper(state.proposal, state.current, state.policy, state.journal, NOW)
  const refreshed = book(); refreshed.fetchedAt++; refreshed.sourceTimestamp = NOW; refreshed.bids[0].sizeMicros++
  const proposal = createProposal({ book: refreshed, thesis: 'Test thesis', estimatedProbabilityMicros: 650_000, stakeMicros: 2_000_000 }, NOW + 1)
  await assert.rejects(executePaper(proposal, refreshed, state.policy, new PaperJournal(state.store, KEY), NOW + 1), /already used for a paper fill/)
  assert.equal(state.journal.snapshot().spentMicros, 2_000_000)
})

test('kill is immediate for queued executions, durable after reload, and does not prevent review-only proposals', async () => {
  const state = setup()
  const queued = executePaper(state.proposal, state.current, state.policy, state.journal, NOW)
  const killed = state.journal.setStopped(true)
  assert.equal(state.journal.snapshot().stopped, true)
  await assert.rejects(queued, /stopped while/)
  await killed
  const reloaded = new PaperJournal(state.store, KEY)
  assert.equal(reloaded.snapshot().stopped, true)
  assert.equal(evaluateProposalForReview(state.proposal, state.current, state.policy, reloaded, NOW).allowed, true)
  assert.equal(evaluatePolicy(state.proposal, state.current, state.policy, reloaded, NOW).allowed, false)
  await assert.rejects(executePaper(state.proposal, state.current, state.policy, reloaded, NOW), /stopped/)
  await reloaded.setStopped(false)
  assert.equal((await executePaper(state.proposal, state.current, state.policy, reloaded, NOW)).mode, 'paper')
})

test('default execution checks the real time after a queued lock, rejecting newly stale quotes', async () => {
  const state = setup()
  const original = Date.now
  let time = NOW
  Date.now = () => time
  try {
    const queued = executePaper(state.proposal, state.current, state.policy, state.journal)
    time = NOW + 10_001
    await assert.rejects(queued, /timestamp/)
    assert.equal(state.journal.snapshot().records.length, 0)
  } finally { Date.now = original }
})

test('a research-bound expiry rejects execution after a lock wait even when the quote remains fresh', async () => {
  const state = setup(), original = Date.now
  let time = NOW
  Date.now = () => time
  try {
    const researchDeadline = NOW + 50
    const policy = { ...state.policy, expiresAt: Math.min(state.policy.expiresAt, researchDeadline) }
    const queued = executePaper(state.proposal, state.current, policy, state.journal)
    time = researchDeadline
    await assert.rejects(queued, /policy has expired/)
    assert.equal(state.journal.snapshot().records.length, 0)
    assert.equal(state.journal.snapshot().spentMicros, 0)
  } finally { Date.now = original }
})

test('live route validation runs inside the journal lock and rejects a queued route loss without an append', async () => {
  const state = setup()
  let routeReady = true, checks = 0
  const queued = executePaper(state.proposal, state.current, state.policy, state.journal, NOW, false, () => { checks++; return routeReady })
  routeReady = false
  await assert.rejects(queued, /private route or evidence is no longer valid/)
  assert.equal(checks, 1)
  assert.equal(state.journal.snapshot().records.length, 0)
  assert.equal(state.journal.snapshot().spentMicros, 0)
})

test('a route invalidated during final preparation cannot pass the second pre-append guard', async () => {
  const state = setup()
  let checks = 0
  await assert.rejects(executePaper(state.proposal, state.current, state.policy, state.journal, NOW, false,
    () => ++checks === 1), /private route or evidence is no longer valid/)
  assert.equal(checks, 2)
  assert.equal(state.journal.snapshot().records.length, 0)
})

function position(balanceUnits = 0n, decimals = 6): OutcomeExposureContext {
  return { chainId: 137, tokenId: '101', balanceUnits, decimals, checkedAt: NOW, blockNumber: 1000, blockHash: `0x${'a'.repeat(64)}` }
}

test('real outcome holdings change the same paper decision and exact cap equality is permitted', () => {
  const state = setup(), policy = { ...state.policy, maxOutcomeSharesMicros: 5_000_000 }
  const check = (context: OutcomeExposureContext | null) => evaluateProposalForReview(state.proposal, state.current, policy, state.journal, NOW, context)
  assert.equal(check(position(0n)).allowed, true)
  assert.equal(check(position(600000n)).allowed, true, '0.6 actual plus 4.4 paper shares equals the five-share cap')
  assert.equal(check(position(600001n)).allowed, false)
  assert.match(check(position(600001n)).reasons.join(' '), /onchain holdings.*exceed/)
  assert.match(check(position(600001n)).reasons.join(' '), /0\.600001 shares/)
  assert.equal(check(null).allowed, false, 'unknown holdings are never treated as zero')
})

test('raw outcome decimals use exact conservative ceiling rather than Number conversion or rounded-down dust', () => {
  assert.equal(outcomeUnitsToMicros(1n, 0), 1_000_000n)
  assert.equal(outcomeUnitsToMicros(1n, 6), 1n)
  assert.equal(outcomeUnitsToMicros(1n, 18), 1n)
  assert.equal(outcomeUnitsToMicros(600000000000000000n, 18), 600000n)
  assert.equal(outcomeUnitsToMicros(600000000000000001n, 18), 600001n)
  assert.throws(() => outcomeUnitsToMicros(-1n, 6), /Invalid onchain/)
  assert.throws(() => outcomeUnitsToMicros(1n, 37), /Invalid onchain/)
  const state = setup(), policy = { ...state.policy, maxOutcomeSharesMicros: 5_000_000 }
  assert.equal(evaluatePolicy(state.proposal, state.current, policy, state.journal, NOW, false, position(600000000000000000n, 18)).allowed, true)
  assert.equal(evaluatePolicy(state.proposal, state.current, policy, state.journal, NOW, false, position(600000000000000001n, 18)).allowed, false)
})

test('all browser paper shares for the selected token count after reload while another token is separate', async () => {
  const state = setup(), policy = { ...state.policy, maxOutcomeSharesMicros: 8_000_000 }
  await executePaper(state.proposal, state.current, policy, state.journal, NOW, false, undefined, () => position())
  const next = book(); next.asks[1].sizeMicros++
  const nextProposal = createProposal({ book: next, thesis: 'A second hypothetical fill.', estimatedProbabilityMicros: 650000, stakeMicros: 2000000 }, NOW)
  const reloaded = new PaperJournal(state.store, KEY)
  const duplicateExposure = evaluatePolicy(nextProposal, next, policy, reloaded, NOW, false, position())
  assert.equal(duplicateExposure.allowed, false)
  assert.match(duplicateExposure.reasons.join(' '), /browser.*paper shares/)
  const other = book(); other.tokenId = '102'; other.outcome = 'No'
  const otherProposal = createProposal({ book: other, thesis: 'A different outcome.', estimatedProbabilityMicros: 650000, stakeMicros: 2000000 }, NOW)
  assert.equal(evaluatePolicy(otherProposal, other, policy, reloaded, NOW, false, { ...position(), tokenId: '102' }).allowed, true)
  assert.doesNotMatch(state.store.getItem(KEY)!, /balanceUnits|checkedAt|blockHash/, 'account context is not serialized into the paper journal')
})

test('stale, future, wrong-token and malformed outcome context fail closed without an append', async () => {
  const state = setup(), policy = { ...state.policy, maxOutcomeSharesMicros: 5_000_000 }
  for (const context of [{ ...position(), checkedAt: NOW - 90001 }, { ...position(), checkedAt: NOW + 1 },
    { ...position(), chainId: 1 } as unknown as OutcomeExposureContext,
    { ...position(), tokenId: '102' }, { ...position(), blockHash: '0x1234' }]) {
    await assert.rejects(executePaper(state.proposal, state.current, policy, state.journal, NOW, false, undefined, () => context), /fresh matching/)
    assert.equal(state.journal.snapshot().records.length, 0)
  }
})

test('the current position is read under the journal lock, not captured before a queued change', async () => {
  const state = setup(), policy = { ...state.policy, maxOutcomeSharesMicros: 5_000_000 }
  let current = position()
  const queued = executePaper(state.proposal, state.current, policy, state.journal, NOW, false, undefined, () => current)
  current = position(2_000_000n)
  await assert.rejects(queued, /exceed the outcome share cap/)
  assert.equal(state.journal.snapshot().records.length, 0)
})

test('the exposure snapshot can expire while waiting for a lock even if book and policy remain fresh', async () => {
  const state = setup(), original = Date.now
  const policy = { ...state.policy, maxOutcomeSharesMicros: 5_000_000, maxSnapshotAgeMs: 200000, expiresAt: NOW + 200000 }
  let now = NOW
  Date.now = () => now
  try {
    const queued = executePaper(state.proposal, state.current, policy, state.journal, undefined, false, undefined, () => position())
    now = NOW + 90001
    await assert.rejects(queued, /fresh matching/)
    assert.equal(state.journal.snapshot().records.length, 0)
  } finally { Date.now = original }
})

test('a final changed-position check blocks an over-cap append after initial assessment', async () => {
  const state = setup(), policy = { ...state.policy, maxOutcomeSharesMicros: 5_000_000 }
  let reads = 0
  await assert.rejects(executePaper(state.proposal, state.current, policy, state.journal, NOW, false, undefined,
    () => ++reads === 1 ? position() : position(2_000_000n)), /exceed the outcome share cap/)
  assert.equal(reads, 2)
  assert.equal(state.journal.snapshot().records.length, 0)
})

test('corrupt, missing, duplicate or altered journal records never reset cumulative budget', async () => {
  const state = setup()
  await executePaper(state.proposal, state.current, state.policy, state.journal, NOW)
  const valid = state.store.getItem(KEY)!
  const mutations: (string | null)[] = ['{broken-json', null]
  const duplicate = JSON.parse(valid); duplicate.records.push(duplicate.records[0]); mutations.push(JSON.stringify(duplicate))
  const badCost = JSON.parse(valid); badCost.records[0].spentMicros = 1; mutations.push(JSON.stringify(badCost))
  const wrongMode = JSON.parse(valid); wrongMode.records[0].mode = 'live'; mutations.push(JSON.stringify(wrongMode))
  const unsafe = JSON.parse(valid); unsafe.records[0].fills[0].sizeMicros = Number.MAX_SAFE_INTEGER + 1; mutations.push(JSON.stringify(unsafe))
  for (const raw of mutations) {
    if (raw === null) state.store.values.delete(KEY); else state.store.setItem(KEY, raw)
    const reloaded = new PaperJournal(state.store, KEY)
    assert.throws(() => reloaded.snapshot(), /budget was not reset/)
    await assert.rejects(executePaper(state.proposal, state.current, state.policy, reloaded, NOW), /budget was not reset/)
  }
  state.store.setItem(KEY, valid)
  assert.equal(new PaperJournal(state.store, KEY).snapshot().spentMicros, 2_000_000)
  state.store.values.clear()
  assert.throws(() => state.journal.snapshot(), /budget was not reset/)
})

test('interrupted first journal write fails closed rather than reopening a zero-budget session', async () => {
  const store = new MemoryStore()
  const broken = { getItem: store.getItem.bind(store), setItem(key: string, value: string) {
    if (key === KEY) throw new Error('Storage failure')
    store.setItem(key, value)
  } }
  const state = setup(), journal = new PaperJournal(broken, KEY)
  await assert.rejects(executePaper(state.proposal, state.current, state.policy, journal, NOW), /write could not be verified/)
  assert.throws(() => new PaperJournal(store, KEY).snapshot(), /budget was not reset/)
})

test('browser Web Locks release after a rejection and serialize duplicate and budget checks', async (context) => {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) { context.skip('Runtime does not expose the Web Locks API.'); return }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true })
  try {
    const state = setup()
    const failed = executePaper(state.proposal, state.current, { ...state.policy, expiresAt: NOW }, state.journal, NOW)
    const next = executePaper(state.proposal, state.current, state.policy, state.journal, NOW)
    const outcomes = await Promise.allSettled([failed, next,
      executePaper(state.proposal, state.current, state.policy, new PaperJournal(state.store, KEY), NOW)])
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(state.journal.snapshot().records.length, 1)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('a browser without Web Locks cannot record paper execution', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true })
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
  try {
    const state = setup()
    await assert.rejects(executePaper(state.proposal, state.current, state.policy, state.journal, NOW), /Web Locks/)
    assert.equal(state.journal.snapshot().spentMicros, 0)
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window')
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator')
  }
})
