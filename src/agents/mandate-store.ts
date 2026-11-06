import { getAddress, keccak256, toUtf8Bytes } from 'ethers'
import { agentMandateDigest, validateSignedAgentMandate, verifySignedAgentMandate, type SignedAgentMandate } from './mandate.ts'
import type { PaperAuthorizationContext } from './engine.ts'

type Store = Pick<Storage, 'getItem' | 'setItem'>
type Persisted = { version: 1; sessionId: string; currentNonce: string | null; active: SignedAgentMandate | null; revokedDigests: string[] }
export type AgentMandateStoreSnapshot = Readonly<Omit<Persisted, 'revokedDigests'> & { revokedDigests: ReadonlySet<string> }>
const MAX_REVOKED = 500
export const AGENT_MANDATE_STORAGE_KEY = '0xpay-paper-mandate-v1'
const MAX_BYTES = 256 * 1024
const HASH = /^0x[0-9a-f]{64}$/
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
function fail(message: string): never { throw new Error(`Agent authorization storage: ${message}`) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid state.')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: string[]) {
  const keys = Object.keys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail('invalid state fields.')
}

/** Public signatures/policies only; never wallet keys. Mutation methods MUST run
 * in PaperJournal.revokeAuthorization's shared lock (activation stops too).
 * The hash marker detects torn/corrupt writes, not an attacker rewriting both
 * localStorage records. This is local revocation, not global/onchain control.
 */
export class AgentMandateStore {
  private initializedSeen = false
  private readonly storage: Store
  readonly sessionId: string
  private readonly key: string
  constructor(storage: Store, sessionId: string, key = AGENT_MANDATE_STORAGE_KEY) {
    if (!ID.test(sessionId) || !ID.test(key)) fail('invalid session or storage key.')
    this.storage = storage; this.sessionId = sessionId; this.key = key
  }
  load(): AgentMandateStoreSnapshot {
    try {
      const raw = this.storage.getItem(this.key), marker = this.storage.getItem(`${this.key}:initialized`)
      if (raw === null && marker === null && !this.initializedSeen) return Object.freeze({ version: 1, sessionId: this.sessionId, currentNonce: null, active: null, revokedDigests: new Set<string>() })
      if (raw === null || marker === null || new TextEncoder().encode(raw).length > MAX_BYTES ||
        marker !== keccak256(toUtf8Bytes(raw))) fail('incomplete or corrupt write.')
      const value = object(JSON.parse(raw)); exact(value, ['version', 'sessionId', 'currentNonce', 'active', 'revokedDigests'])
      if (value.version !== 1 || value.sessionId !== this.sessionId ||
        value.currentNonce !== null && (typeof value.currentNonce !== 'string' || !HASH.test(value.currentNonce) || value.currentNonce === `0x${'0'.repeat(64)}`) ||
        !Array.isArray(value.revokedDigests) || value.revokedDigests.length > MAX_REVOKED) fail('invalid session or revocation state.')
      const revoked = Array.from(value.revokedDigests, digest => {
        if (typeof digest !== 'string' || !HASH.test(digest)) return fail('invalid revoked digest.')
        return digest
      })
      if (new Set(revoked).size !== revoked.length) fail('duplicate revoked digest.')
      let active: SignedAgentMandate | null = null
      if (value.active !== null) {
        if (revoked.length >= MAX_REVOKED) fail('no revocation slot remains for an active authorization.')
        const validated = validateSignedAgentMandate(value.active)
        if (validated.policy.sessionId !== this.sessionId || validated.policy.nonce !== value.currentNonce || revoked.includes(validated.digest)) fail('active authorization does not match this session.')
        active = JSON.parse(JSON.stringify(value.active)) as SignedAgentMandate
      }
      this.initializedSeen = true
      return Object.freeze({ version: 1, sessionId: this.sessionId, currentNonce: value.currentNonce as string | null, active, revokedDigests: new Set(revoked) })
    } catch { return fail('state is unreadable or inconsistent; execution remains stopped.') }
  }
  private save(state: AgentMandateStoreSnapshot) {
    const data: Persisted = { version: 1, sessionId: this.sessionId, currentNonce: state.currentNonce, active: state.active, revokedDigests: [...state.revokedDigests].sort() }
    const raw = JSON.stringify(data), marker = keccak256(toUtf8Bytes(raw))
    if (data.revokedDigests.length > MAX_REVOKED || new TextEncoder().encode(raw).length > MAX_BYTES) fail('revocation capacity reached; no protection was evicted.')
    try {
      // Marker first makes a failed first/second write distinguishable from an
      // uninitialized store. Readback must match both exact records.
      this.initializedSeen = true
      this.storage.setItem(`${this.key}:initialized`, marker)
      this.storage.setItem(this.key, raw)
      if (this.storage.getItem(this.key) !== raw || this.storage.getItem(`${this.key}:initialized`) !== marker) fail('write did not persist.')
      this.load()
    } catch { fail('write could not be verified; execution remains stopped.') }
  }
  activate(envelope: unknown, expectedOwner: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
    const validated = validateSignedAgentMandate(envelope, nowSeconds)
    if (validated.owner !== getAddress(expectedOwner) || validated.policy.sessionId !== this.sessionId) fail('wrong approving owner or paper session.')
    const state = this.load(), revoked = new Set(state.revokedDigests)
    if (revoked.has(validated.digest)) fail('authorization was revoked.')
    const priorDigest = state.active ? agentMandateDigest(state.active.payload) : null
    if (priorDigest !== validated.digest && state.currentNonce === validated.policy.nonce) fail('a new authorization needs a new nonce.')
    if (priorDigest && priorDigest !== validated.digest) revoked.add(priorDigest)
    if (revoked.size >= MAX_REVOKED) fail('revocation capacity reached; no protection was evicted.')
    const signed = envelope as SignedAgentMandate
    this.save({ version: 1, sessionId: this.sessionId, currentNonce: validated.policy.nonce,
      active: { domain: { ...signed.domain }, payload: validated.policy, signature: signed.signature }, revokedDigests: revoked })
  }
  revokeActive(): string | null {
    const state = this.load()
    if (!state.active) return null
    const digest = agentMandateDigest(state.active.payload), revoked = new Set(state.revokedDigests)
    revoked.add(digest)
    if (revoked.size > MAX_REVOKED) fail('revocation capacity reached; no protection was evicted.')
    this.save({ ...state, active: null, revokedDigests: revoked })
    return digest
  }
  authorize(context: PaperAuthorizationContext, identity: { owner: string; watchedAccount: string; agentId: string; nowSeconds?: number }): string {
    const state = this.load()
    if (!state.active || !state.currentNonce || context.sessionId !== this.sessionId || context.combinedOutcomeSharesMicros === null) fail('a matching signed authorization and account snapshot are required.')
    const verified = verifySignedAgentMandate(state.active, { chainId: 137, owner: identity.owner, watchedAccount: identity.watchedAccount,
      sessionId: context.sessionId, nonce: state.currentNonce, agentId: identity.agentId, action: 'paper-execute', marketId: context.proposal.marketId,
      cumulativeSpendMicros: context.spentMicros, spendMicros: context.quote.spentMicros, priceMicros: context.quote.worstPriceMicros,
      spreadMicros: context.spreadMicros, combinedOutcomeSharesMicros: context.combinedOutcomeSharesMicros,
      revokedDigests: state.revokedDigests, nowSeconds: identity.nowSeconds })
    return verified.digest
  }
}
