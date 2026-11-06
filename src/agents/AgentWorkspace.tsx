import { useEffect, useRef, useState } from 'react'
import type { PrivateRpc } from '../rpc'
import { loadMarkets, loadOrderBook, type MarketSummary, type OrderBookSnapshot } from './market'
import { createProposal, evaluatePolicy, evaluateProposalForReview, executePaper, PaperJournal, type AgentPolicy, type AgentProposal } from './engine'
import { checkAgentPrivateRoute } from './route-check'

type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'>
type Props = { route: Route | null; routeGeneration: number; onReconnect: () => void }
type RouteCheck = { route: Route; generation: number; blockNumber: number }
type Prepared = { proposal: AgentProposal; policy: AgentPolicy; reasons: string[]; allowed: boolean }
type Draft = { thesis: string; probability: string; stake: string; budget: string; expiry: string; maxPrice: string; maxSpread: string }
const INITIAL_DRAFT: Draft = { thesis: '', probability: '65', stake: '5', budget: '20', expiry: '30', maxPrice: '70', maxSpread: '5' }
const INTERVAL_MS = 30_000
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`
const percent = (micros: number) => `${(micros / 10_000).toFixed(1)}%`
const shares = (micros: number) => (micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 4 })
const causeMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'This action could not be completed.'

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
  if (probability <= 0 || probability >= 1_000_000) throw new Error('Your probability must be between 0% and 100%.')
  if (hundredthsOfMinute < 100 || hundredthsOfMinute > 144_000) throw new Error('Choose an expiry between 1 and 1,440 minutes.')
  return { probability, stake: parseUnits(draft.stake, 6, 'paper stake'), policy: {
    allowedMarketIds: [market.id], maxOrderMicros: parseUnits(draft.stake, 6, 'paper stake'),
    sessionBudgetMicros: parseUnits(draft.budget, 6, 'paper budget'), expiresAt: Date.now() + hundredthsOfMinute * 600,
    maxSnapshotAgeMs: 90_000, maxSpreadMicros: parseUnits(draft.maxSpread, 4, 'maximum spread'),
    maxPriceMicros: parseUnits(draft.maxPrice, 4, 'maximum price'),
  } satisfies AgentPolicy }
}

export function AgentWorkspace(props: Props) {
  return <AgentWorkspaceForRoute key={`${props.routeGeneration}:${props.route?.status ?? 'none'}`} {...props} />
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
  const [watchResult, setWatchResult] = useState<{ account: string; balanceWei: bigint; blockNumber: number } | null>(null)
  const [watchError, setWatchError] = useState('')
  const [watchLoading, setWatchLoading] = useState(false)
  const active = useRef(true)
  const epoch = useRef(0)
  const runAbort = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchEpoch = useRef(0)
  const market = markets.find(item => item.id === selectedId) ?? null
  const selectedToken = market?.outcomes[outcomeIndex]?.tokenId
  const book = bookResult && bookResult.tokenId === selectedToken && bookResult.book.market === market ? bookResult.book : null
  const privateReady = route?.status === 'ready' && routeCheck?.route === route && routeCheck.generation === routeGeneration

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false; epoch.current++; watchEpoch.current++
      runAbort.current?.abort()
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- Cancel the latest scheduled cycle rather than a mount-time timer.
      if (timer.current) clearTimeout(timer.current)
      void journalResult.journal?.setStopped(true).catch(() => {})
    }
  }, [journalResult])

  useEffect(() => {
    const abort = new AbortController()
    void loadMarkets(abort.signal).then(rows => {
      if (!abort.signal.aborted) { setMarkets(rows); setMarketLoading(false); setMarketError('') }
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) { setMarkets([]); setMarketLoading(false); setMarketError(causeMessage(cause)) }
    })
    return () => abort.abort()
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    if (!route || route.status !== 'ready') return
    void checkAgentPrivateRoute(route).then(check => {
      if (!cancelled && route.status === 'ready') { setRouteCheck({ route, generation: routeGeneration, blockNumber: check.blockNumber }); setRouteError('') }
    }).catch((cause: unknown) => { if (!cancelled) setRouteError(causeMessage(cause)) })
    return () => { cancelled = true }
  }, [route, routeGeneration])

  useEffect(() => {
    if (!market || !selectedToken) return
    const abort = new AbortController()
    void loadOrderBook(market, outcomeIndex, abort.signal).then(snapshot => {
      if (!abort.signal.aborted) { setBookResult({ tokenId: snapshot.tokenId, book: snapshot }); setBookLoading(false); setBookError('') }
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) { setBookResult(null); setBookLoading(false); setBookError(causeMessage(cause)) }
    })
    return () => abort.abort()
  }, [market, outcomeIndex, selectedToken, bookRefresh])

  function selectMarket(value: string) {
    setSelectedId(value); setOutcomeIndex(0); setBookResult(null); setBookError(''); setBookLoading(true); setPrepared(null); setFormError('')
  }
  function editDraft<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(previous => ({ ...previous, [key]: value })); setPrepared(null); setFormError('') }
  function prepare() {
    setFormError(''); setPrepared(null)
    try {
      if (!market || !book || !journalResult.journal) throw new Error('Load a market and a live order book first.')
      if (!draft.thesis.trim()) throw new Error('Write the reason behind your probability estimate.')
      const input = inputsFor(draft, market)
      const proposal = createProposal({ book, thesis: draft.thesis.trim(), estimatedProbabilityMicros: input.probability, stakeMicros: input.stake })
      const result = evaluateProposalForReview(proposal, book, input.policy, journalResult.journal)
      setPrepared({ proposal, policy: input.policy, reasons: result.reasons, allowed: result.allowed })
      setRunMessage(result.allowed ? 'Proposal passed your rules. Ready for a paper run.' : 'Proposal held. Adjust your rules or refresh the quote.')
    } catch (cause) { setFormError(causeMessage(cause)) }
  }

  async function stop() {
    epoch.current++; runAbort.current?.abort()
    if (timer.current) clearTimeout(timer.current)
    setRunning(false); setRunMessage('Stopped. Pending results are discarded; no new cycles will run.')
    try { await journalResult.journal?.setStopped(true); if (active.current) setLedger(journalResult.journal?.snapshot() ?? null) }
    catch (cause) { if (active.current) setFormError(causeMessage(cause)) }
  }

  async function start() {
    const journal = journalResult.journal
    if (!route || !privateReady || !prepared?.allowed || !market || !journal || running) return
    const source = route, selectedMarket = market, index = outcomeIndex, input = inputsFor(draft, market)
    const policy = prepared.policy, thesis = draft.thesis.trim(), generation = ++epoch.current
    const controller = new AbortController(); runAbort.current = controller
    const current = () => active.current && epoch.current === generation && source.status === 'ready' && !controller.signal.aborted
    setRunning(true); setFormError(''); setRunMessage('Checking the private route before the next paper decision…')
    try {
      await journal.setStopped(false)
      if (!current()) return
      const cycle = async () => {
        if (!current()) return
        try {
          await checkAgentPrivateRoute(source)
          if (!current()) return
          const snapshot = await loadOrderBook(selectedMarket, index, controller.signal)
          if (!current()) return
          const proposal = createProposal({ book: snapshot, thesis, estimatedProbabilityMicros: input.probability, stakeMicros: input.stake })
          const decision = evaluatePolicy(proposal, snapshot, policy, journal)
          setBookResult({ tokenId: snapshot.tokenId, book: snapshot })
          setPrepared({ proposal, policy, reasons: decision.reasons, allowed: decision.allowed })
          if (decision.allowed) {
            const record = await executePaper(proposal, snapshot, policy, journal)
            if (!current()) return
            setLedger(journal.snapshot()); setRunMessage(`Paper fill recorded: ${shares(record.sharesMicros)} ${record.outcome} shares for ${usd(record.spentMicros)}. Next check in 30 seconds.`)
          } else {
            setRunMessage(`No paper order: ${decision.reasons.join(' ') || 'Your policy did not allow this proposal.'}`)
          }
          if (Date.now() >= policy.expiresAt) { await stop(); return }
          if (current()) timer.current = setTimeout(() => { void cycle() }, INTERVAL_MS)
        } catch (cause) {
          if (!current()) return
          epoch.current++; setRunning(false); setRunMessage('Run paused. Resolve the error before restarting.'); setFormError(causeMessage(cause))
          try { await journal.setStopped(true) }
          catch (stopCause) { if (active.current) setFormError(`${causeMessage(cause)} ${causeMessage(stopCause)}`) }
        }
      }
      await cycle()
    } catch (cause) { if (current()) { setRunning(false); setFormError(causeMessage(cause)) } }
  }

  async function checkWatchAddress() {
    const account = watchAddress.trim(), request = ++watchEpoch.current
    setWatchResult(null); setWatchError('')
    if (!route || !privateReady) { setWatchError('Reconnect the private route first.'); return }
    setWatchLoading(true)
    try {
      const checked = await checkAgentPrivateRoute(route, account)
      if (!active.current || request !== watchEpoch.current || route.status !== 'ready') return
      if (!checked.account || checked.balanceWei === undefined) throw new Error('The balance response was incomplete.')
      setWatchResult({ account: checked.account, balanceWei: checked.balanceWei, blockNumber: checked.blockNumber })
    } catch (cause) { if (active.current && request === watchEpoch.current) setWatchError(causeMessage(cause)) }
    finally { if (active.current && request === watchEpoch.current) setWatchLoading(false) }
  }

  const filtered = markets.filter(item => item.question.toLowerCase().includes(search.toLowerCase())).slice(0, 12)
  const bestAsk = book?.asks[0]?.priceMicros, bestBid = book?.bids[0]?.priceMicros
  const records = ledger?.records ?? []
  const watchedPol = watchResult ? `${watchResult.balanceWei / 10n ** 18n}.${(watchResult.balanceWei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '') || '0'}` : ''
  return <main className="agent-workspace">
    <header className="agent-hero">
      <div><p className="agent-eyebrow">0xPay agent workspace <span className="agent-local-badge">PAPER ONLY · NO REAL ORDERS</span></p>
        <h1>Your thesis.<br />An agent with <em>boundaries.</em></h1>
        <p>Choose a live prediction market. Set your conviction and limits. See whether the numbers support a paper decision.</p></div>
      <div className="agent-swarm" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <span className="agent-sprite" key={index} />)}</div>
    </header>
    <div className="agent-topline"><div className={`agent-route ${privateReady ? 'ready' : routeError || route?.status === 'failed' ? 'failed' : ''}`} role="status"><span className="agent-route-dot" />
      <span>{privateReady ? `Polygon private-route check · block ${routeCheck.blockNumber.toLocaleString()}` : routeError ? 'Private-route check failed' : 'Checking the private route…'}</span>
      {!privateReady && <button type="button" onClick={onReconnect}>Reconnect</button>}</div><p>Live venue data · Direct public API · Session-bound paper execution</p></div>
    <div className="agent-layout">
      <section className="agent-card" aria-labelledby="agent-markets-title"><div className="agent-card-heading"><div><p className="agent-eyebrow">01 / Find a market</p><h2 id="agent-markets-title">What’s your angle?</h2></div>
        <button className="agent-quiet-button" disabled={marketLoading || running} type="button" onClick={() => { setMarketLoading(true); setMarketError(''); setRefresh(value => value + 1) }}>Refresh</button></div>
        <p className="agent-card-intro">Open markets from Polymarket. No account or trading credentials needed.</p>
        <label className="agent-visually-hidden" htmlFor="agent-search">Search loaded markets</label><input id="agent-search" className="agent-search" placeholder="Search loaded markets…" value={search} onChange={event => setSearch(event.target.value)} />
        {marketLoading ? <p className="agent-loading" role="status">Loading live markets…</p> : marketError ? <p className="agent-inline-error" role="alert">{marketError}</p> : filtered.length === 0 ? <p className="agent-empty">No matching live markets in this response.</p> :
          <ul className="agent-market-list">{filtered.map(item => <li key={item.id}><button type="button" disabled={running} aria-pressed={selectedId === item.id} onClick={() => selectMarket(item.id)}><strong>{item.question}</strong><small>{item.outcomes.map(outcome => outcome.name).join(' / ')} · {item.endDate ? `Closes ${new Date(item.endDate).toLocaleDateString()}` : 'No closing date provided'}</small></button></li>)}</ul>}
      </section>
      <div><section className="agent-card agent-model-status" aria-labelledby="agent-model-title"><div className="agent-card-heading"><h2 id="agent-model-title">Research desk</h2><span className="agent-paper-tag">MODEL CONNECTIONS</span></div>
        <div className="agent-model-roles"><div><span className="agent-sprite" aria-hidden="true" /><strong>Researcher</strong><span>NOT RUN</span></div><div><span className="agent-sprite" aria-hidden="true" /><strong>Challenger</strong><span>NOT RUN</span></div></div>
        <p className="agent-card-intro">No research model is configured. Enter your own thesis below; only deterministic price and policy checks run.</p></section>
      <section className="agent-card agent-form-card" aria-labelledby="agent-thesis-title"><p className="agent-eyebrow">02 / Give it a thesis</p><h2 id="agent-thesis-title">Conviction, meet discipline.</h2>
        {!market ? <p className="agent-loading">Choose a market to begin. Your rules will stay in control.</p> : <><p className="agent-card-intro">{market.question}</p>
          <div className="agent-outcomes" aria-label="Market outcome">{market.outcomes.map((outcome, index) => <button key={outcome.tokenId} type="button" disabled={running} aria-pressed={outcomeIndex === index} onClick={() => { setOutcomeIndex(index); setBookResult(null); setBookError(''); setBookLoading(true); setPrepared(null) }}>{outcome.name}</button>)}</div>
          {bookLoading || (!book && !bookError) ? <p className="agent-loading" role="status">Reading the live order book…</p> : bookError ? <p className="agent-inline-error" role="alert">{bookError}</p> : book && <div className="agent-book-strip"><span>Best ask<strong>{bestAsk === undefined ? 'Unavailable' : percent(bestAsk)}</strong></span><span>Best bid<strong>{bestBid === undefined ? 'Unavailable' : percent(bestBid)}</strong></span><span>Bid/ask spread<strong>{bestAsk === undefined || bestBid === undefined ? 'Unavailable' : percent(bestAsk - bestBid)}</strong></span><span>Quote fetched<strong>{new Date(book.fetchedAt).toLocaleTimeString()}</strong></span></div>}
          <label className="agent-field">Why this outcome?<textarea value={draft.thesis} maxLength={2000} disabled={running} onChange={event => editDraft('thesis', event.target.value)} placeholder="Write your own reasoning. This agent tests your thesis against the book; it does not invent one." /></label>
          <div className="agent-fields-row"><label className="agent-field">Your probability (%)<input inputMode="decimal" value={draft.probability} disabled={running} onChange={event => editDraft('probability', event.target.value)} /><small>Your estimate, not an AI forecast.</small></label><label className="agent-field">Paper stake (USD)<input inputMode="decimal" value={draft.stake} disabled={running} onChange={event => editDraft('stake', event.target.value)} /><small>Maximum hypothetical spend per cycle.</small></label></div>
          <details className="agent-policy-details" open><summary>Budget & execution boundaries</summary><div className="agent-fields-row"><label className="agent-field">Session paper budget (USD)<input inputMode="decimal" value={draft.budget} disabled={running} onChange={event => editDraft('budget', event.target.value)} /></label><label className="agent-field">Expires in (minutes)<input inputMode="numeric" value={draft.expiry} disabled={running} onChange={event => editDraft('expiry', event.target.value)} /></label></div><div className="agent-fields-row"><label className="agent-field">Maximum price (%)<input inputMode="decimal" value={draft.maxPrice} disabled={running} onChange={event => editDraft('maxPrice', event.target.value)} /></label><label className="agent-field">Maximum spread (pp)<input inputMode="decimal" value={draft.maxSpread} disabled={running} onChange={event => editDraft('maxSpread', event.target.value)} /></label></div></details>
          <button className="agent-primary" type="button" disabled={running || !book || bookLoading || !journalResult.journal} onClick={prepare}>Evaluate paper proposal <span aria-hidden="true">↗</span></button>
          <button className="agent-quiet-button" style={{ marginTop: 10, color: '#d2b898' }} type="button" disabled={running || bookLoading} onClick={() => { setBookLoading(true); setBookResult(null); setPrepared(null); setBookRefresh(value => value + 1) }}>Refresh order book</button>
          {prepared && <div className="agent-proposal" aria-live="polite"><h3>{prepared.allowed ? 'The rules allow a paper proposal.' : 'The rules say: hold.'}</h3><p>Deterministic thesis/price rule · {percent(prepared.proposal.estimatedProbabilityMicros)} user probability · {usd(prepared.proposal.stakeMicros)} maximum paper spend.</p><ul>{prepared.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul><p>Live size and prices are checked again before recording a paper fill. A quote is not a guaranteed real execution.</p></div>}</>}
        {(formError || journalResult.error) && <p className="agent-inline-error" role="alert">{formError || journalResult.error}</p>}
      </section>
      <section className="agent-card agent-runner" aria-labelledby="agent-runner-title"><div className="agent-runner-top"><h2 id="agent-runner-title">Your agent, on a leash.</h2><span className={`agent-run-state ${running ? 'running' : ''}`}><span />{running ? 'RUNNING' : 'STOPPED'}</span></div><p className="agent-card-intro">Checks every 30 seconds while this page stays open. No background service and no real venue orders.</p>
        <div className="agent-run-controls"><button className="agent-primary" type="button" disabled={running || !privateReady || !prepared?.allowed || !journalResult.journal} onClick={() => { void start() }}>Run paper agent <span aria-hidden="true">↗</span></button><button className="agent-stop" type="button" disabled={!running} onClick={() => { void stop() }}>Kill switch</button></div><p className="agent-run-message" role="status" aria-live="polite">{runMessage}</p>{routeError && <p className="agent-inline-error">{routeError}</p>}
      </section></div>
    </div>
    <section className="agent-card agent-ledger" aria-labelledby="agent-journal-title"><div className="agent-ledger-heading"><h2 id="agent-journal-title">A paper trail. Literally.</h2><span>{records.length} paper {records.length === 1 ? 'fill' : 'fills'} · {usd(ledger?.spentMicros ?? 0)} hypothetical spend</span></div>
      {records.length === 0 ? <p className="agent-empty">No paper fills recorded. A proposal appears here only after it passes the policy and is saved locally.</p> : <ol className="agent-records">{[...records].reverse().map(record => <li className="agent-record" key={record.id}><div><h3>{record.question}</h3><p><span className="agent-paper-tag">PAPER FILL</span> · {record.outcome} · {shares(record.sharesMicros)} shares · average {percent(record.averagePriceMicros)}</p></div><div className="agent-record-side"><strong>{usd(record.spentMicros)}</strong><span>{new Date(record.executedAt).toLocaleString()}</span></div></li>)}</ol>}
    </section>
    <details className="agent-privacy"><summary>What is private here, and what is not?</summary><p>Polygon chain and optional address-balance reads use the selected Anon-RPC worker. If that route cannot be validated, the paper agent does not execute. This does not make Polymarket activity private: market discovery and order-book requests go directly to its public Gamma/CLOB APIs outside Anon-RPC. No venue order, wallet signature or transfer is made. This is a deterministic paper agent, not an AI model, news feed or promise of profit.</p><p>The paper journal is saved in this browser and excludes your written thesis. Switching devices does not move it. Onchain addresses and balances remain public; a successful worker response alone is not proof of anonymity.</p>
      <label className="agent-field" style={{ maxWidth: 520, color: '#79634c' }}>Optional watch-only Polygon address<input value={watchAddress} disabled={watchLoading} onChange={event => { watchEpoch.current++; setWatchAddress(event.target.value); setWatchResult(null); setWatchError('') }} placeholder="0x… — no wallet connection" style={{ background: '#fffdf7', color: '#32281f', borderColor: '#d7c9b6' }} /></label><button className="agent-quiet-button" disabled={!privateReady || watchLoading || !watchAddress.trim()} type="button" onClick={() => { void checkWatchAddress() }}>{watchLoading ? 'Checking through worker…' : 'Check public POL balance through worker'}</button>{watchResult && <p style={{ overflowWrap: 'anywhere' }}>{watchResult.account}: {watchedPol} POL at block {watchResult.blockNumber.toLocaleString()}. Watch-only; this is not your venue collateral or proof of ownership.</p>}{watchError && <p className="agent-inline-error" role="alert">{watchError}</p>}
      <p><a href="https://docs.polymarket.com/" target="_blank" rel="noreferrer">Polymarket API documentation ↗</a> · <a href="https://ethereum.github.io/anon-rpc/wallets/" target="_blank" rel="noreferrer">Anon-RPC integration guide ↗</a></p>
    </details>
  </main>
}
