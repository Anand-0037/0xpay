import test from 'node:test'
import assert from 'node:assert/strict'
import { AbiCoder, Signature, TypedDataEncoder, Wallet, keccak256 } from 'ethers'
import { agentMandateDigest, agentMandateTypedData, createAgentMandate, verifySignedAgentMandate,
  MAX_MANDATE_LIFETIME_SECONDS, type AgentMandate, type MandateActionContext } from '../src/agents/mandate.ts'

// Ephemeral, unfunded test signers only. No browser/user keys or network calls.
const signer = Wallet.createRandom(), stranger = Wallet.createRandom()
const now = 1_793_952_000
const raw = () => ({ version: 1, sessionId: 'paper-session-1', nonce: `0x${'11'.repeat(32)}`, owner: signer.address,
  watchedAccount: stranger.address,
  chainId: 137, agentId: 'researcher-skeptic-v1', agentName: 'Research desk', allowedMarketIds: ['200', '100'],
  budgetMicros: 20_000_000, maxOrderMicros: 6_000_000, maxPriceMicros: 700_000, maxSpreadMicros: 50_000,
  maxOutcomeSharesMicros: 50_000_000, expiresAt: now + 600, canSignTransactions: false })
const create = () => createAgentMandate(raw(), now)
const context = (payload: AgentMandate): MandateActionContext => ({ chainId: 137, owner: signer.address,
  watchedAccount: stranger.address,
  sessionId: payload.sessionId, nonce: payload.nonce, agentId: payload.agentId, action: 'paper-execute',
  marketId: '100', cumulativeSpendMicros: 3_000_000, spendMicros: 5_000_000, priceMicros: 650_000,
  spreadMicros: 30_000, combinedOutcomeSharesMicros: 10_000_000n, nowSeconds: now, revokedDigests: new Set() })
async function signed(payload = create()) {
  const typed = agentMandateTypedData(payload)
  return { domain: typed.domain, payload, signature: await signer.signTypedData(typed.domain, typed.types, typed.message) }
}

test('canonical market preimage, fixed paper domain and real ethers EIP712 recovery agree', async () => {
  const payload = create(), typed = agentMandateTypedData(payload), envelope = await signed(payload)
  assert.deepEqual(payload.allowedMarketIds, ['100', '200'])
  assert.deepEqual(typed.domain, { name: '0xPay Agent Mandate', version: '1', chainId: 137 })
  assert.equal(typed.primaryType, 'PaperAgentMandate')
  assert.equal('verifyingContract' in typed.domain, false)
  assert.equal(typed.message.canSignTransactions, false)
  assert.equal(typed.message.allowedMarketsHash, keccak256(AbiCoder.defaultAbiCoder().encode(['string[]'], [['100', '200']])))
  const verified = verifySignedAgentMandate(envelope, context(payload))
  assert.equal(verified.digest, TypedDataEncoder.hash(typed.domain, typed.types, typed.message))
  assert.equal(verified.owner, signer.address); assert.equal(verified.remainingBudgetMicros, 12_000_000)
  assert.equal(verified.policy.canSignTransactions, false)
  assert.equal(agentMandateDigest(createAgentMandate({ ...raw(), allowedMarketIds: ['100', '200'] }, now)), verified.digest)
  assert.equal(Object.isFrozen(payload), true); assert.equal(Object.isFrozen(payload.allowedMarketIds), true)
})

for (const [label, change] of [
  ['version', { version: 2 }], ['chain', { chainId: 1 }], ['string chain', { chainId: '137' }],
  ['signing authority', { canSignTransactions: true }], ['missing false flag', { canSignTransactions: undefined }],
  ['zero owner', { owner: `0x${'0'.repeat(40)}` }], ['bad owner', { owner: 'not-an-address' }],
  ['zero nonce', { nonce: `0x${'0'.repeat(64)}` }], ['short nonce', { nonce: '0x11' }],
  ['empty session', { sessionId: '' }], ['unbounded agent ID', { agentId: 'a'.repeat(129) }],
  ['name controls', { agentName: 'Desk\nOverride' }], ['unbounded name', { agentName: 'a'.repeat(81) }],
  ['extra policy field', { transactionAllowance: 1 }], ['empty markets', { allowedMarketIds: [] }],
  ['duplicate markets', { allowedMarketIds: ['100', '100'] }], ['sparse markets', { allowedMarketIds: new Array(1) }],
  ['too many markets', { allowedMarketIds: Array.from({ length: 33 }, (_, i) => String(i)) }],
  ['whitespace market', { allowedMarketIds: ['100 '] }], ['negative budget', { budgetMicros: -1 }],
  ['zero budget', { budgetMicros: 0 }], ['fractional units', { budgetMicros: 1.2 }],
  ['unsafe units', { budgetMicros: Number.MAX_SAFE_INTEGER + 1 }], ['zero price', { maxPriceMicros: 0 }],
  ['price above certainty', { maxPriceMicros: 1_000_001 }], ['expired', { expiresAt: now }],
  ['millisecond expiry', { expiresAt: (now + 600) * 1000 }],
  ['too distant expiry', { expiresAt: now + MAX_MANDATE_LIFETIME_SECONDS + 1 }],
] as const) {
  test(`creation rejects ${label}`, () => assert.throws(() => createAgentMandate({ ...raw(), ...change }, now), /Agent mandate/))
}

test('missing fields, noncanonical envelopes and typed-data mutation cannot alter later payload hashes', async () => {
  const missing: Record<string, unknown> = raw(); delete missing.owner
  assert.throws(() => createAgentMandate(missing, now), /missing fields/)
  assert.throws(() => agentMandateTypedData(raw()), /canonically sorted/)
  const payload = create(), before = agentMandateDigest(payload), typed = agentMandateTypedData(payload)
  typed.domain.name = 'Changed'; typed.types.PaperAgentMandate[0].name = 'Changed'
  assert.equal(agentMandateDigest(payload), before)
  const envelope = await signed(payload)
  assert.throws(() => verifySignedAgentMandate({ ...envelope, extra: true }, context(payload)), /unexpected/)
  assert.throws(() => verifySignedAgentMandate({ ...envelope, payload: raw() }, context(payload)), /canonically sorted/)
})

test('every signed policy field is bound and tampering fails owner recovery', async () => {
  const envelope = await signed(), current = context(envelope.payload)
  for (const change of [
    { agentName: 'Different desk' }, { budgetMicros: 21_000_000 }, { maxPriceMicros: 710_000 },
    { watchedAccount: signer.address }, { maxOrderMicros: 6_000_001 }, { maxSpreadMicros: 50_001 }, { maxOutcomeSharesMicros: 50_000_001 },
    { expiresAt: now + 601 }, { allowedMarketIds: ['100', '201'] },
  ]) {
    assert.throws(() => verifySignedAgentMandate({ ...envelope, payload: { ...envelope.payload, ...change } }, current), /signature/)
  }
  assert.throws(() => verifySignedAgentMandate({ ...envelope, payload: { ...envelope.payload, owner: stranger.address } }, { ...current, owner: stranger.address }), /signature/)
})

test('wrong signer and different EIP712 domain signatures are rejected', async () => {
  const envelope = await signed(), typed = agentMandateTypedData(envelope.payload), current = context(envelope.payload)
  const wrong = await stranger.signTypedData(typed.domain, typed.types, typed.message)
  assert.throws(() => verifySignedAgentMandate({ ...envelope, signature: wrong }, current), /signature/)
  for (const domain of [{ ...typed.domain, chainId: 1 }, { ...typed.domain, name: 'Other app' },
    { ...typed.domain, version: '2' }, { ...typed.domain, verifyingContract: stranger.address }]) {
    assert.throws(() => verifySignedAgentMandate({ ...envelope, domain }, current), /domain|unexpected/)
    const signature = await signer.signTypedData(domain, typed.types, typed.message)
    assert.throws(() => verifySignedAgentMandate({ ...envelope, signature }, current), /signature/)
  }
  assert.throws(() => verifySignedAgentMandate({ ...envelope, signature: '0x1234' }, current), /signature/)
  assert.equal(verifySignedAgentMandate({ ...envelope, signature: Signature.from(envelope.signature).compactSerialized }, current).owner, signer.address)
})

test('current owner, chain, agent, session, nonce and paper action prevent cross-context replay', async () => {
  const envelope = await signed(), current = context(envelope.payload)
  for (const change of [{ owner: stranger.address }, { chainId: 1 }, { chainId: '137' }, { agentId: 'other-agent' },
    { watchedAccount: signer.address },
    { sessionId: 'other-session' }, { nonce: `0x${'22'.repeat(32)}` }, { action: 'send-transaction' }, { action: 'place-order' }]) {
    assert.throws(() => verifySignedAgentMandate(envelope, { ...current, ...change } as MandateActionContext), /Agent mandate/)
  }
})

test('market, cumulative budget, worst fill price, expiry and local revocation are enforced', async () => {
  const envelope = await signed(), current = context(envelope.payload)
  for (const [change, pattern] of [
    [{ marketId: '999' }, /market/], [{ cumulativeSpendMicros: 16_000_000 }, /budget/],
    [{ priceMicros: 700_001 }, /price/], [{ nowSeconds: envelope.payload.expiresAt }, /expired/],
    [{ spendMicros: 6_000_001 }, /per-order/], [{ spreadMicros: 50_001 }, /spread/],
    [{ combinedOutcomeSharesMicros: 50_000_001n }, /share cap/],
    [{ cumulativeSpendMicros: -1 }, /cumulative spend/], [{ spendMicros: 0 }, /proposed spend/],
    [{ cumulativeSpendMicros: Number.MAX_SAFE_INTEGER, spendMicros: 5_000_000 }, /budget/],
    [{ revokedDigests: new Set([agentMandateDigest(envelope.payload).toUpperCase().replace('0X', '0x')]) }, /revoked/],
    [{ revokedDigests: new Set(['bad digest']) }, /revoked digest/],
    [{ revokedDigests: undefined }, /revocation set/],
  ] as const) assert.throws(() => verifySignedAgentMandate(envelope, { ...current, ...change }), pattern)
  const exact = verifySignedAgentMandate(envelope, { ...current, cumulativeSpendMicros: 15_000_000, priceMicros: 700_000 })
  assert.equal(exact.remainingBudgetMicros, 0)
})

test('a policy permits multiple bounded paper actions only against caller-updated cumulative state', async () => {
  const envelope = await signed(), current = context(envelope.payload)
  const first = verifySignedAgentMandate(envelope, current)
  const second = verifySignedAgentMandate(envelope, { ...current, cumulativeSpendMicros: 8_000_000 })
  assert.equal(first.digest, second.digest)
  assert.equal(second.remainingBudgetMicros, 7_000_000)
  assert.throws(() => verifySignedAgentMandate(envelope, { ...current, cumulativeSpendMicros: 18_000_000 }), /budget/)
  // Revocation is local policy enforcement, not a signature invalidation onchain.
  assert.throws(() => verifySignedAgentMandate(envelope, { ...current, revokedDigests: new Set([first.digest]) }), /revoked/)
})
