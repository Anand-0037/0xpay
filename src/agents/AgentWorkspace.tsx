import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PrivateRpc } from '../rpc'
import { loadMarkets, loadOrderBook, buildPublicMarketEvidence, type MarketSummary, type OrderBookSnapshot, type PublicMarketFetcher } from './market'
import { createProposal, evaluatePolicy, evaluateProposalForReview, executePaper, PaperJournal, type AgentPolicy, type AgentProposal, type PaperQuote, type OutcomeExposureContext } from './engine'
import { checkAgentPrivateRoute } from './route-check'
import { readPredictionPreflight, type PredictionPreflight } from './preflight'
import { requestPublicResearch, type PublicResearchResult, type PublicResearchSource } from './research-client'

type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'> & Partial<Pick<PrivateRpc, 'fetchPublicMarket'>>
type Props = { route: Route | null; routeGeneration: number; onReconnect: () => void }
type RouteCheck = { route: Route; generation: number; blockNumber: number }
type Prepared = { proposal: AgentProposal; policy: AgentPolicy; reasons: string[]; allowed: boolean; quote: PaperQuote | null }
type AccountSnapshot = { value: PredictionPreflight; route: Route; generation: number; tokenId: string; input: string; checkedAt: number }
type ResearchSnapshot = { market: MarketSummary; tokenId: string; sources: PublicResearchSource[]; result: PublicResearchResult; completedAt: number }
type ResearchService = { status: 'unknown' } | { status: 'error' } | { status: 'ready'; configured: boolean; jobsRemaining: number; jobLimit: number }
type Draft = { thesis: string; probability: string; stake: string; budget: string; expiry: string; maxPrice: string; maxSpread: string; maxExposure: string }
const INITIAL_DRAFT: Draft = { thesis: '', probability: '', stake: '5', budget: '20', expiry: '30', maxPrice: '70', maxSpread: '5', maxExposure: '50' }
const INTERVAL_MS = 30_000
const ACCOUNT_MAX_AGE_MS = 90_000
const RESEARCH_MAX_AGE_MS = 10 * 60_000
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`
const percent = (micros: number) => `${(micros / 10_000).toFixed(1)}%`
const shares = (micros: number) => (micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 4 })
const causeMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'This action could not be completed.'
function privateMarketFetcher(route: Route): PublicMarketFetcher {
  return async (url, signal) => {
    if (route.status !== 'ready' || typeof route.fetchPublicMarket !== 'function') throw new Error('The private market transport is unavailable. Reconnect before loading venue data.')
    return route.fetchPublicMarket(url, signal)
  }
}
function tokenUnits(value: bigint, decimals: number) {
  const unit = 10n ** BigInt(decimals)
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / unit}${fraction ? `.${fraction}` : ''}`
}
function probabilityInput(value: number) {
  const fraction = String(value % 10_000).padStart(4, '0').replace(/0+$/, '')
  return `${Math.floor(value / 10_000)}${fraction ? `.${fraction}` : ''}`
}
function researchFresh(snapshot: ResearchSnapshot, now = Date.now()) {
  return now >= snapshot.completedAt && now < researchDeadline(snapshot) && snapshot.sources.every(source => source.retrievedAt <= now)
}
function researchDeadline(snapshot: ResearchSnapshot) {
  return Math.min(snapshot.completedAt + RESEARCH_MAX_AGE_MS, ...snapshot.sources.map(source => source.retrievedAt + RESEARCH_MAX_AGE_MS))
}
function exposureContext(snapshot: AccountSnapshot): OutcomeExposureContext {
  return { chainId: snapshot.value.chainId, tokenId: snapshot.value.tokenId, balanceUnits: snapshot.value.outcomeBalance, decimals: snapshot.value.outcomeDecimals,
    checkedAt: snapshot.checkedAt, blockNumber: snapshot.value.blockNumber, blockHash: snapshot.value.blockHash }
}

function parseUnits(input: string, precision: number, label: string) {
  if (input.length > 32) throw new Error(`${label} is too large.`)
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${precision}})?$`).test(input.trim())) throw new Error(`Enter a valid ${label}.`)
  const [whole, fraction = ''] = input.trim().split('.')
  const scaled = BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0') || '0')
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is too large.`)
  return Number(scaled)
}

function inputsFor(draft: Draft, market: MarketSummary) {
  const probability = parseUnits(draft.probability, 4, 'probability')
  const hundredthsOfMinute = parseUnits(draft.expiry, 2, 'expiry')
  if (probability < 0 || probability > 1_000_000) throw new Error('Your probability must be from 0% to 100%.')
  if (hundredthsOfMinute < 100 || hundredthsOfMinute > 144_000) throw new Error('Choose an expiry between 1 and 1,440 minutes.')
  return { probability, stake: parseUnits(draft.stake, 6, 'paper stake'), policy: {
    allowedMarketIds: [market.id], maxOrderMicros: parseUnits(draft.stake, 6, 'paper stake'),
    sessionBudgetMicros: parseUnits(draft.budget, 6, 'paper budget'), expiresAt: Date.now() + hundredthsOfMinute * 600,
    maxSnapshotAgeMs: 90_000, maxSpreadMicros: parseUnits(draft.maxSpread, 4, 'maximum spread'),
    maxPriceMicros: parseUnits(draft.maxPrice, 4, 'maximum price'),
    maxOutcomeSharesMicros: parseUnits(draft.maxExposure, 6, 'combined outcome share cap'),
  } satisfies AgentPolicy }
}

function ResearchOutput({ snapshot, adopted, onAdopt, disabled }: { snapshot: ResearchSnapshot; adopted: boolean; onAdopt: () => void; disabled: boolean }) {
  const { result, sources } = snapshot
  const canAdopt = researchFresh(snapshot) && result.skeptic.verdict === 'review' && result.researcher.estimatedProbabilityMicros !== null && result.researcher.thesis !== null
  const links = (ids: string[]) => <div className="agent-research-citations" aria-label="Cited retrieved sources">{ids.map(id => {
    const source = sources.find(source => source.id === id)!
    return <a key={id} href={source.url} title={`Retrieved ${new Date(source.retrievedAt).toLocaleString()}. Opens outside the private route.`} target="_blank" rel="noopener noreferrer">{id} ↗</a>
  })}</div>
  return <div className="agent-research-output" aria-live="polite">
    <section><h3>Researcher</h3><p>{result.researcher.summary}</p>{result.researcher.thesis && <p><strong>Thesis:</strong> {result.researcher.thesis}</p>}
      <p><strong>Model estimate:</strong> {result.researcher.estimatedProbabilityMicros === null ? 'No probability estimate supplied.' : percent(result.researcher.estimatedProbabilityMicros)} · Not a guarantee.</p>{links(result.researcher.citations)}</section>
    <section><h3>Skeptic</h3><p className="agent-research-verdict">{result.skeptic.verdict === 'abstain' ? 'Abstain — evidence is not sufficient.' : 'Human review requested — not permission to trade.'}</p>
      {result.skeptic.counterpoints.length > 0 && <><h4>Counterpoints</h4><ul>{result.skeptic.counterpoints.map((point, index) => <li key={index}>{point}</li>)}</ul></>}
      {result.skeptic.resolutionAmbiguities.length > 0 && <><h4>Resolution ambiguities</h4><ul>{result.skeptic.resolutionAmbiguities.map((point, index) => <li key={index}>{point}</li>)}</ul></>}{links(result.skeptic.citations)}</section>
    <button className="agent-quiet-button" type="button" disabled={disabled || !canAdopt || adopted} onClick={onAdopt}>{adopted ? 'Research adopted for paper review' : 'Use this research for paper review'}</button>
    <p className="agent-card-intro">This copies only the thesis and probability into the paper form. Your stake, budget, price, spread and exposure limits stay unchanged. No order is placed.</p>
    {!canAdopt && <p className="agent-research-hold">A fresh result, a non-null thesis and probability, and the skeptic’s review verdict are required. An abstention cannot become a model-driven proposal.</p>}
    <details className="agent-research-evidence"><summary>Sources, request IDs & privacy</summary><p>Model: <code>{result.model}</code> · Requested provider tier: private. The application proxy sees plaintext. Research is not routed through Anon-RPC.</p>
      <ol>{sources.map(source => <li key={source.id}><strong>{source.id}</strong> <a href={source.url} target="_blank" rel="noopener noreferrer">{new URL(source.url).hostname} ↗</a><p>Retrieved {new Date(source.retrievedAt).toLocaleString()}. This link opens outside the private route.</p><details><summary>Retrieved evidence text</summary><pre>{source.text}</pre></details></li>)}</ol>
      {result.receipts.map(receipt => <div className="agent-research-receipt" key={receipt.role}><h4>{receipt.role === 'researcher' ? 'Researcher' : 'Skeptic'} evidence</h4><dl>
        {receipt.requestId && <div><dt>Request ID</dt><dd><code>{receipt.requestId}</code></dd></div>}{receipt.responseKey && <div><dt>Response key</dt><dd><code>{receipt.responseKey}</code></dd></div>}{receipt.completionId && <div><dt>Completion ID</dt><dd><code>{receipt.completionId}</code></dd></div>}
        <div><dt>TEE signature</dt><dd>{receipt.routerTeeVerified === true ? 'Router reports verified' : 'Verification not reported'}</dd></div></dl></div>)}
      <p>This app has not independently verified provider signatures. Source text is retrieved venue data, not independently validated news. Repricing the paper quote does not update these cited snapshots. Evidence expires after ten minutes; model outputs cannot change wallet keys or risk limits.</p>
    </details>
  </div>
}

export function AgentWorkspace(props: Props) {
  return <AgentWorkspaceForRoute {...props} />
}

function AgentWorkspaceForRoute({ route, routeGeneration, onReconnect }: Props) {
  const [markets, setMarkets] = useState<MarketSummary[]>([])
  const [marketLoading, setMarketLoading] = useState(true)
  const [marketError, setMarketError] = useState('')
  const [search, setSearch] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState('')
  const [outcomeIndex, setOutcomeIndex] = useState(0)
  const [bookResult, setBookResult] = useState<{ tokenId: string; book: OrderBookSnapshot } | null>(null)
  const [bookError, setBookError] = useState('')
  const [bookLoading, setBookLoading] = useState(false)
  const [bookRefresh, setBookRefresh] = useState(0)
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [formError, setFormError] = useState('')
  const [routeCheck, setRouteCheck] = useState<RouteCheck | null>(null)
  const [routeError, setRouteError] = useState('')
  const [running, setRunning] = useState(false)
  const [runMessage, setRunMessage] = useState('Choose a market and prepare your first proposal.')
  const [journalResult] = useState(() => {
    try {
      const journal = new PaperJournal(window.localStorage)
      return { journal, initialLedger: journal.snapshot(), error: '' }
    } catch (cause) { return { journal: null, initialLedger: null, error: causeMessage(cause) } }
  })
  const [ledger, setLedger] = useState(journalResult.initialLedger)
  const [watchAddress, setWatchAddress] = useState('')
  const [watchResult, setWatchResult] = useState<AccountSnapshot | null>(null)
  const [watchError, setWatchError] = useState('')
  const [watchLoading, setWatchLoading] = useState(false)
  const [proposalMode, setProposalMode] = useState<'model' | 'manual'>('model')
  const [researchService, setResearchService] = useState<ResearchService>({ status: 'unknown' })
  const [serviceRefresh, setServiceRefresh] = useState(0)
  const [research, setResearch] = useState<ResearchSnapshot | null>(null)
  const [adoptedResearch, setAdoptedResearch] = useState<ResearchSnapshot | null>(null)
  const [researchLoading, setResearchLoading] = useState(false)
  const [researchError, setResearchError] = useState('')
  const active = useRef(true)
  const epoch = useRef(0)
  const runAbort = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchEpoch = useRef(0)
  const latestAccount = useRef<AccountSnapshot | null>(null)
  const researchEpoch = useRef(0)
  const researchAbort = useRef<AbortController | null>(null)
  const routeIdentity = useRef({ route, generation: routeGeneration })
  const completedCatalogue = useRef<number | null>(null)
  const completedBook = useRef<{ market: MarketSummary; tokenId: string; refresh: number } | null>(null)
  const market = markets.find(item => item.id === selectedId) ?? null
  const selectedToken = market?.outcomes[outcomeIndex]?.tokenId
  const book = bookResult && bookResult.tokenId === selectedToken && bookResult.book.market === market ? bookResult.book : null
  const privateReady = route?.status === 'ready' && routeCheck?.route === route && routeCheck.generation === routeGeneration
  const privateMarketReady = routeGeneration >= 0 && route?.status === 'ready' && typeof route.fetchPublicMarket === 'function'
  const accountContext = privateReady && watchResult?.route === route && watchResult.generation === routeGeneration &&
    watchResult.tokenId === selectedToken && watchResult.input === watchAddress.trim().toLowerCase() ? watchResult : null
  const currentResearch = research?.market === market && research.tokenId === selectedToken ? research : null
  const modelReady = currentResearch !== null && adoptedResearch === currentResearch && researchFresh(currentResearch) &&
    currentResearch.result.skeptic.verdict === 'review' && currentResearch.result.researcher.estimatedProbabilityMicros !== null && currentResearch.result.researcher.thesis !== null

  useLayoutEffect(() => {
    routeIdentity.current = { route, generation: routeGeneration }
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Invalidate live request counters before any queued paper commit can run.
      epoch.current++; watchEpoch.current++
      latestAccount.current = null
      runAbort.current?.abort(); runAbort.current = null
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Cancel the current scheduled cycle on a route lifecycle change.
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      void journalResult.journal?.setStopped(true).catch(() => {})
      queueMicrotask(() => {
        if (!active.current) return
        setRunning(false); setWatchResult(null); setWatchLoading(false); setWatchError(''); setPrepared(null); setRouteCheck(null); setRouteError('')
        setRunMessage('Private connection changed. Re-read the selected position before continuing. Public research is preserved.')
      })
    }
  }, [route, routeGeneration, route?.status, journalResult])

  useEffect(() => {
    active.current = true
    return () => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- These are current request counters, not DOM refs; invalidate every outstanding request on unmount.
      active.current = false; researchEpoch.current++
      researchAbort.current?.abort()
    }
  }, [journalResult])

  useEffect(() => {
    const abort = new AbortController()
    let current = true
    const timer = setTimeout(() => abort.abort(), 15_000)
    void fetch('/api/status', { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: abort.signal })
      .then(async response => {
        if (!response.ok || response.redirected) throw new Error('Research service unavailable')
        const body: unknown = await response.json()
        if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'ok' || !('provider' in body) || body.provider !== '0g' ||
          !('configured' in body) || typeof body.configured !== 'boolean' || !('providerTrustMode' in body) || body.providerTrustMode !== 'private' ||
          !('proxySeesPlaintext' in body) || body.proxySeesPlaintext !== true || !('jobsRemaining' in body) || !Number.isSafeInteger(body.jobsRemaining) ||
          typeof body.jobsRemaining !== 'number' || body.jobsRemaining < 0 || !('jobLimit' in body) || !Number.isSafeInteger(body.jobLimit) ||
          typeof body.jobLimit !== 'number' || body.jobLimit < body.jobsRemaining) throw new Error('Invalid research service status')
        if (current && !abort.signal.aborted) setResearchService({ status: 'ready', configured: body.configured, jobsRemaining: body.jobsRemaining, jobLimit: body.jobLimit })
      }).catch(() => { if (current) setResearchService({ status: 'error' }) }).finally(() => clearTimeout(timer))
    return () => { current = false; abort.abort(); clearTimeout(timer) }
  }, [serviceRefresh])

  useEffect(() => {
    if (!route || !privateMarketReady || completedCatalogue.current === refresh) return
    const abort = new AbortController()
    queueMicrotask(() => { if (!abort.signal.aborted) { setMarketLoading(true); setMarketError('') } })
    void loadMarkets(abort.signal, privateMarketFetcher(route)).then(rows => {
      if (!abort.signal.aborted) { completedCatalogue.current = refresh; setMarkets(rows); setMarketLoading(false); setMarketError('') }
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) { setMarkets([]); setMarketLoading(false); setMarketError(causeMessage(cause)) }
    })
    return () => abort.abort()
  }, [refresh, route, privateMarketReady, routeGeneration])

  useEffect(() => {
    let cancelled = false
    if (!route || route.status !== 'ready') return
    void checkAgentPrivateRoute(route).then(check => {
      if (!cancelled && route.status === 'ready') { setRouteCheck({ route, generation: routeGeneration, blockNumber: check.blockNumber }); setRouteError('') }
    }).catch((cause: unknown) => { if (!cancelled) setRouteError(causeMessage(cause)) })
    return () => { cancelled = true }
  }, [route, routeGeneration])

  useEffect(() => {
    if (!market || !selectedToken || !route || !privateMarketReady) return
    if (bookResult?.book.market === market && bookResult.tokenId === selectedToken && completedBook.current?.refresh === bookRefresh) return
    const abort = new AbortController()
    queueMicrotask(() => { if (!abort.signal.aborted) { setBookLoading(true); setBookError('') } })
    void loadOrderBook(market, outcomeIndex, abort.signal, privateMarketFetcher(route)).then(snapshot => {
      if (!abort.signal.aborted) { completedBook.current = { market, tokenId: snapshot.tokenId, refresh: bookRefresh }; setBookResult({ tokenId: snapshot.tokenId, book: snapshot }); setBookLoading(false); setBookError('') }
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) { setBookResult(null); setBookLoading(false); setBookError(causeMessage(cause)) }
    })
    return () => abort.abort()
  }, [market, outcomeIndex, selectedToken, bookRefresh, bookResult, route, privateMarketReady, routeGeneration])

  function selectMarket(value: string) {
    if (!privateMarketReady) return
    clearResearch()
    invalidateAccount()
    setSelectedId(value); setOutcomeIndex(0); setBookResult(null); setBookError(''); setBookLoading(true); setPrepared(null); setFormError('')
  }
  function invalidateAccount() {
    watchEpoch.current++; latestAccount.current = null; setWatchResult(null); setWatchError(''); setWatchLoading(false); setPrepared(null)
    // stop() invalidates pending work synchronously before its first await.
    if (running || runAbort.current) void stop()
  }
  function reloadMarkets() {
    if (!privateMarketReady) return
    clearResearch()
    invalidateAccount(); setMarkets([]); setSelectedId(''); setBookResult(null); setPrepared(null)
    setMarketLoading(true); setMarketError(''); setRefresh(value => value + 1)
  }
  function clearResearch() {
    researchEpoch.current++; researchAbort.current?.abort(); researchAbort.current = null
    setResearch(null); setAdoptedResearch(null); setResearchLoading(false); setResearchError(''); setPrepared(null)
    if (proposalMode === 'model') setDraft(previous => ({ ...previous, thesis: '', probability: '' }))
  }
  function chooseProposalMode(next: 'model' | 'manual') {
    if (running || next === proposalMode) return
    setProposalMode(next); setAdoptedResearch(null); setPrepared(null); setFormError('')
    setDraft(previous => ({ ...previous, thesis: '', probability: '' }))
  }
  async function runResearch() {
    if (!market || !book || !selectedToken || researchLoading || running || researchService.status !== 'ready' || !researchService.configured || researchService.jobsRemaining < 1) return
    clearResearch()
    const request = ++researchEpoch.current, controller = new AbortController(), sourceMarket = market, sourceBook = book, tokenId = selectedToken
    researchAbort.current = controller
    const current = () => active.current && researchEpoch.current === request && !controller.signal.aborted
    setResearchLoading(true)
    try {
      const sources = await buildPublicMarketEvidence(sourceMarket, sourceBook)
      if (!current()) return
      // Only public venue facts and retrieved sources cross this boundary.
      // No account context, balances, thesis draft, risk limits or wallet object.
      const result = await requestPublicResearch({ marketId: sourceMarket.id, question: sourceMarket.question,
        outcomes: sourceMarket.outcomes.map(outcome => outcome.name), selectedOutcome: sourceBook.outcome }, sources, { signal: controller.signal })
      if (!current()) return
      setResearch({ market: sourceMarket, tokenId, sources, result, completedAt: Date.now() })
    } catch (cause) { if (current()) setResearchError(causeMessage(cause)) }
    finally { if (current()) { setResearchLoading(false); researchAbort.current = null; setServiceRefresh(value => value + 1) } }
  }
  function cancelResearch() {
    researchEpoch.current++; researchAbort.current?.abort(); researchAbort.current = null
    setResearchLoading(false); setResearchError('Research cancelled. No model result was accepted.')
  }
  function adoptResearch() {
    if (!currentResearch || !researchFresh(currentResearch) || currentResearch.result.skeptic.verdict !== 'review' ||
      currentResearch.result.researcher.estimatedProbabilityMicros === null || !currentResearch.result.researcher.thesis || running) return
    setProposalMode('model'); setAdoptedResearch(currentResearch); setPrepared(null); setFormError('')
    setDraft(previous => ({ ...previous, thesis: currentResearch.result.researcher.thesis!,
      probability: probabilityInput(currentResearch.result.researcher.estimatedProbabilityMicros!) }))
  }
  function editDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (proposalMode === 'model' && (key === 'thesis' || key === 'probability')) return
    setDraft(previous => ({ ...previous, [key]: value })); setPrepared(null); setFormError('')
  }
  function prepare() {
    setFormError(''); setPrepared(null)
    try {
      if (!market || !book || !journalResult.journal) throw new Error('Load a market and a live order book first.')
      if (!accountContext || Date.now() - accountContext.checkedAt > ACCOUNT_MAX_AGE_MS) throw new Error('Read a fresh selected-outcome position through the private route first.')
      if (proposalMode === 'model' && !modelReady) throw new Error('Run and explicitly adopt fresh 0G research for this outcome, or select manual paper mode.')
      if (!draft.thesis.trim()) throw new Error('Write the reason behind your probability estimate.')
      const input = inputsFor(draft, market)
      const proposal = createProposal({ book, thesis: draft.thesis.trim(), estimatedProbabilityMicros: input.probability, stakeMicros: input.stake })
      const policy = proposalMode === 'model' && currentResearch ? { ...input.policy, expiresAt: Math.min(input.policy.expiresAt, researchDeadline(currentResearch)) } : input.policy
      const result = evaluateProposalForReview(proposal, book, policy, journalResult.journal, Date.now(), exposureContext(accountContext))
      setPrepared({ proposal, policy, reasons: result.reasons, allowed: result.allowed, quote: result.quote })
      setRunMessage(result.allowed ? 'Proposal passed your rules. Ready for a paper run.' : 'Proposal held. Adjust your rules or refresh the quote.')
    } catch (cause) { setFormError(causeMessage(cause)) }
  }

  async function stop() {
    epoch.current++; runAbort.current?.abort(); runAbort.current = null
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setRunning(false); setRunMessage('Stopped. Pending results are discarded; no new cycles will run.')
    try { await journalResult.journal?.setStopped(true); if (active.current) setLedger(journalResult.journal?.snapshot() ?? null) }
    catch (cause) { if (active.current) setFormError(causeMessage(cause)) }
  }

  async function start() {
    const journal = journalResult.journal
    if (!route || !privateReady || !prepared?.allowed || !market || !journal || running || !accountContext) return
    if (proposalMode === 'model' && !modelReady) { setFormError('Refresh and adopt the matching 0G research before starting.'); return }
    if (Date.now() - accountContext.checkedAt > ACCOUNT_MAX_AGE_MS) { setFormError('Refresh the selected-outcome position before starting.'); return }
    const source = route, selectedMarket = market, index = outcomeIndex, input = inputsFor(draft, market)
    const policy = prepared.policy, thesis = draft.thesis.trim(), account = accountContext.value.account, evidence = proposalMode === 'model' ? currentResearch : null, generation = ++epoch.current
    const controller = new AbortController(); runAbort.current = controller
    const current = () => active.current && epoch.current === generation && source.status === 'ready' && !controller.signal.aborted &&
      routeIdentity.current.route === source && routeIdentity.current.generation === routeGeneration
    const currentPosition = () => {
      const latest = latestAccount.current
      return latest && latest.route === source && latest.generation === routeGeneration && latest.input === account.toLowerCase() &&
        latest.tokenId === selectedMarket.outcomes[index].tokenId ? exposureContext(latest) : null
    }
    setRunning(true); setFormError(''); setRunMessage('Checking the private route before the next paper decision…')
    try {
      await journal.setStopped(false)
      if (!current()) return
      const cycle = async () => {
        if (!current()) return
        try {
          if (evidence && !researchFresh(evidence)) throw new Error('0G research evidence has expired. Refresh it before restarting paper checks.')
          await checkAgentPrivateRoute(source)
          if (!current()) return
          const position = await readPredictionPreflight(source, account, selectedMarket, index)
          if (!current()) return
          const accountSnapshot = { value: position, route: source, generation: routeGeneration, tokenId: position.tokenId, input: account.toLowerCase(), checkedAt: Date.now() }
          latestAccount.current = accountSnapshot; setWatchResult(accountSnapshot)
          const snapshot = await loadOrderBook(selectedMarket, index, controller.signal, privateMarketFetcher(source))
          if (!current()) return
          const proposal = createProposal({ book: snapshot, thesis, estimatedProbabilityMicros: input.probability, stakeMicros: input.stake })
          const decision = evaluatePolicy(proposal, snapshot, policy, journal, Date.now(), false, exposureContext(accountSnapshot))
          setBookResult({ tokenId: snapshot.tokenId, book: snapshot })
          setPrepared({ proposal, policy, reasons: decision.reasons, allowed: decision.allowed, quote: decision.quote })
          if (decision.allowed) {
            const record = await executePaper(proposal, snapshot, policy, journal, undefined, false,
              () => current() && (!evidence || researchFresh(evidence)), currentPosition)
            if (!current()) return
            setLedger(journal.snapshot()); setRunMessage(`Paper fill recorded: ${shares(record.sharesMicros)} ${record.outcome} shares for ${usd(record.spentMicros)}. Next check in 30 seconds.`)
          } else {
            setRunMessage(`No paper order: ${decision.reasons.join(' ') || 'Your policy did not allow this proposal.'}`)
          }
          if (Date.now() >= policy.expiresAt) { await stop(); return }
          if (current()) timer.current = setTimeout(() => { void cycle() }, INTERVAL_MS)
        } catch (cause) {
          if (!current()) return
          epoch.current++; latestAccount.current = null; setRunning(false); setWatchResult(null); setPrepared(null); setRunMessage('Run paused. Refresh the selected position before restarting.'); setFormError(causeMessage(cause))
          try { await journal.setStopped(true) }
          catch (stopCause) { if (active.current) setFormError(`${causeMessage(cause)} ${causeMessage(stopCause)}`) }
        }
      }
      await cycle()
    } catch (cause) { if (current()) { setRunning(false); setFormError(causeMessage(cause)) } }
  }

  async function checkWatchAddress() {
    const account = watchAddress.trim(), request = ++watchEpoch.current
    latestAccount.current = null; setWatchResult(null); setWatchError(''); setPrepared(null)
    if (!route || !privateReady) { setWatchError('Reconnect the private route first.'); return }
    if (!market || !selectedToken) { setWatchError('Choose a market and outcome first.'); return }
    setWatchLoading(true)
    try {
      const checked = await readPredictionPreflight(route, account, market, outcomeIndex)
      if (!active.current || request !== watchEpoch.current || route.status !== 'ready') return
      if (checked.tokenId !== selectedToken || checked.account.toLowerCase() !== account.toLowerCase()) throw new Error('The returned account context does not match this selection.')
      const snapshot = { value: checked, route, generation: routeGeneration, tokenId: checked.tokenId, input: account.toLowerCase(), checkedAt: Date.now() }
      latestAccount.current = snapshot; setWatchResult(snapshot)
    } catch (cause) { if (active.current && request === watchEpoch.current) setWatchError(causeMessage(cause)) }
    finally { if (active.current && request === watchEpoch.current) setWatchLoading(false) }
  }

  const filtered = markets.filter(item => item.question.toLowerCase().includes(search.toLowerCase())).slice(0, 12)
  const bestAsk = book?.asks[0]?.priceMicros, bestBid = book?.bids[0]?.priceMicros
  const records = ledger?.records ?? []
  const routeInterrupted = route?.status === 'failed' || route?.status === 'degraded'
  const routeDisconnected = route?.status === 'closed'
  return <main className="agent-workspace">
    <header className="agent-hero">
      <div><p className="agent-eyebrow">0xPay privacy wallet · Prediction workspace <span className="agent-local-badge">PAPER ONLY · NO REAL ORDERS</span></p>
        <h1>Market context.<br /><em>Private wallet reads.</em></h1>
        <p>Explore public prediction markets and inspect a wallet’s selected position through Anon-RPC. This workspace does not place real orders.</p></div>
      <div className="agent-swarm" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <span className="agent-sprite" key={index} />)}</div>
    </header>
    <div className="agent-topline"><div className={`agent-route ${privateReady ? 'ready' : routeError || routeInterrupted ? 'failed' : ''}`} role="status"><span className="agent-route-dot" />
      <span>{privateReady ? `Polygon private-route check · block ${routeCheck.blockNumber.toLocaleString()}` : routeDisconnected ? 'Private route disconnected' : routeInterrupted ? 'Private route interrupted' : routeError ? 'Private-route check failed' : route?.status === 'ready' ? 'Validating the Polygon private route…' : 'Connecting the private route…'}</span>
      {!privateReady && (routeInterrupted || routeDisconnected || routeError) && <button type="button" onClick={onReconnect}>Reconnect</button>}</div><p>{!privateMarketReady && markets.length === 0 ? 'Market retrieval waiting for private route' : marketLoading ? 'Fetching market data through worker…' : marketError ? 'Venue data unavailable through worker' : markets.length ? `${markets.length} ${markets.length === 1 ? 'market' : 'markets'} loaded through worker` : 'No open markets returned'} · Paper only</p></div>
    <div className="agent-layout">
      <section className="agent-card" aria-labelledby="agent-markets-title"><div className="agent-card-heading"><div><p className="agent-eyebrow">01 / Find a market</p><h2 id="agent-markets-title">What’s your angle?</h2></div>
        {!marketError && <button className="agent-quiet-button" disabled={marketLoading || running || !privateMarketReady} type="button" onClick={reloadMarkets}>Refresh</button>}</div>
        <p className="agent-card-intro">Public Polymarket data requested through the selected Anon-RPC worker. No direct venue fallback and no trading credentials.</p>
        {!marketLoading && !marketError && markets.length > 0 && <><label className="agent-visually-hidden" htmlFor="agent-search">Search loaded markets</label><input id="agent-search" className="agent-search" placeholder="Search loaded markets…" value={search} onChange={event => setSearch(event.target.value)} /></>}
        {!privateMarketReady && markets.length === 0 ? <div className="agent-loading" role="status"><p>{routeInterrupted || routeDisconnected ? 'The private route is unavailable. Reconnect before retrieving markets.' : route?.status === 'ready' ? 'Private market transport is unavailable. Reconnect to retrieve venue data.' : 'Waiting for the private route before retrieving any market data.'}</p>{(routeInterrupted || routeDisconnected || route?.status === 'ready') && <button className="agent-quiet-button" type="button" onClick={onReconnect}>Reconnect for market data</button>}</div> : marketLoading ? <p className="agent-loading" role="status">Fetching the market catalogue through the worker…</p> : marketError ? <div className="agent-market-error" role="alert"><strong>Market data is unavailable.</strong><p>The venue could not provide a valid response through the worker. No direct request was attempted.</p><button className="agent-quiet-button" type="button" disabled={!privateMarketReady} onClick={reloadMarkets}>Retry market data</button><details><summary>Connection details</summary><p>{marketError}</p></details></div> : markets.length === 0 ? <p className="agent-empty">The venue returned no open markets. Refresh to check again.</p> : filtered.length === 0 ? <p className="agent-empty">No loaded markets match your search.</p> :
          <ul className="agent-market-list">{filtered.map(item => <li key={item.id}><button type="button" disabled={running || !privateMarketReady} aria-pressed={selectedId === item.id} onClick={() => selectMarket(item.id)}><strong>{item.question}</strong><small>{item.outcomes.map(outcome => outcome.name).join(' / ')} · {item.endDate ? `Closes ${new Date(item.endDate).toLocaleDateString()}` : 'No closing date provided'}</small></button></li>)}</ul>}
      </section>
      <div><section className="agent-card agent-account-card" aria-labelledby="agent-account-title"><p className="agent-eyebrow">02 / Read the selected position</p><h2 id="agent-account-title">Context before conviction.</h2>
        <p className="agent-card-intro">Inspect a public address’s selected outcome and collateral through Anon-RPC. No wallet connection or trading permission.</p>
        {market && <p className="agent-account-selection">{market.question}<br /><strong>Outcome: {market.outcomes[outcomeIndex]?.name}</strong></p>}
        <label className="agent-field" htmlFor="agent-watch-account">Public watch address<input id="agent-watch-account" value={watchAddress} onChange={event => { invalidateAccount(); setWatchAddress(event.target.value) }} placeholder="0x…" autoComplete="off" spellCheck={false} /></label>
        <button className="agent-quiet-button" disabled={!privateReady || watchLoading || !watchAddress.trim() || !market || running} type="button" onClick={() => { void checkWatchAddress() }}>{watchLoading ? 'Reading through Anon-RPC…' : 'Read selected position privately'}</button>
        {!market && <p className="agent-card-intro" style={{ marginTop: 12 }}>Choose a market and outcome first.</p>}
        {accountContext && <div className="agent-account-result" aria-live="polite"><div><span>Selected outcome balance · shares</span><strong title={`${accountContext.value.outcomeBalance} raw ERC-1155 units`}>{tokenUnits(accountContext.value.outcomeBalance, accountContext.value.outcomeDecimals)}</strong></div><div><span>{accountContext.value.collateralSymbol} collateral</span><strong title={`${accountContext.value.collateralBalance} raw units`}>{tokenUnits(accountContext.value.collateralBalance, accountContext.value.collateralDecimals)}</strong></div><p>Polygon block {accountContext.value.blockNumber.toLocaleString()} · Both balances from the same verified snapshot.</p><p>Outcome holdings affect the local share cap. Collateral is informational and does not fund the hypothetical paper budget.</p></div>}
        {watchError && <p className="agent-inline-error" role="alert">{watchError}</p>}
      </section>
      <section className="agent-card agent-model-status" aria-labelledby="agent-model-title"><div className="agent-card-heading"><h2 id="agent-model-title">Research desk</h2><span className="agent-paper-tag">MODEL CONNECTIONS</span></div>
        <div className="agent-model-roles"><div><span className="agent-sprite" aria-hidden="true" /><strong>0G Researcher</strong><span>{currentResearch ? 'RETURNED' : researchLoading ? 'REQUESTED' : 'NOT RUN'}</span></div><div><span className="agent-sprite" aria-hidden="true" /><strong>0G Skeptic</strong><span>{currentResearch ? 'RETURNED' : researchLoading ? 'REQUESTED' : 'NOT RUN'}</span></div></div>
        {researchService.status === 'unknown' ? <p className="agent-card-intro" role="status">Checking the 0G research service… No model result has been accepted.</p> : researchService.status === 'error' ? <div className="agent-research-unavailable"><p>Research service unavailable. Retry its connection or choose manual paper mode.</p><button className="agent-quiet-button" type="button" onClick={() => { setResearchService({ status: 'unknown' }); setServiceRefresh(value => value + 1) }}>Retry research service</button></div> : !researchService.configured ? <p className="agent-card-intro">0G Private Computer is not configured on this server. The operator must enable inference before research can run. Manual paper mode remains available.</p> : <p className="agent-card-intro">Public market facts and retrieved evidence only. No watched address, holdings, wallet keys or risk limits are sent. {researchService.jobsRemaining} of {researchService.jobLimit} server research jobs remain.</p>}
        <div className="agent-research-actions"><button className="agent-quiet-button" type="button" disabled={researchLoading || running || !market || !book || bookLoading || researchService.status !== 'ready' || !researchService.configured || researchService.jobsRemaining < 1} onClick={() => { void runResearch() }}>Run 0G research</button>{researchLoading && <button className="agent-quiet-button" type="button" onClick={cancelResearch}>Cancel research</button>}</div>
        {researchLoading && <p role="status" className="agent-card-intro">Requesting researcher and skeptic responses. No draft or paper order changes until you review and adopt a result.</p>}
        {researchError && <p className="agent-inline-error" role="alert">{researchError}</p>}
        {currentResearch && <ResearchOutput snapshot={currentResearch} adopted={adoptedResearch === currentResearch} onAdopt={adoptResearch} disabled={running} />}
      </section>
      <section className="agent-card agent-form-card" aria-labelledby="agent-thesis-title"><p className="agent-eyebrow">02 / Give it a thesis</p><h2 id="agent-thesis-title">Conviction, meet discipline.</h2>
        {!market ? <p className="agent-loading">Choose a market to begin. Your rules will stay in control.</p> : <><p className="agent-card-intro">{market.question}</p>
          <div className="agent-outcomes" aria-label="Market outcome">{market.outcomes.map((outcome, index) => <button key={outcome.tokenId} type="button" disabled={running || !privateMarketReady} aria-pressed={outcomeIndex === index} onClick={() => { clearResearch(); invalidateAccount(); setOutcomeIndex(index); setBookResult(null); setBookError(''); setBookLoading(true); setPrepared(null) }}>{outcome.name}</button>)}</div>
          {!privateMarketReady && !book ? <p className="agent-loading" role="status">Order-book reads are paused until the private route reconnects.</p> : bookLoading || (!book && !bookError) ? <p className="agent-loading" role="status">Reading the order book through the worker…</p> : bookError ? <p className="agent-inline-error" role="alert">{bookError}</p> : book && <div className="agent-book-strip"><span>Best ask<strong>{bestAsk === undefined ? 'Unavailable' : percent(bestAsk)}</strong></span><span>Best bid<strong>{bestBid === undefined ? 'Unavailable' : percent(bestBid)}</strong></span><span>Bid/ask spread<strong>{bestAsk === undefined || bestBid === undefined ? 'Unavailable' : percent(bestAsk - bestBid)}</strong></span><span>Quote fetched<strong>{new Date(book.fetchedAt).toLocaleTimeString()}</strong></span></div>}
          <fieldset className="agent-proposal-mode"><legend>Proposal source</legend><label><input type="radio" name="agent-proposal-mode" checked={proposalMode === 'model'} disabled={running} onChange={() => chooseProposalMode('model')} />0G research</label><label><input type="radio" name="agent-proposal-mode" checked={proposalMode === 'manual'} disabled={running} onChange={() => chooseProposalMode('manual')} />Manual paper mode</label></fieldset>
          <label className="agent-field">{proposalMode === 'model' ? 'Adopted 0G thesis' : 'Your manual thesis'}<textarea id="agent-thesis" value={draft.thesis} maxLength={2000} disabled={running} readOnly={proposalMode === 'model'} onChange={event => editDraft('thesis', event.target.value)} placeholder={proposalMode === 'model' ? 'Run and explicitly adopt matching 0G research above.' : 'Write your own reasoning. No AI output is used in manual mode.'} /></label>
          <div className="agent-fields-row"><label className="agent-field">{proposalMode === 'model' ? 'Adopted model probability (%)' : 'Your probability (%)'}<input id="agent-probability" inputMode="decimal" value={draft.probability} disabled={running} readOnly={proposalMode === 'model'} onChange={event => editDraft('probability', event.target.value)} /><small>{proposalMode === 'model' ? 'A model estimate for human review, not a guarantee.' : 'Your estimate; this path does not use AI.'}</small></label><label className="agent-field">Paper stake (USD)<input id="agent-paper-stake" inputMode="decimal" value={draft.stake} disabled={running} onChange={event => editDraft('stake', event.target.value)} /><small>Maximum hypothetical spend per cycle.</small></label></div>
          <details className="agent-policy-details" open><summary>Budget & execution boundaries</summary><div className="agent-fields-row"><label className="agent-field">Session paper budget (USD)<input inputMode="decimal" value={draft.budget} disabled={running} onChange={event => editDraft('budget', event.target.value)} /><small>Includes {usd(ledger?.spentMicros ?? 0)} already recorded in this journal.</small></label><label className="agent-field">Expires in (minutes)<input inputMode="numeric" value={draft.expiry} disabled={running} onChange={event => editDraft('expiry', event.target.value)} /></label></div><div className="agent-fields-row"><label className="agent-field">Maximum price (%)<input inputMode="decimal" value={draft.maxPrice} disabled={running} onChange={event => editDraft('maxPrice', event.target.value)} /></label><label className="agent-field">Maximum spread (pp)<input inputMode="decimal" value={draft.maxSpread} disabled={running} onChange={event => editDraft('maxSpread', event.target.value)} /></label></div><label className="agent-field">Maximum combined outcome shares<input id="agent-max-outcome-shares" inputMode="decimal" value={draft.maxExposure} disabled={running} onChange={event => editDraft('maxExposure', event.target.value)} /><small>Onchain holdings + all paper shares for this outcome recorded in this browser + the proposed fill. Account-independent paper history is counted conservatively. Onchain dust rounds up to six-decimal share units.</small></label></details>
          <button className="agent-primary" type="button" disabled={running || !book || bookLoading || !journalResult.journal || !accountContext || proposalMode === 'model' && !modelReady} onClick={prepare}>Evaluate paper proposal <span aria-hidden="true">↗</span></button>
          {!accountContext && <p className="agent-card-intro" style={{ marginTop: 12 }}>Read this outcome’s public position through the private route before preparing a proposal.</p>}
          <button className="agent-quiet-button" style={{ marginTop: 10, color: '#d2b898' }} type="button" disabled={running || bookLoading || !privateMarketReady} onClick={() => { setBookLoading(true); setBookResult(null); setPrepared(null); setBookRefresh(value => value + 1) }}>Refresh order book</button>
          {prepared && <div className="agent-proposal" aria-live="polite"><h3>{prepared.allowed ? 'The rules allow a paper proposal.' : 'The rules say: hold.'}</h3><p>Deterministic thesis/price rule · {percent(prepared.proposal.estimatedProbabilityMicros)} {proposalMode === 'model' ? 'adopted 0G estimate' : 'user probability'} · {usd(prepared.proposal.stakeMicros)} maximum paper spend.</p>
            {prepared.quote && <dl className="agent-proposal-quote"><div><dt>Paper shares</dt><dd>{shares(prepared.quote.sharesMicros)}</dd></div><div><dt>Weighted ask price</dt><dd>{percent(prepared.quote.averagePriceMicros)}</dd></div><div><dt>Hypothetical cost</dt><dd>{usd(prepared.quote.spentMicros)}</dd></div><div><dt>Policy expires</dt><dd>{new Date(prepared.policy.expiresAt).toLocaleTimeString()}</dd></div></dl>}
            {prepared.reasons.length > 0 && <ul>{prepared.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}<p>Prices and displayed size are checked again before recording a paper fill. Fees, queue priority and actual venue matching are not modeled.</p></div>}</>}
        {(formError || journalResult.error) && <p className="agent-inline-error" role="alert">{formError || journalResult.error}</p>}
      </section>
      <section className="agent-card agent-runner" aria-labelledby="agent-runner-title"><div className="agent-runner-top"><h2 id="agent-runner-title">Agent activity</h2><span className={`agent-run-state ${running ? 'running' : ''}`}><span />{running ? 'PAPER ACTIVE' : 'PAPER STOPPED'}</span></div><p className="agent-card-intro">Deterministic checks every 30 seconds while this page stays open. No background service and no real venue orders.</p>
        <div className="agent-run-controls"><button className="agent-primary" type="button" disabled={running || !privateReady || !prepared?.allowed || !journalResult.journal || !market || !book || bookLoading || !accountContext || proposalMode === 'model' && !modelReady} onClick={() => { void start() }}>Start paper checks <span aria-hidden="true">↗</span></button><button className="agent-stop" type="button" disabled={!running} onClick={() => { void stop() }}>Kill switch</button></div><p className="agent-run-message" role="status" aria-live="polite">{runMessage}</p>{routeError && <p className="agent-inline-error">{routeError}</p>}
      </section></div>
    </div>
    <section className="agent-card agent-ledger" aria-labelledby="agent-journal-title"><div className="agent-ledger-heading"><h2 id="agent-journal-title">A paper trail. Literally.</h2><span>{records.length} paper {records.length === 1 ? 'fill' : 'fills'} · {usd(ledger?.spentMicros ?? 0)} hypothetical spend</span></div>
      {records.length === 0 ? <p className="agent-empty">No paper fills recorded. A proposal appears here only after it passes the policy and is saved locally.</p> : <ol className="agent-records">{[...records].reverse().map(record => <li className="agent-record" key={record.id}><div><h3>{record.question}</h3><p><span className="agent-paper-tag">PAPER FILL</span> · {record.outcome} · {shares(record.sharesMicros)} shares · average {percent(record.averagePriceMicros)}</p></div><div className="agent-record-side"><strong>{usd(record.spentMicros)}</strong><span>{new Date(record.executedAt).toLocaleString()}</span></div></li>)}</ol>}
    </section>
    <details className="agent-privacy"><summary>What is private here, and what is not?</summary><p>Market discovery and order-book HTTP requests use the selected Anon-RPC worker; there is no direct venue fallback. The selected account’s Polygon outcome-token and collateral RPC reads also use the worker at one block. Fresh outcome holdings enforce your combined share cap locally before proposal review and every paper commit. All paper shares for the same outcome in this browser are counted, regardless of watched account. Collateral is informational; it does not fund paper purchases. If the private route fails, new market reads and paper execution stop. Completed public research remains available.</p><p>0G research is separate: public market metadata and retrieved evidence go through our application proxy, which sees plaintext. No account context, wallet keys or risk limits are included. Research is for human review and cannot change limits or place orders. Manual paper mode uses your own thesis, not AI. The local paper journal excludes watched addresses, holdings and thesis. No venue order, signature or transfer is made. Source links open outside the worker. Onchain data remains public; worker success does not prove anonymity. Paper fills exclude fees and do not change onchain balances.</p>
      <p><a href="https://docs.polymarket.com/" target="_blank" rel="noreferrer">Polymarket API documentation ↗</a> · <a href="https://ethereum.github.io/anon-rpc/wallets/" target="_blank" rel="noreferrer">Anon-RPC integration guide ↗</a></p>
    </details>
  </main>
}
