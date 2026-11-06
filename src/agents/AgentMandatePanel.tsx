import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getAddress } from 'ethers'
import type { AgentPolicy, PaperJournal } from './engine'
import { AgentMandateStore } from './mandate-store'
import { agentMandateDigest, agentMandateTypedData, createAgentMandate, validateSignedAgentMandate, type AgentMandate, type SignedAgentMandate } from './mandate'

type BrowserSigner = {
  request: (request: { method: string; params?: readonly unknown[] }) => Promise<unknown>
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}
export type AgentMandatePanelProps = {
  policy: AgentPolicy | null; marketId: string | null; watchedAccount: string | null; journal: PaperJournal | null
  running: boolean; onChanged: () => void; onStop: () => Promise<void>; onPendingChange?: (pending: boolean) => void
}
type Review = { provider: BrowserSigner; payload: AgentMandate; context: string; journal: PaperJournal }
type Saved = { active: SignedAgentMandate | null; digest: string | null; error: string; loaded: boolean }
const AGENT_ID = 'prediction-paper-runner'
const AGENT_NAME = '0xPay paper reviewer'
const DOMAIN_FIELDS = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }]
const micros = (value: number) => (value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6 })
const price = (value: number) => `${(value / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`
class PanelError extends Error {}

function injectedSigner(): BrowserSigner | null {
  const value = (window as unknown as { ethereum?: BrowserSigner }).ethereum
  return value && typeof value.request === 'function' ? value : null
}
function approvingAccount(value: unknown): string {
  if (!Array.isArray(value) || typeof value[0] !== 'string') throw new PanelError('No browser account was selected. No mandate was activated.')
  try { return getAddress(value[0]) } catch { throw new PanelError('The browser returned an invalid account. No mandate was activated.') }
}
function requirePolygon(value: unknown) {
  if (value !== '0x89') throw new PanelError('Select Polygon in your browser wallet, then prepare the policy again. No transaction or network switch was requested.')
}
function safeError(cause: unknown) {
  if (cause instanceof PanelError) return cause.message
  if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 4001) return 'Wallet request cancelled. No new mandate was activated.'
  if (cause instanceof Error && cause.message.startsWith('Agent mandate:')) return 'The paper policy is invalid, expired or its signature could not be verified. Prepare a fresh policy review.'
  return 'The wallet or local authorization storage could not complete this step. The paper runner stays stopped; check the saved status before retrying.'
}

function Limits({ policy, watchedAccount }: { policy: AgentPolicy; watchedAccount: string | null }) {
  return <dl className="agent-mandate-limits">
    <div><dt>Allowed market IDs</dt><dd>{policy.allowedMarketIds.join(', ')}</dd></div>
    <div><dt>Assessed public account</dt><dd><code>{watchedAccount || 'Choose an account first'}</code><small>This may differ from the signer; approval is not proof of account ownership.</small></dd></div>
    <div><dt>Session paper budget</dt><dd>${micros(policy.sessionBudgetMicros)} simulated</dd></div>
    <div><dt>Maximum paper order</dt><dd>${micros(policy.maxOrderMicros)} simulated</dd></div>
    <div><dt>Maximum price</dt><dd>{price(policy.maxPriceMicros)}</dd></div>
    <div><dt>Maximum spread</dt><dd>{price(policy.maxSpreadMicros).slice(0, -1)} percentage points</dd></div>
    <div><dt>Combined outcome share cap</dt><dd>{policy.maxOutcomeSharesMicros === undefined ? 'Required before signing' : micros(policy.maxOutcomeSharesMicros)} shares</dd></div>
    <div><dt>Expires</dt><dd>{Number.isFinite(policy.expiresAt) ? new Date(policy.expiresAt).toLocaleString() : 'Invalid expiry'}</dd></div>
    <div><dt>Transaction signing</dt><dd><strong>Not permitted · canSignTransactions = false</strong></dd></div>
  </dl>
}

/** User-operated EOA signature for a local PAPER policy. The agent never
 * receives this provider, a private key or authority to submit real orders. */
export function AgentMandatePanel({ policy, marketId, watchedAccount, journal, running, onChanged, onStop, onPendingChange }: AgentMandatePanelProps) {
  const context = JSON.stringify({ policy, marketId, watchedAccount: watchedAccount?.trim().toLowerCase() ?? null })
  const [review, setReview] = useState<Review | null>(null)
  const [saved, setSaved] = useState<Saved>({ active: null, digest: null, error: '', loaded: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  const pending = useRef(false)
  const epoch = useRef(0)
  const currentContext = useRef({ context, journal })
  const handlers = useRef({ onChanged, onStop, onPendingChange })
  const store = useRef<{ journal: PaperJournal; sessionId: string; value: AgentMandateStore } | null>(null)
  const currentReview = review?.context === context && review.journal === journal ? review : null
  const canPrepare = policy !== null && marketId !== null && watchedAccount !== null && journal !== null &&
    policy.allowedMarketIds.includes(marketId) && policy.maxOutcomeSharesMicros !== undefined

  useLayoutEffect(() => {
    handlers.current = { onChanged, onStop, onPendingChange }
  }, [onChanged, onStop, onPendingChange])
  useLayoutEffect(() => {
    currentContext.current = { context, journal }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- This live request counter is not a DOM ref; invalidate outstanding approvals on context replacement.
    return () => { epoch.current++ }
  }, [context, journal])

  function currentStore(source: PaperJournal) {
    const sessionId = source.snapshot().sessionId
    if (!sessionId) throw new PanelError('Prepare the stopped paper session before signing a mandate.')
    if (!store.current || store.current.journal !== source || store.current.sessionId !== sessionId) {
      store.current = { journal: source, sessionId, value: new AgentMandateStore(window.localStorage, sessionId) }
    }
    return store.current.value
  }
  function refresh(source: PaperJournal | null) {
    try {
      const active = source && source.snapshot().sessionId ? currentStore(source).load().active : null
      setSaved({ active, digest: active ? agentMandateDigest(active.payload) : null, error: '', loaded: true })
    } catch { setSaved({ active: null, digest: null, error: 'Local authorization is unreadable. Execution remains stopped; do not clear storage to reset a budget.', loaded: true }) }
  }
  useEffect(() => {
    alive.current = true
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Read the latest callback and request counter on actual unmount, never captured DOM nodes.
    return () => { alive.current = false; epoch.current++; handlers.current.onPendingChange?.(false) }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    queueMicrotask(() => { if (alive.current && !abort.signal.aborted) refresh(journal) })
    const changed = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith('0xpay-paper-')) return
      epoch.current++; setReview(null)
      refresh(journal)
      void handlers.current.onStop().catch(() => {})
    }
    window.addEventListener('storage', changed)
    return () => {
      abort.abort()
      window.removeEventListener('storage', changed)
    }
  }, [journal])
  useEffect(() => {
    if (typeof review?.provider.on !== 'function' || typeof review.provider.removeListener !== 'function') return
    const changed = () => {
      epoch.current++; setReview(null)
      setError('The browser account or network changed. Prepare a new policy review; no pending approval will be activated.')
      void handlers.current.onStop().catch(() => {})
    }
    review.provider.on('accountsChanged', changed); review.provider.on('chainChanged', changed)
    return () => { review.provider.removeListener?.('accountsChanged', changed); review.provider.removeListener?.('chainChanged', changed) }
  }, [review])

  function begin() {
    if (pending.current) return null
    pending.current = true; setBusy(true); handlers.current.onPendingChange?.(true)
    setError(''); setMessage('')
    return ++epoch.current
  }
  function finish() {
    pending.current = false
    if (alive.current) { setBusy(false); handlers.current.onPendingChange?.(false) }
  }
  function valid(request: number, source: PaperJournal) {
    return alive.current && epoch.current === request && currentContext.current.context === context && currentContext.current.journal === source
  }
  function assertCurrent(request: number, source: PaperJournal, provider?: BrowserSigner) {
    if (!valid(request, source) || provider && injectedSigner() !== provider) throw new PanelError('The approval context changed. No pending mandate was activated; review the current policy again.')
  }

  async function prepare() {
    if (!canPrepare || !policy || !marketId || !watchedAccount || !journal) return
    const request = begin(); if (request === null) return
    try {
      const provider = injectedSigner()
      if (!provider) throw new PanelError('No browser wallet was found. Open this page in the browser where your wallet extension is installed. The paper agent never receives your wallet key.')
      await handlers.current.onStop(); assertCurrent(request, journal, provider)
      await journal.setStopped(true); assertCurrent(request, journal, provider)
      const sessionId = journal.snapshot().sessionId
      if (!sessionId) throw new PanelError('The paper session could not be saved. No mandate can be signed.')
      const owner = approvingAccount(await provider.request({ method: 'eth_requestAccounts' })); assertCurrent(request, journal, provider)
      requirePolygon(await provider.request({ method: 'eth_chainId' })); assertCurrent(request, journal, provider)
      const random = crypto.getRandomValues(new Uint8Array(32))
      const payload = createAgentMandate({ version: 1, sessionId, nonce: `0x${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`,
        owner, watchedAccount, chainId: 137, agentId: AGENT_ID, agentName: AGENT_NAME, allowedMarketIds: [...policy.allowedMarketIds],
        budgetMicros: policy.sessionBudgetMicros, maxOrderMicros: policy.maxOrderMicros, maxPriceMicros: policy.maxPriceMicros,
        maxSpreadMicros: policy.maxSpreadMicros, maxOutcomeSharesMicros: policy.maxOutcomeSharesMicros,
        expiresAt: Math.floor(policy.expiresAt / 1000), canSignTransactions: false })
      currentStore(journal).load()
      setReview({ provider, payload, context, journal }); refresh(journal)
      setMessage('Review every limit below, then approve the paper-policy signature in your wallet.')
    } catch (cause) { if (alive.current && currentContext.current.journal === journal) setError(safeError(cause)) }
    finally { finish() }
  }

  async function sign() {
    if (!currentReview || !journal) return
    const request = begin(); if (request === null) return
    const { provider, payload } = currentReview
    try {
      await handlers.current.onStop(); assertCurrent(request, journal, provider)
      await journal.setStopped(true); assertCurrent(request, journal, provider)
      if (journal.snapshot().sessionId !== payload.sessionId) throw new PanelError('The paper session changed. Prepare a new policy review.')
      createAgentMandate(payload)
      if (approvingAccount(await provider.request({ method: 'eth_requestAccounts' })) !== payload.owner) throw new PanelError('The selected signer changed. Prepare a new policy review.')
      requirePolygon(await provider.request({ method: 'eth_chainId' })); assertCurrent(request, journal, provider)
      const typed = agentMandateTypedData(payload)
      const typedV4 = { ...typed, types: { EIP712Domain: DOMAIN_FIELDS, ...typed.types } }
      const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [payload.owner, JSON.stringify(typedV4)] })
      assertCurrent(request, journal, provider)
      await handlers.current.onStop(); assertCurrent(request, journal, provider)
      await journal.setStopped(true); assertCurrent(request, journal, provider)
      if (approvingAccount(await provider.request({ method: 'eth_requestAccounts' })) !== payload.owner) throw new PanelError('The selected signer changed during approval. No new mandate was activated.')
      requirePolygon(await provider.request({ method: 'eth_chainId' })); assertCurrent(request, journal, provider)
      const envelope = { domain: typed.domain, payload, signature }
      validateSignedAgentMandate(envelope, Math.floor(Date.now() / 1000))
      await journal.revokeAuthorization(() => {
        assertCurrent(request, journal, provider)
        if (journal.snapshot().sessionId !== payload.sessionId) throw new PanelError('The paper session changed. No pending mandate was activated.')
        currentStore(journal).activate(envelope, payload.owner)
      })
      if (!valid(request, journal)) return
      refresh(journal); setReview(null); setMessage('Signed paper policy saved. The runner is stopped until you explicitly start it.'); handlers.current.onChanged()
    } catch (cause) { if (alive.current && currentContext.current.journal === journal) { refresh(journal); setError(safeError(cause)) } }
    finally { finish() }
  }

  async function revoke() {
    if (!journal || !saved.active) return
    const request = begin(); if (request === null) return
    try {
      await handlers.current.onStop(); assertCurrent(request, journal)
      await journal.revokeAuthorization(() => { assertCurrent(request, journal); currentStore(journal).revokeActive() })
      if (!valid(request, journal)) return
      refresh(journal); setReview(null); setMessage('Paper policy revoked in this browser. The runner is stopped.'); handlers.current.onChanged()
    } catch (cause) { if (alive.current && currentContext.current.journal === journal) { refresh(journal); setError(safeError(cause)) } }
    finally { finish() }
  }

  return <section className="agent-card agent-mandate" aria-labelledby="agent-mandate-title" aria-busy={busy}>
    <h2 id="agent-mandate-title">Paper-agent permission</h2>
    <p className="agent-card-intro">Paper policy only. No token approval or spending key. A browser EOA signs the limits; the agent cannot sign transactions or place real orders.</p>
    {saved.active ? <div className="agent-mandate-saved"><p><strong>Signed paper mandate</strong></p><dl><div><dt>Approving signer</dt><dd><code>{saved.active.payload.owner}</code></dd></div><div><dt>Signed market IDs</dt><dd>{saved.active.payload.allowedMarketIds.join(', ')}</dd></div><div><dt>Signed assessed account</dt><dd><code>{saved.active.payload.watchedAccount}</code></dd></div><div><dt>Policy digest</dt><dd><code>{saved.digest}</code></dd></div><div><dt>Expires</dt><dd>{new Date(saved.active.payload.expiresAt * 1000).toLocaleString()}</dd></div></dl><button className="agent-quiet-button" type="button" disabled={busy} onClick={() => { void revoke() }}>Revoke paper policy</button></div> : <p className="agent-mandate-state">{saved.error ? 'Authorization status unavailable' : !saved.loaded ? 'Reading local authorization…' : 'No signed mandate'}</p>}
    {policy ? <Limits policy={policy} watchedAccount={watchedAccount} /> : <p>Evaluate a proposal to review its exact paper limits before signing.</p>}
    {currentReview && <div className="agent-mandate-review"><h3>Review before wallet approval</h3><dl><div><dt>Signer</dt><dd><code>{currentReview.payload.owner}</code></dd></div><div><dt>Agent</dt><dd>{currentReview.payload.agentName} · <code>{currentReview.payload.agentId}</code></dd></div><div><dt>Network</dt><dd>Polygon · chain 137</dd></div><div><dt>Paper session</dt><dd><code>{currentReview.payload.sessionId}</code></dd></div><div><dt>Nonce</dt><dd><code>{currentReview.payload.nonce}</code></dd></div></dl><p>The signature binds the displayed market IDs, assessed account, limits and expiry. This is an offchain authorization with no token allowance.</p></div>}
    <div className="agent-mandate-actions"><button className="agent-quiet-button" type="button" disabled={busy || !canPrepare} onClick={() => { void prepare() }}>{currentReview ? 'Refresh policy review' : running ? 'Stop and prepare paper policy' : 'Prepare signed paper policy'}</button>{currentReview && <button className="agent-quiet-button" type="button" disabled={busy} onClick={() => { void sign() }}>Sign paper policy</button>}</div>
    {!canPrepare && <p className="agent-card-intro">A selected market, assessed account, explicit share cap and usable paper journal are required.</p>}
    <p className="agent-card-intro">The public signature and assessed account are saved locally with this paper session. Neither is sent to model research. No wallet key is requested.</p>
    {message && <p role="status">{message}</p>}{(error || saved.error) && <p className="agent-inline-error" role="alert">{error || saved.error}</p>}
  </section>
}
