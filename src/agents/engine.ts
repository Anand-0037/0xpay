import { keccak256, toUtf8Bytes } from 'ethers'
import type { OrderBookSnapshot } from './market'

const SCALE = 1_000_000n
const MAX = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_RECORDS = 500
type Store = Pick<Storage, 'getItem' | 'setItem'>
export type AgentPolicy = {
  allowedMarketIds: string[]; maxOrderMicros: number; sessionBudgetMicros: number; expiresAt: number
  maxSnapshotAgeMs: number; maxSpreadMicros: number; maxPriceMicros: number
}
export type AgentProposal = {
  id: string; createdAt: number; marketId: string; conditionId: string; question: string; tokenId: string
  outcome: string; bookFingerprint: string; thesis: string; estimatedProbabilityMicros: number; stakeMicros: number
}
export type PaperFill = { priceMicros: number; sizeMicros: number; costMicros: number }
export type PaperQuote = {
  spentMicros: number; sharesMicros: number; averagePriceMicros: number; worstPriceMicros: number
  edgeMicros: number; fills: PaperFill[]
}
export type PaperRecord = PaperQuote & {
  mode: 'paper'; id: string; proposalId: string; executedAt: number; marketId: string; question: string
  tokenId: string; outcome: string; estimatedProbabilityMicros: number
}
export type PaperJournalSnapshot = {
  version: 1; sessionId: string | null; createdAt: number | null; stopped: boolean; records: PaperRecord[]; spentMicros: number
}
type Persisted = { version: 1; sessionId: string; createdAt: number; stopped: boolean; records: PaperRecord[] }
export type PolicyEvaluation = { allowed: boolean; reasons: string[]; quote: PaperQuote | null }
type ProposalInput = { book: OrderBookSnapshot; thesis: string; estimatedProbabilityMicros: number; stakeMicros: number }

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function text(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}
function number(value: bigint): number {
  if (value < 0n || value > MAX) throw new Error('Paper calculation exceeds the supported integer range.')
  return Number(value)
}
function ceil(value: bigint, unit: bigint) { return (value + unit - 1n) / unit }
function validateBook(book: OrderBookSnapshot) {
  if (!book || !book.market || !text(book.market.id, 200) || !text(book.market.conditionId, 200) ||
    !text(book.market.question, 2000) || !text(book.tokenId, 200) || !text(book.outcome, 128) ||
    typeof book.market.active !== 'boolean' || typeof book.market.acceptingOrders !== 'boolean' ||
    (book.market.endDate !== null && !text(book.market.endDate, 100)) ||
    !Array.isArray(book.market.outcomes) || book.market.outcomes.length < 2 || book.market.outcomes.length > 8 ||
    book.market.outcomes.some(row => !row || !text(row.tokenId, 200) || !text(row.name, 128)) ||
    new Set(book.market.outcomes.map(row => row.tokenId)).size !== book.market.outcomes.length ||
    !book.market.outcomes.some(row => row.tokenId === book.tokenId && row.name === book.outcome) ||
    !integer(book.fetchedAt, 1) || (book.sourceTimestamp !== null && !integer(book.sourceTimestamp, 1)) ||
    !integer(book.minOrderSizeMicros, 1)) throw new Error('The order book has invalid identity, timestamp or minimum size.')
  for (const [levels, ascending] of [[book.asks, true], [book.bids, false]] as const) {
    if (!Array.isArray(levels) || levels.length > 2000) throw new Error('Unsupported order-book depth.')
    let previous: number | null = null
    for (const level of levels) {
      if (!level || !integer(level.priceMicros, 1, 1_000_000) || !integer(level.sizeMicros, 1) ||
        (previous !== null && (ascending ? level.priceMicros <= previous : level.priceMicros >= previous))) {
        throw new Error('Order-book levels must have positive units and unique sorted prices.')
      }
      previous = level.priceMicros
    }
  }
  if (book.asks.length && book.bids.length && book.bids[0].priceMicros > book.asks[0].priceMicros) {
    throw new Error('The order book is crossed; refresh it before evaluating.')
  }
}
function fingerprint(book: OrderBookSnapshot) {
  return keccak256(toUtf8Bytes(JSON.stringify({ marketId: book.market.id, conditionId: book.market.conditionId,
    question: book.market.question, outcomes: book.market.outcomes,
    active: book.market.active, acceptingOrders: book.market.acceptingOrders, endDate: book.market.endDate,
    tokenId: book.tokenId, outcome: book.outcome, fetchedAt: book.fetchedAt, sourceTimestamp: book.sourceTimestamp,
    minOrderSizeMicros: book.minOrderSizeMicros, asks: book.asks, bids: book.bids })))
}

export function createProposal(input: ProposalInput, now = Date.now()): AgentProposal {
  validateBook(input.book)
  if (!integer(now, 1) || !text(input.thesis, 2000) || !integer(input.estimatedProbabilityMicros, 0, 1_000_000) ||
    !integer(input.stakeMicros, 1)) throw new Error('Enter a thesis, an integer probability and a positive paper stake.')
  return { id: crypto.randomUUID(), createdAt: now, marketId: input.book.market.id, conditionId: input.book.market.conditionId,
    question: input.book.market.question, tokenId: input.book.tokenId, outcome: input.book.outcome,
    bookFingerprint: fingerprint(input.book), thesis: input.thesis.trim(),
    estimatedProbabilityMicros: input.estimatedProbabilityMicros, stakeMicros: input.stakeMicros }
}

/** Walk displayed asks; this simulates available displayed depth, never a venue fill. */
function quotePaper(proposal: AgentProposal, book: OrderBookSnapshot): PaperQuote {
  let remaining = BigInt(proposal.stakeMicros), shares = 0n
  const fills: PaperFill[] = []
  for (const ask of book.asks) {
    if (remaining === 0n) break
    const price = BigInt(ask.priceMicros)
    const affordable = remaining * SCALE / price
    const size = affordable < BigInt(ask.sizeMicros) ? affordable : BigInt(ask.sizeMicros)
    if (size === 0n) continue
    const cost = ceil(size * price, SCALE)
    remaining -= cost; shares += size
    fills.push({ priceMicros: ask.priceMicros, sizeMicros: number(size), costMicros: number(cost) })
  }
  if (remaining !== 0n) throw new Error('Displayed ask depth cannot fill this paper stake. Reduce the stake or refresh.')
  if (shares < BigInt(book.minOrderSizeMicros)) throw new Error('The paper fill is below the market minimum size.')
  const averagePriceMicros = number(ceil(BigInt(proposal.stakeMicros) * SCALE, shares))
  return { spentMicros: proposal.stakeMicros, sharesMicros: number(shares), averagePriceMicros,
    worstPriceMicros: fills[fills.length - 1].priceMicros,
    edgeMicros: proposal.estimatedProbabilityMicros - averagePriceMicros, fills }
}

export function evaluatePolicy(proposal: AgentProposal, book: OrderBookSnapshot, policy: AgentPolicy,
  journal: PaperJournal, now = Date.now(), stopped = false): PolicyEvaluation {
  return assess(proposal, book, policy, journal, now, stopped, false)
}

/** Review-only: a stopped agent can inspect a proposal without resuming execution. */
export function evaluateProposalForReview(proposal: AgentProposal, book: OrderBookSnapshot, policy: AgentPolicy,
  journal: PaperJournal, now = Date.now()): PolicyEvaluation {
  return assess(proposal, book, policy, journal, now, false, true)
}

function assess(proposal: AgentProposal, book: OrderBookSnapshot, policy: AgentPolicy,
  journal: PaperJournal, now: number, stopped: boolean, reviewOnly: boolean): PolicyEvaluation {
  const reasons: string[] = []
  let quote: PaperQuote | null = null
  try {
    validateBook(book)
    if (!integer(now, 1) || !proposal || !text(proposal.id, 100) || !integer(proposal.createdAt, 1) ||
      !text(proposal.thesis, 2000) || !text(proposal.question, 2000) || !integer(proposal.stakeMicros, 1) ||
      !integer(proposal.estimatedProbabilityMicros, 0, 1_000_000)) throw new Error('Invalid paper proposal.')
    if (!Array.isArray(policy.allowedMarketIds) || !policy.allowedMarketIds.every(id => text(id, 200)) ||
      !integer(policy.maxOrderMicros, 1) || !integer(policy.sessionBudgetMicros) || !integer(policy.expiresAt, 1) ||
      !integer(policy.maxSnapshotAgeMs, 1) || !integer(policy.maxSpreadMicros, 0, 1_000_000) ||
      !integer(policy.maxPriceMicros, 1, 1_000_000)) throw new Error('Invalid paper policy limits.')
    const state = journal.snapshot()
    if (!reviewOnly && (stopped || state.stopped)) reasons.push('Paper agent is stopped.')
    if (now >= policy.expiresAt) reasons.push('Paper policy has expired.')
    if (proposal.createdAt > now) reasons.push('Proposal timestamp is in the future.')
    if (state.records.some(record => record.proposalId === proposal.id)) reasons.push('This proposal has already been paper executed.')
    if (!policy.allowedMarketIds.includes(book.market.id)) reasons.push('Market is not on the policy allowlist.')
    if (!book.market.active || !book.market.acceptingOrders) reasons.push('Market is not active and accepting orders.')
    if (book.market.endDate !== null) {
      const end = Date.parse(book.market.endDate)
      if (!Number.isFinite(end) || end <= now) reasons.push('Market expiry is unknown or has passed.')
    }
    if (proposal.marketId !== book.market.id || proposal.conditionId !== book.market.conditionId ||
      proposal.question !== book.market.question || proposal.tokenId !== book.tokenId || proposal.outcome !== book.outcome || proposal.bookFingerprint !== fingerprint(book)) {
      reasons.push('The order book changed. Create a new proposal from the current snapshot.')
    }
    if (book.fetchedAt > now || now - book.fetchedAt > policy.maxSnapshotAgeMs ||
      book.sourceTimestamp === null || book.sourceTimestamp > now || now - book.sourceTimestamp > policy.maxSnapshotAgeMs) {
      reasons.push('The order-book timestamp is missing, stale or in the future.')
    }
    if (proposal.stakeMicros > policy.maxOrderMicros) reasons.push('Paper stake exceeds the per-order limit.')
    if (BigInt(state.spentMicros) + BigInt(proposal.stakeMicros) > BigInt(policy.sessionBudgetMicros)) {
      reasons.push('Paper stake exceeds the remaining session budget.')
    }
    if (!book.asks.length || !book.bids.length) reasons.push('Both ask and bid depth are needed to check price and spread.')
    else {
      if (book.asks[0].priceMicros - book.bids[0].priceMicros > policy.maxSpreadMicros) reasons.push('The live spread exceeds the policy limit.')
      try {
        quote = quotePaper(proposal, book)
        if (quote.worstPriceMicros > policy.maxPriceMicros) reasons.push('The paper fill crosses the maximum buy price.')
        if (quote.edgeMicros <= 0) reasons.push('Your estimated probability does not exceed the depth-weighted ask cost.')
      } catch (cause) { reasons.push(cause instanceof Error ? cause.message : 'The paper fill could not be calculated.') }
    }
  } catch (cause) { reasons.push(cause instanceof Error ? cause.message : 'Paper policy could not be evaluated.') }
  return { allowed: reasons.length === 0 && quote !== null, reasons, quote }
}

function validateRecord(record: unknown): asserts record is PaperRecord {
  if (!record || typeof record !== 'object') throw new Error('Invalid paper record.')
  const value = record as PaperRecord
  if (value.mode !== 'paper' || !text(value.id, 100) || value.id !== value.proposalId || !integer(value.executedAt, 1) ||
    !text(value.marketId, 200) || !text(value.question, 2000) || !text(value.tokenId, 200) || !text(value.outcome, 128) ||
    !integer(value.estimatedProbabilityMicros, 0, 1_000_000) || !integer(value.spentMicros, 1) || !integer(value.sharesMicros, 1) ||
    !integer(value.averagePriceMicros, 1, 1_000_000) || !integer(value.worstPriceMicros, 1, 1_000_000) ||
    !integer(value.edgeMicros, 1, 1_000_000) || value.edgeMicros !== value.estimatedProbabilityMicros - value.averagePriceMicros ||
    !Array.isArray(value.fills) || value.fills.length === 0 || value.fills.length > 2000) throw new Error('Invalid paper record.')
  let cost = 0n, size = 0n, previous = 0
  for (const fill of value.fills) {
    if (!fill || !integer(fill.priceMicros, 1, 1_000_000) || fill.priceMicros <= previous || !integer(fill.sizeMicros, 1) ||
      !integer(fill.costMicros, 1) || BigInt(fill.costMicros) !== ceil(BigInt(fill.priceMicros) * BigInt(fill.sizeMicros), SCALE)) throw new Error('Invalid paper fill.')
    cost += BigInt(fill.costMicros); size += BigInt(fill.sizeMicros); previous = fill.priceMicros
  }
  if (cost !== BigInt(value.spentMicros) || size !== BigInt(value.sharesMicros) ||
    value.averagePriceMicros !== number(ceil(cost * SCALE, size)) || value.worstPriceMicros !== previous) throw new Error('Paper record totals do not match its fills.')
}

const localLocks = new Map<string, Promise<unknown>>()
async function exclusive<T>(key: string, action: () => T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(`0xpay:${key}`, action)
  if (typeof window !== 'undefined') throw new Error('This browser cannot coordinate a safe paper journal. Use a browser with Web Locks support.')
  const previous = localLocks.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(action)
  localLocks.set(key, pending)
  try { return await pending }
  finally { if (localLocks.get(key) === pending) localLocks.delete(key) }
}

/** Local non-secret paper ledger. It is not a wallet, settlement record or tamper-proof audit log. */
export class PaperJournal {
  private readonly storage: Store
  private readonly key: string
  private stopRequested = false
  private stopEpoch = 0
  private expectedSessionId: string | null = null
  constructor(storage: Store, key = '0xpay-paper-agent-v1') {
    if (!text(key, 100)) throw new Error('Invalid paper journal key.')
    this.storage = storage; this.key = key
  }
  snapshot(): PaperJournalSnapshot {
    try {
      const raw = this.storage.getItem(this.key), marker = this.storage.getItem(`${this.key}:initialized`)
      if (raw === null && marker === null && this.expectedSessionId === null) return { version: 1, sessionId: null, createdAt: null, stopped: this.stopRequested, records: [], spentMicros: 0 }
      if (raw === null || !text(marker, 100) || raw.length > 2_000_000) throw new Error('Paper journal is incomplete.')
      const data = JSON.parse(raw) as Persisted
      if (!data || data.version !== 1 || data.sessionId !== marker ||
        (this.expectedSessionId !== null && this.expectedSessionId !== data.sessionId) || !integer(data.createdAt, 1) ||
        typeof data.stopped !== 'boolean' || !Array.isArray(data.records) || data.records.length > MAX_RECORDS) throw new Error('Invalid paper journal.')
      let spent = 0n
      const seen = new Set<string>()
      for (const record of data.records) {
        validateRecord(record)
        if (seen.has(record.proposalId)) throw new Error('Duplicate paper record.')
        seen.add(record.proposalId); spent += BigInt(record.spentMicros)
      }
      this.expectedSessionId = data.sessionId
      return { version: 1, sessionId: data.sessionId, createdAt: data.createdAt, stopped: data.stopped || this.stopRequested,
        records: data.records, spentMicros: number(spent) }
    } catch { throw new Error('Paper journal is unreadable or inconsistent. Execution stopped; the budget was not reset.') }
  }
  private save(state: PaperJournalSnapshot, now: number) {
    const data: Persisted = { version: 1, sessionId: state.sessionId ?? crypto.randomUUID(), createdAt: state.createdAt ?? now,
      stopped: state.stopped, records: state.records }
    // Marker first: an interrupted first write must not look like a fresh zero-budget journal.
    const raw = JSON.stringify(data)
    try {
      this.storage.setItem(`${this.key}:initialized`, data.sessionId)
      this.storage.setItem(this.key, raw)
      if (this.storage.getItem(this.key) !== raw || this.storage.getItem(`${this.key}:initialized`) !== data.sessionId) throw new Error('Unverified write.')
      this.snapshot()
    } catch { throw new Error('Paper journal write could not be verified. Check recorded state before retrying; the budget was not reset.') }
  }
  async setStopped(stopped: boolean): Promise<void> {
    if (typeof stopped !== 'boolean') throw new Error('Invalid paper stop state.')
    if (stopped) { this.stopRequested = true; this.stopEpoch++ }
    const epoch = this.stopEpoch
    await exclusive(this.key, () => {
      const state = this.snapshot(); this.save({ ...state, stopped }, Date.now())
      if (!stopped && epoch === this.stopEpoch) this.stopRequested = false
    })
  }
  async execute(proposal: AgentProposal, book: OrderBookSnapshot, policy: AgentPolicy, now: number | undefined, stopped: boolean): Promise<PaperRecord> {
    const epoch = this.stopEpoch
    return exclusive(this.key, () => {
      if (epoch !== this.stopEpoch) throw new Error('Paper agent was stopped while this execution was waiting. Review a new proposal.')
      // The real clock is sampled after the lock, not when an execution joins a queue.
      const executedAt = now ?? Date.now()
      const evaluation = evaluatePolicy(proposal, book, policy, this, executedAt, stopped)
      if (!evaluation.allowed || !evaluation.quote) throw new Error(evaluation.reasons.join(' ') || 'Paper execution was rejected.')
      const state = this.snapshot()
      if (state.records.length >= MAX_RECORDS) throw new Error('Paper journal record limit reached. Execution stopped without resetting the budget.')
      const record: PaperRecord = { ...evaluation.quote, mode: 'paper', id: proposal.id, proposalId: proposal.id,
        executedAt, marketId: proposal.marketId, question: proposal.question, tokenId: proposal.tokenId,
        outcome: proposal.outcome, estimatedProbabilityMicros: proposal.estimatedProbabilityMicros }
      validateRecord(record)
      this.save({ ...state, records: [...state.records, record] }, executedAt)
      return record
    })
  }
}

export function executePaper(proposal: AgentProposal, book: OrderBookSnapshot, policy: AgentPolicy,
  journal: PaperJournal, now?: number, stopped = false): Promise<PaperRecord> {
  return journal.execute(proposal, book, policy, now, stopped)
}
