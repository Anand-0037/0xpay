import { AbiCoder, TypedDataEncoder, ZeroAddress, getAddress, keccak256, verifyTypedData, type TypedDataDomain, type TypedDataField } from 'ethers'

/** An offchain PAPER policy, not a token allowance, venue order or signing key.
 * The owner can still use their own wallet. The agent receives no signer.
 * EIP-712 domain/types: https://eips.ethereum.org/EIPS/eip-712
 * Encoding/recovery: https://docs.ethers.org/v6/api/hashing/#verifyTypedData
 */
export type AgentMandate = Readonly<{
  version: 1; sessionId: string; nonce: string; owner: string; watchedAccount: string; chainId: 137
  agentId: string; agentName: string; allowedMarketIds: readonly string[]
  budgetMicros: number; maxOrderMicros: number; maxPriceMicros: number; maxSpreadMicros: number
  maxOutcomeSharesMicros: number; expiresAt: number; canSignTransactions: false
}>
export type SignedAgentMandate = Readonly<{ domain: TypedDataDomain; payload: AgentMandate; signature: string }>
export type MandateActionContext = Readonly<{
  chainId: number; owner: string; watchedAccount: string; sessionId: string; nonce: string; agentId: string
  action: 'paper-execute'; marketId: string; cumulativeSpendMicros: number; spendMicros: number
  /** Highest price of any proposed fill, not its average. */
  priceMicros: number; spreadMicros: number; combinedOutcomeSharesMicros: bigint
  revokedDigests: ReadonlySet<string>; nowSeconds?: number
}>
export const MAX_MANDATE_LIFETIME_SECONDS = 24 * 60 * 60
const FIELDS = ['version', 'sessionId', 'nonce', 'owner', 'watchedAccount', 'chainId', 'agentId', 'agentName', 'allowedMarketIds', 'budgetMicros', 'maxOrderMicros', 'maxPriceMicros', 'maxSpreadMicros', 'maxOutcomeSharesMicros', 'expiresAt', 'canSignTransactions']
const DOMAIN = Object.freeze({ name: '0xPay Agent Mandate', version: '1', chainId: 137 })
const NONCE = /^0x[0-9a-f]{64}$/
const DIGEST = /^0x[0-9a-f]{64}$/i
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const TYPES: Record<string, TypedDataField[]> = { PaperAgentMandate: [
  { name: 'version', type: 'uint8' }, { name: 'sessionId', type: 'string' }, { name: 'nonce', type: 'bytes32' },
  { name: 'owner', type: 'address' }, { name: 'watchedAccount', type: 'address' }, { name: 'chainId', type: 'uint256' }, { name: 'agentId', type: 'string' },
  { name: 'agentName', type: 'string' }, { name: 'allowedMarketsHash', type: 'bytes32' },
  { name: 'budgetMicros', type: 'uint256' }, { name: 'maxOrderMicros', type: 'uint256' }, { name: 'maxPriceMicros', type: 'uint32' },
  { name: 'maxSpreadMicros', type: 'uint32' }, { name: 'maxOutcomeSharesMicros', type: 'uint256' },
  { name: 'expiresAt', type: 'uint64' }, { name: 'canSignTransactions', type: 'bool' },
] }

function reject(message: string): never { throw new Error(`Agent mandate: ${message}`) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject('expected a plain object.')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  const keys = Object.keys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) reject('unexpected or missing fields.')
}
function units(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return reject(`invalid ${label}.`)
  return value
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) return reject(`invalid ${label}.`)
  return value
}
function owner(value: unknown): string {
  try {
    if (typeof value !== 'string') return reject('invalid owner.')
    const address = getAddress(value)
    if (address === ZeroAddress) return reject('owner must not be zero.')
    return address
  } catch { return reject('invalid owner.') }
}
function nonce(value: unknown): string {
  if (typeof value !== 'string' || !NONCE.test(value) || value === `0x${'0'.repeat(64)}`) return reject('invalid nonce.')
  return value
}
function payload(value: unknown, canonical: boolean): AgentMandate {
  const input = record(value); exact(input, FIELDS)
  if (input.version !== 1 || input.chainId !== 137 || input.canSignTransactions !== false) reject('only version 1 Polygon paper policy with no signing authority is supported.')
  if (typeof input.agentName !== 'string' || input.agentName.trim() !== input.agentName || !input.agentName || input.agentName.length > 80 ||
    [...input.agentName].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) reject('invalid agent name.')
  if (!Array.isArray(input.allowedMarketIds) || !input.allowedMarketIds.length || input.allowedMarketIds.length > 32) reject('choose between one and 32 exact market IDs.')
  const markets = Array.from(input.allowedMarketIds, value => id(value, 'market ID'))
  const sorted = [...markets].sort()
  if (new Set(markets).size !== markets.length || canonical && markets.some((value, index) => value !== sorted[index])) reject('market IDs must be unique and canonically sorted.')
  return Object.freeze({ version: 1, sessionId: id(input.sessionId, 'session ID'), nonce: nonce(input.nonce), owner: owner(input.owner), watchedAccount: owner(input.watchedAccount), chainId: 137,
    agentId: id(input.agentId, 'agent ID'), agentName: input.agentName, allowedMarketIds: Object.freeze(sorted),
    budgetMicros: units(input.budgetMicros, 'budget', 1), maxOrderMicros: units(input.maxOrderMicros, 'per-order limit', 1),
    maxPriceMicros: units(input.maxPriceMicros, 'maximum price', 1, 1_000_000), maxSpreadMicros: units(input.maxSpreadMicros, 'maximum spread', 0, 1_000_000),
    maxOutcomeSharesMicros: units(input.maxOutcomeSharesMicros, 'outcome share cap', 1),
    expiresAt: units(input.expiresAt, 'expiry seconds', 1), canSignTransactions: false })
}
function currentTime(now = Math.floor(Date.now() / 1000)) { return units(now, 'current time seconds', 1) }
function checkTime(value: AgentMandate, now: number) {
  if (value.expiresAt <= now) reject('policy expired.')
  if (value.expiresAt - now > MAX_MANDATE_LIFETIME_SECONDS) reject('expiry exceeds the 24-hour policy window.')
}

/** Sorts the exact market preimage without trimming, lowercasing or deduplicating IDs. */
export function createAgentMandate(input: unknown, nowSeconds?: number): AgentMandate {
  const result = payload(input, false); checkTime(result, currentTime(nowSeconds)); return result
}

/** The signature binds the canonical list through keccak256(abi.encode(string[])).
 * Retain/display payload.allowedMarketIds before wallet approval: its hash alone
 * is not a usable human review. There is intentionally no verifyingContract.
 */
export function agentMandateTypedData(input: unknown) {
  const value = payload(input, true)
  const { allowedMarketIds, ...fields } = value
  return { domain: { ...DOMAIN }, primaryType: 'PaperAgentMandate' as const,
    types: { PaperAgentMandate: TYPES.PaperAgentMandate.map(field => ({ ...field })) },
    message: { ...fields, allowedMarketsHash: keccak256(AbiCoder.defaultAbiCoder().encode(['string[]'], [allowedMarketIds])) } }
}
export function agentMandateDigest(input: unknown): string {
  const typed = agentMandateTypedData(input)
  return TypedDataEncoder.hash(typed.domain, typed.types, typed.message)
}

/** EOA signatures only; smart-contract/EIP-1271 wallets are not supported here.
 * A policy is reusable within its session. The caller supplies trusted durable
 * cumulative spend/current nonce/revocations and must recheck atomically with
 * its journal write. This pure verifier cannot stop a caller inventing state.
 */
export function validateSignedAgentMandate(envelope: unknown, nowSeconds?: number) {
  const signed = record(envelope); exact(signed, ['domain', 'payload', 'signature'])
  const domain = record(signed.domain); exact(domain, ['name', 'version', 'chainId'])
  if (domain.name !== DOMAIN.name || domain.version !== DOMAIN.version || domain.chainId !== DOMAIN.chainId) reject('wrong signing domain.')
  const value = payload(signed.payload, true)
  // Storage inspection may retain an expired signature for display/revocation.
  // Action verification below ALWAYS supplies the actual current time.
  if (nowSeconds !== undefined) checkTime(value, currentTime(nowSeconds))
  if (typeof signed.signature !== 'string' || !/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i.test(signed.signature)) reject('invalid signature.')
  const typed = agentMandateTypedData(value)
  let recovered: string
  try { recovered = getAddress(verifyTypedData(typed.domain, typed.types, typed.message, signed.signature)) }
  catch { return reject('invalid signature.') }
  if (recovered !== value.owner) reject('signature does not recover the owner.')
  return Object.freeze({ digest: agentMandateDigest(value), owner: recovered, policy: value })
}

export function verifySignedAgentMandate(envelope: unknown, context: MandateActionContext) {
  const verified = validateSignedAgentMandate(envelope, currentTime(context.nowSeconds)), value = verified.policy
  if (context.chainId !== 137 || context.chainId !== value.chainId) reject('wrong current chain.')
  if (context.action !== 'paper-execute') reject('only paper execution is authorized.')
  if (owner(context.owner) !== value.owner || owner(context.watchedAccount) !== value.watchedAccount || id(context.agentId, 'current agent ID') !== value.agentId ||
    id(context.sessionId, 'current session ID') !== value.sessionId || nonce(context.nonce) !== value.nonce) reject('owner, agent or session does not match.')
  if (!value.allowedMarketIds.includes(id(context.marketId, 'current market ID'))) reject('market is not allowed.')
  const spent = units(context.cumulativeSpendMicros, 'cumulative spend'), next = units(context.spendMicros, 'proposed spend', 1)
  if (next > value.maxOrderMicros) reject('per-order paper limit exceeded.')
  if (BigInt(spent) + BigInt(next) > BigInt(value.budgetMicros)) reject('cumulative paper budget exceeded.')
  if (units(context.priceMicros, 'proposed price', 1, 1_000_000) > value.maxPriceMicros) reject('maximum paper price exceeded.')
  if (units(context.spreadMicros, 'proposed spread', 0, 1_000_000) > value.maxSpreadMicros) reject('maximum paper spread exceeded.')
  if (typeof context.combinedOutcomeSharesMicros !== 'bigint' || context.combinedOutcomeSharesMicros < 0n ||
    context.combinedOutcomeSharesMicros > BigInt(value.maxOutcomeSharesMicros)) reject('combined outcome share cap exceeded.')
  const digest = verified.digest
  if (!(context.revokedDigests instanceof Set)) reject('a local revocation set is required.')
  for (const revoked of context.revokedDigests) {
    if (typeof revoked !== 'string' || !DIGEST.test(revoked)) reject('invalid revoked digest.')
    if (revoked.toLowerCase() === digest) reject('policy was locally revoked.')
  }
  return Object.freeze({ ...verified, remainingBudgetMicros: value.budgetMicros - spent - next })
}
