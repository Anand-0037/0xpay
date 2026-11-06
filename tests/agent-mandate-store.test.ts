import test from 'node:test'
import assert from 'node:assert/strict'
import { Wallet, keccak256, toUtf8Bytes } from 'ethers'
import { AgentMandateStore, AGENT_MANDATE_STORAGE_KEY } from '../src/agents/mandate-store.ts'
import { agentMandateDigest, agentMandateTypedData, createAgentMandate } from '../src/agents/mandate.ts'
import { PaperJournal, createProposal, executePaper, type AgentPolicy, type PaperAuthorization, type OutcomeExposureContext } from '../src/agents/engine.ts'
import type { OrderBookSnapshot } from '../src/agents/market.ts'

// Memory-only public policies and ephemeral unfunded signature fixtures.
const signer = Wallet.createRandom(), watch = Wallet.createRandom().address
const now = Math.floor(Date.now() / 1000) * 1000
const marker = `${AGENT_MANDATE_STORAGE_KEY}:initialized`
const identity = { owner: signer.address, watchedAccount: watch, agentId: 'prediction-paper-runner', nowSeconds: now / 1000 }
function memory() {
  const data = new Map<string, string>()
  return { data, getItem(key: string) { return data.get(key) ?? null }, setItem(key: string, value: string) { data.set(key, value) } }
}
function book(priceMicros = 500_000): OrderBookSnapshot {
  return { market: { id: '100', version: 'v1', conditionId: `0x${'a'.repeat(64)}`, question: 'Fixture?', slug: 'fixture', endDate: null,
    active: true, acceptingOrders: true, outcomes: [{ tokenId: '101', name: 'Yes' }, { tokenId: '102', name: 'No' }] },
  outcome: 'Yes', tokenId: '101', fetchedAt: now, sourceTimestamp: now, minOrderSizeMicros: 1_000_000,
  asks: [{ priceMicros, sizeMicros: 50_000_000 }], bids: [{ priceMicros: 480_000, sizeMicros: 50_000_000 }] }
}
const policy = (): AgentPolicy => ({ allowedMarketIds: ['100'], maxOrderMicros: 5_000_000, sessionBudgetMicros: 20_000_000,
  expiresAt: now + 600_000, maxSnapshotAgeMs: 90_000, maxSpreadMicros: 50_000, maxPriceMicros: 700_000, maxOutcomeSharesMicros: 100_000_000 })
const position = (): OutcomeExposureContext => ({ chainId: 137, tokenId: '101', balanceUnits: 1_000_000n, decimals: 6,
  checkedAt: now, blockNumber: 123, blockHash: `0x${'a'.repeat(64)}` })
async function envelope(sessionId: string, overrides: Record<string, unknown> = {}) {
  const payload = createAgentMandate({ version: 1, sessionId, nonce: `0x${'11'.repeat(32)}`, owner: signer.address, watchedAccount: watch,
    chainId: 137, agentId: identity.agentId, agentName: 'Prediction paper runner', allowedMarketIds: ['100'], budgetMicros: 20_000_000,
    maxOrderMicros: 5_000_000, maxPriceMicros: 700_000, maxSpreadMicros: 50_000, maxOutcomeSharesMicros: 100_000_000,
    expiresAt: now / 1000 + 600, canSignTransactions: false, ...overrides }, now / 1000)
  const typed = agentMandateTypedData(payload)
  return { domain: typed.domain, payload, signature: await signer.signTypedData(typed.domain, typed.types, typed.message) }
}
async function setup(overrides: Record<string, unknown> = {}) {
  const storage = memory(), journal = new PaperJournal(storage)
  await journal.setStopped(true)
  const sessionId = journal.snapshot().sessionId!
  const store = new AgentMandateStore(storage, sessionId), signed = await envelope(sessionId, overrides)
  await journal.revokeAuthorization(() => store.activate(signed, signer.address, now / 1000))
  const authorize: PaperAuthorization = context => store.authorize(context, identity)
  return { storage, journal, sessionId, store, signed, authorize }
}
function alter(storage: ReturnType<typeof memory>, change: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(storage.data.get(AGENT_MANDATE_STORAGE_KEY)!)
  change(value)
  const raw = JSON.stringify(value)
  storage.data.set(AGENT_MANDATE_STORAGE_KEY, raw); storage.data.set(marker, keccak256(toUtf8Bytes(raw)))
}
const proposal = (snapshot: OrderBookSnapshot) => createProposal({ book: snapshot, thesis: 'Synthetic fixture rationale.', estimatedProbabilityMicros: 900_000, stakeMicros: 5_000_000 }, now)

test('public signed authorization reloads with its nonce, and exact cumulative spend is checked at commit', async () => {
  const { storage, journal, sessionId, signed, authorize } = await setup({ budgetMicros: 5_000_000 })
  const loaded = new AgentMandateStore(storage, sessionId).load()
  assert.equal(agentMandateDigest(loaded.active!.payload), agentMandateDigest(signed.payload))
  assert.equal(loaded.currentNonce, signed.payload.nonce); assert.equal(loaded.revokedDigests.size, 0)
  await journal.setStopped(false)
  const first = book()
  const written = await executePaper(proposal(first), first, policy(), journal, now, false, () => true, position, authorize)
  assert.equal(written.mandateDigest, agentMandateDigest(signed.payload))
  assert.equal(new PaperJournal(storage).snapshot().records[0].mandateDigest, written.mandateDigest)
  assert.equal(journal.snapshot().spentMicros, 5_000_000)
  const next = book(501_000)
  await assert.rejects(executePaper(proposal(next), next, policy(), journal, now, false, () => true, position, authorize), /cumulative paper budget/)
  assert.equal(new PaperJournal(storage).snapshot().records.length, 1)
})

test('changed watched account and changed signed payload cannot authorize a paper append', async () => {
  const { store, journal, storage, signed } = await setup()
  await journal.setStopped(false)
  const snapshot = book()
  await assert.rejects(executePaper(proposal(snapshot), snapshot, policy(), journal, now, false, () => true, position,
    context => store.authorize(context, { ...identity, watchedAccount: signer.address })), /does not match/)
  assert.equal(journal.snapshot().records.length, 0)
  alter(storage, value => { (value.active as typeof signed).payload = { ...signed.payload, budgetMicros: 21_000_000 } })
  assert.throws(() => store.load(), /unreadable or inconsistent/)
})

test('queued distinct proposals authorize against committed cumulative spend inside the journal lock', async () => {
  const { journal, store } = await setup({ budgetMicros: 5_000_000 })
  await journal.setStopped(false)
  const observed: number[] = []
  const authorize: PaperAuthorization = context => { observed.push(context.spentMicros); store.authorize(context, identity) }
  const first = book(), second = book(501_000)
  const results = await Promise.allSettled([
    executePaper(proposal(first), first, policy(), journal, now, false, () => true, position, authorize),
    executePaper(proposal(second), second, policy(), journal, now, false, () => true, position, authorize),
  ])
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected'])
  assert.deepEqual(observed, [0, 5_000_000])
  assert.equal(journal.snapshot().spentMicros, 5_000_000); assert.equal(journal.snapshot().records.length, 1)
})

test('replacement retires the old digest; revocation reloads and cannot be silently reactivated', async () => {
  const { journal, store, storage, sessionId, signed } = await setup()
  const replacement = await envelope(sessionId, { nonce: `0x${'22'.repeat(32)}` })
  await journal.revokeAuthorization(() => store.activate(replacement, signer.address, now / 1000))
  assert.equal(store.load().revokedDigests.has(agentMandateDigest(signed.payload)), true)
  let revoked: string | null = null
  await journal.revokeAuthorization(() => { revoked = store.revokeActive() })
  assert.equal(revoked, agentMandateDigest(replacement.payload))
  const reloaded = new AgentMandateStore(storage, sessionId)
  assert.equal(reloaded.load().active, null); assert.equal(reloaded.load().currentNonce, replacement.payload.nonce)
  assert.throws(() => reloaded.activate(replacement, signer.address, now / 1000), /revoked/)
  assert.equal(journal.snapshot().stopped, true)
})

test('synchronous revocation kills queued writes; another journal instance sees the persisted stop', async () => {
  const { store, journal, storage, authorize } = await setup()
  await journal.setStopped(false)
  const snapshot = book()
  const waiting = executePaper(proposal(snapshot), snapshot, policy(), journal, now, false, () => true, position, authorize)
  const rejected = assert.rejects(waiting, /stopped while this execution was waiting/)
  const revoking = journal.revokeAuthorization(() => { store.revokeActive() })
  await rejected; await revoking
  assert.equal(journal.snapshot().records.length, 0); assert.equal(store.load().active, null)
  const other = new PaperJournal(storage)
  await assert.rejects(executePaper(proposal(snapshot), snapshot, policy(), other, now, false, () => true, position, authorize), /stopped/)
  assert.equal(other.snapshot().records.length, 0)
})

test('failed authority mutation leaves a durable stopped journal and no paper append', async () => {
  const { journal } = await setup()
  await journal.setStopped(false)
  await assert.rejects(journal.revokeAuthorization(() => { throw new Error('fixture mutation failed') }), /fixture mutation failed/)
  assert.equal(journal.snapshot().stopped, true)
})

test('a stop raised synchronously by final authorization prevents the commit', async () => {
  const { journal } = await setup()
  await journal.setStopped(false)
  let stopping: Promise<void> | undefined
  const snapshot = book()
  await assert.rejects(executePaper(proposal(snapshot), snapshot, policy(), journal, now, false, () => true, position,
    () => { stopping = journal.setStopped(true) }), /stopped during final authorization/)
  await stopping
  assert.equal(journal.snapshot().records.length, 0); assert.equal(journal.snapshot().stopped, true)
})

test('expired signed state remains readable/revocable but never authorizes an action or replacement', async () => {
  const { storage, sessionId, journal, signed } = await setup({ expiresAt: now / 1000 + 1 })
  const reloaded = new AgentMandateStore(storage, sessionId)
  assert.ok(reloaded.load().active)
  await journal.setStopped(false)
  const snapshot = book()
  await assert.rejects(executePaper(proposal(snapshot), snapshot, policy(), journal, now, false, () => true, position,
    context => reloaded.authorize(context, { ...identity, nowSeconds: now / 1000 + 1 })), /expired/)
  assert.throws(() => reloaded.activate(signed, signer.address, now / 1000 + 1), /expired/)
  await journal.revokeAuthorization(() => { reloaded.revokeActive() })
  assert.equal(reloaded.load().active, null)
})

test('corrupt, missing, wrong-session, oversized and tampered state fail closed instead of resetting nonce', async () => {
  for (const damage of ['missing-raw', 'missing-marker', 'both-missing', 'bad-json', 'oversized', 'wrong-session', 'wrong-nonce', 'extra-field', 'duplicate-revocation'] as const) {
    const { store, storage } = await setup()
    if (damage === 'missing-raw' || damage === 'both-missing') storage.data.delete(AGENT_MANDATE_STORAGE_KEY)
    if (damage === 'missing-marker' || damage === 'both-missing') storage.data.delete(marker)
    if (damage === 'bad-json') storage.data.set(AGENT_MANDATE_STORAGE_KEY, '{')
    if (damage === 'oversized') storage.data.set(AGENT_MANDATE_STORAGE_KEY, 'x'.repeat(256 * 1024 + 1))
    if (damage === 'wrong-session') alter(storage, value => { value.sessionId = 'other-session' })
    if (damage === 'wrong-nonce') alter(storage, value => { value.currentNonce = `0x${'33'.repeat(32)}` })
    if (damage === 'extra-field') alter(storage, value => { value.walletKey = 'public-fixture-not-key' })
    if (damage === 'duplicate-revocation') alter(storage, value => { value.revokedDigests = [`0x${'33'.repeat(32)}`, `0x${'33'.repeat(32)}`] })
    assert.throws(() => store.load(), /unreadable or inconsistent/, damage)
  }
  assert.throws(() => new AgentMandateStore({ getItem() { throw new Error('storage denied') }, setItem() {} }, 'session').load(), /unreadable/)
})

test('torn first write and silent storage loss are detected, without accepting active authority', async () => {
  const storage = memory(), signed = await envelope('fixture-session')
  const store = new AgentMandateStore({ getItem: storage.getItem, setItem(key, value) {
    if (key === AGENT_MANDATE_STORAGE_KEY) throw new Error('fixture storage full')
    storage.setItem(key, value)
  } }, 'fixture-session')
  assert.throws(() => store.activate(signed, signer.address, now / 1000), /write could not be verified/)
  assert.throws(() => new AgentMandateStore(storage, 'fixture-session').load(), /unreadable/)
  const denied = new AgentMandateStore({ getItem() { return null }, setItem() {} }, 'fixture-session')
  assert.throws(() => denied.activate(signed, signer.address, now / 1000), /write could not be verified/)
})

test('bounded revocation capacity never evicts old digests or enables another active mandate', async () => {
  const { journal, store, storage, sessionId } = await setup()
  await journal.revokeAuthorization(() => { store.revokeActive() })
  alter(storage, value => { value.revokedDigests = Array.from({ length: 500 }, (_, i) => keccak256(toUtf8Bytes(`public-revocation-fixture-${i}`))) })
  const candidate = await envelope(sessionId, { nonce: `0x${'44'.repeat(32)}` })
  assert.throws(() => store.activate(candidate, signer.address, now / 1000), /capacity/)
  assert.equal(store.load().revokedDigests.size, 500); assert.equal(store.load().active, null)
})

test('missing real outcome context and rejected/async authorizers never append', async () => {
  const { journal, authorize } = await setup()
  await journal.setStopped(false)
  const snapshot = book(), noCap = { ...policy(), maxOutcomeSharesMicros: undefined }
  await assert.rejects(executePaper(proposal(snapshot), snapshot, noCap, journal, now, false, () => true, undefined, authorize), /account snapshot/)
  await assert.rejects(executePaper(proposal(snapshot), snapshot, policy(), journal, now, false, () => true, position,
    () => { throw new Error('fixture authority refused') }), /fixture authority refused/)
  await assert.rejects(executePaper(proposal(snapshot), snapshot, policy(), journal, now, false, () => true, position,
    async () => {}), /must be synchronous/)
  assert.equal(journal.snapshot().records.length, 0)
})

test('legacy records stay unsigned and malformed recorded or callback mandate digests fail closed', async () => {
  const { journal, storage } = await setup()
  await journal.setStopped(false)
  const snapshot = book()
  const record = await executePaper(proposal(snapshot), snapshot, policy(), journal, now, false, () => true, position)
  assert.equal('mandateDigest' in record, false)
  assert.equal('mandateDigest' in new PaperJournal(storage).snapshot().records[0], false)
  const journalKey = '0xpay-paper-agent-v1'
  const original = storage.data.get(journalKey)!
  for (const digest of ['0x1234', null, 123, 'not-a-digest']) {
    const data = JSON.parse(original); data.records[0].mandateDigest = digest
    storage.data.set(journalKey, JSON.stringify(data))
    assert.throws(() => new PaperJournal(storage).snapshot(), /unreadable or inconsistent/)
  }
  storage.data.set(journalKey, original)
  const next = book(501_000)
  await assert.rejects(executePaper(proposal(next), next, policy(), journal, now, false, () => true, position,
    () => '0x1234'), /invalid mandate digest/)
  assert.equal(journal.snapshot().records.length, 1)
})
