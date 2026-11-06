import { useCallback, useEffect, useRef, useState } from 'react'
import Dashboard, { formatEth, type DashboardData, type DashboardErrors } from '../dashboard/Dashboard'
import type { Address, ClaimStep, PayApi } from './types'
import type { PoolApi } from '../pool/api'
import { adaptPoolApi } from './adapter'
import logo from '../assets/0xpay-logo.png'
import QrCode from './QrCode'
import NoteBackupControls from './NoteBackupControls'
import { WalletViewGate } from './view-gate'
import { clearImportedPaymentLink } from './payment-link-url'
import { depositGate } from './deposit-gate'
import './PayApp.css'

type Screen = 'dashboard' | 'deposit' | 'send' | 'link' | 'claim'
const emptyData: DashboardData = { publicBalance: null, privateBalance: null, notes: null, tokens: null, activity: null }
const noteWei = 10n ** 17n
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`
const validAddress = (value: string): value is Address => /^0x[a-fA-F0-9]{40}$/.test(value)

function Stepper({ steps, count = 1 }: { steps: ClaimStep[]; count?: number }) {
  const grouped = Array.from({ length: count }, (_, index) => steps.filter((step) => (step.noteIndex ?? 0) === index))
  return <div className="px-stepper-list">{grouped.map((events, i) => {
    const find = <K extends ClaimStep['kind']>(kind: K) => events.find((step) => step.kind === kind) as Extract<ClaimStep, { kind: K }> | undefined
    const key = find('key'), proof = find('proof'), preflight = find('preflight'), canonical = find('canonical'), alt = find('alt'), included = find('included'), balance = find('balance')
    return <section className="px-stepper" key={i} aria-label={`Note ${i + 1} progress`} aria-live="polite">{count > 1 && <h3>Note {i + 1}</h3>}
      <div className={key ? 'done' : events.length ? 'active' : ''}><span className="px-step-dot" /><div><strong>Fresh claim account</strong><small>{key ? `${short(key.address)} · ${formatEth(key.balanceWei, 8)} ETH before submission` : 'Checking the claim account before signing'}</small></div></div>
      <div className={proof ? 'done' : events.length ? 'active' : ''}><span className="px-step-dot" /><div><strong>Build private proof</strong><small>{proof ? `Completed in ${(proof.ms / 1000).toFixed(1)}s` : events.length ? 'Preparing claim in your browser…' : 'Waiting to start'}</small></div></div>
      <div className={preflight ? 'done' : ''}><span className="px-step-dot" /><div><strong>Simulate signed claim</strong><small>{preflight ? 'All frames passed before submission' : 'Waiting for the exact signed transaction'}</small></div></div>
      <div className={canonical ? canonical.accepted ? 'warn' : 'done' : ''}><span className="px-step-dot" /><div><strong>Public mempool {canonical ? canonical.accepted ? 'ACCEPTED' : 'REJECTED' : 'check'}</strong><small>{canonical ? canonical.reason : 'Awaiting real response'}</small>{canonical && !canonical.accepted && <small>Canonical rules limit validation gas and payer storage access.</small>}</div></div>
      <div className={alt ? alt.accepted ? 'done' : 'warn' : ''}><span className="px-step-dot" /><div><strong>Alt mempool {alt ? alt.accepted ? 'ADMITTED' : 'REJECTED' : 'submission'}</strong><small>{alt?.reason ?? (alt?.txHash ? short(alt.txHash) : 'Awaiting real response')}</small></div></div>
      <div className={included ? 'done' : ''}><span className="px-step-dot" /><div><strong>{included ? `Included in block ${included.blockNumber}` : 'Inclusion'}</strong>{included && <><small>Transaction hash · <code>{included.txHash}</code></small><a href={included.explorerUrl} target="_blank" rel="noopener noreferrer">Open explorer · search hash ↗</a></>}</div></div>
      <div className={balance ? 'done' : ''}><span className="px-step-dot" /><div><strong>Recipient balance</strong><small>{balance ? `${formatEth(balance.balanceWei, 8)} ETH · ${short(balance.address)}` : 'Waiting for chain balance'}</small></div></div>
    </section>
  })}</div>
}

function FrameDiagram() {
  return <svg className="px-frame-svg" role="img" aria-label="Frame transaction: verify fresh sender, verify pool proof and payment, then claim from pool" viewBox="0 0 680 126" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="12" width="190" height="100" rx="16" fill="currentColor" opacity=".08"/><text x="20" y="50">01 · VERIFY</text><text x="20" y="78">Fresh sender</text><path d="M198 62h30m-8-7 8 7-8 7" stroke="currentColor" fill="none"/><rect x="236" y="12" width="207" height="100" rx="16" fill="currentColor" opacity=".08"/><text x="255" y="50">02 · VERIFY</text><text x="255" y="78">Pool proof + gas</text><path d="M450 62h30m-8-7 8 7-8 7" stroke="currentColor" fill="none"/><rect x="488" y="12" width="191" height="100" rx="16" fill="currentColor" opacity=".08"/><text x="507" y="50">03 · SENDER</text><text x="507" y="78">Pool claim</text></svg>
}

export default function PayAppView({ api, connectionReady = true, connectionMessage, connectionVersion = 0 }: { api: PayApi; connectionReady?: boolean; connectionMessage?: string; connectionVersion?: number }) {
  const [screen, setScreen] = useState<Screen>(() => window.location.hash.startsWith('#claim=') ? 'claim' : 'dashboard')
  const [theme, setTheme] = useState<'dark' | 'light'>('light')
  // Start without querying the funding address. Showing public balances is an
  // explicit user choice; pool/note reads still use the selected private RPC.
  const [privateNotesOnly, setPrivateNotesOnly] = useState(true)
  const [data, setData] = useState<DashboardData>(emptyData)
  const [dataErrors, setDataErrors] = useState<DashboardErrors>({})
  const [error, setError] = useState('')
  const [operationState, setOperationState] = useState({ api, busy: false })
  const busy = operationState.api === api && operationState.busy
  const setBusy = (value: boolean) => setOperationState({ api, busy: value })
  const [drawer, setDrawer] = useState(false)
  const [count, setCount] = useState(1)
  const [activeSendCount, setActiveSendCount] = useState<number | null>(null)
  const [recipient, setRecipient] = useState('')
  const [review, setReview] = useState(false)
  const [steps, setSteps] = useState<ClaimStep[]>([])
  const [done, setDone] = useState(false)
  const [link, setLink] = useState('')
  const [importedClaims, setImportedClaims] = useState<Address[]>([])
  const [selectedImportedClaim, setSelectedImportedClaim] = useState<Address | null>(null)
  const [copied, setCopied] = useState(false)
  const [fundingAddressCopied, setFundingAddressCopied] = useState(false)
  const [fundingRequestStatus, setFundingRequestStatus] = useState('')
  const [checkingHash, setCheckingHash] = useState<Address | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState('')
  const viewGate = useRef(new WalletViewGate())
  const backupTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const gate = viewGate.current
    gate.invalidate()
    return () => gate.invalidate()
  }, [api])
  const route = api.route()
  const privateRouteReady = connectionReady && route.kind === 'anon-rpc' && route.direct === 0
  const nymPaymentUnavailable = route.kind === 'anon-rpc' && route.worker === 'nym'
  const simulated = new URLSearchParams(window.location.search).get('stub') === '1'

  const refresh = useCallback(() => {
    const ticket = viewGate.current.beginRead()
    setData(emptyData)
    setDataErrors({})
    const read = <K extends keyof DashboardData>(key: K, promise: Promise<DashboardData[K]>) => promise.then(value => {
      if (viewGate.current.isReadCurrent(ticket)) setData(current => ({ ...current, [key]: value }))
    }).catch(() => {
      if (viewGate.current.isReadCurrent(ticket)) setDataErrors(current => ({ ...current, [key]: true }))
    })
    if (!privateNotesOnly) void read('publicBalance', api.getPublicBalance())
    void read('privateBalance', api.getPrivateBalance())
    const reconciledNotes = api.listNotes()
    void read('notes', reconciledNotes.then(notes => {
      if (viewGate.current.isReadCurrent(ticket)) setImportedClaims(notes.filter(note => note.source === 'link' && note.spent !== true && note.commitment).map(note => note.commitment!))
      return notes.filter(note => note.spent !== true).length
    }))
    if (!privateNotesOnly) void read('tokens', api.tokenPortfolio())
    // Restored notes are reserved until the chain check finishes. Read local
    // activity afterward so a confirmed note is not left labelled pending.
    void read('activity', reconciledNotes.then(() => api.activity(), () => api.activity()))
  }, [api, privateNotesOnly])
  useEffect(() => {
    let cancelled = false
    void api.activity().then(activity => {
      if (!cancelled) setData(current => ({ ...current, activity }))
    }).catch(() => {
      if (!cancelled) setDataErrors(current => ({ ...current, activity: true }))
    })
    return () => { cancelled = true }
  }, [api])
  useEffect(() => {
    let cancelled = false
    if (connectionReady && !busy) queueMicrotask(() => { if (!cancelled) refresh() })
    return () => { cancelled = true }
  }, [refresh, connectionReady, connectionVersion, busy])
  useEffect(() => { const onHash = () => { if (!viewGate.current.busy && window.location.hash.startsWith('#claim=')) setScreen('claim') }; window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash) }, [])

  const navigate = (next: Screen) => { if (viewGate.current.busy) return; if (next === 'deposit') setPrivateNotesOnly(false); if (next === 'send') setCount(1); setActiveSendCount(null); setScreen(next); setError(''); setReview(false); setSteps([]); setDone(false); if (next === 'dashboard' && connectionReady) refresh() }
  const run = async (operation: (emit: (step: ClaimStep) => void) => Promise<unknown>, onComplete?: (result: unknown) => void) => {
    if (!connectionReady) { setError('Reconnect the private connection before continuing.'); return }
    if (nymPaymentUnavailable) { setError('Nox required for payment. Switch privacy network in Connection before depositing, sending, or claiming.'); return }
    const ticket = viewGate.current.beginOperation()
    if (!ticket) return
    setError(''); setSteps([]); setDone(false); setBusy(true)
    const emit = (step: ClaimStep) => { if (viewGate.current.isCurrent(ticket)) setSteps(current => [...current, step]) }
    try {
      const result = await operation(emit)
      if (viewGate.current.isCurrent(ticket)) { onComplete?.(result); setDone(true) }
    } catch (e) {
      if (viewGate.current.isCurrent(ticket)) setError(e instanceof Error ? e.message : String(e))
    } finally { if (viewGate.current.finish(ticket)) setBusy(false) }
  }
  const checkExisting = async (hash: Address) => {
    if (!api.checkPendingPayment || !connectionReady || busy || checkingHash) return
    setCheckingHash(hash); setRecoveryStatus('')
    try {
      const result = await api.checkPendingPayment(hash)
      setRecoveryStatus(result.status === 'verified'
        ? `Verified ${result.operation} in block ${result.blockNumber}.`
        : 'No receipt yet. The note remains reserved; check this same transaction later.')
      if (result.status === 'verified') refresh()
    } catch (cause) {
      setRecoveryStatus(`Could not verify ${short(hash)}: ${cause instanceof Error ? cause.message : String(cause)}. The note remains reserved.`)
    } finally { setCheckingHash(null) }
  }
  const requestDevnetFunds = async () => {
    if (!api.requestDevnetFunds || !connectionReady || nymPaymentUnavailable) return
    const ticket = viewGate.current.beginOperation()
    if (!ticket) return
    setBusy(true); setError(''); setFundingRequestStatus('Requesting devnet ETH and waiting for the faucet transaction.')
    try {
      const hash = await api.requestDevnetFunds()
      if (viewGate.current.isCurrent(ticket)) {
        setFundingRequestStatus(`Faucet transaction included: ${short(hash)}.`)
        refresh()
      }
    } catch (cause) {
      if (viewGate.current.isCurrent(ticket)) {
        setFundingRequestStatus('')
        setError(`Faucet request failed: ${cause instanceof Error ? cause.message : String(cause)}. Refresh the balance before requesting again.`)
      }
    } finally { if (viewGate.current.finish(ticket)) setBusy(false) }
  }
  const importClaim = async () => {
    if (!connectionReady || busy || !window.location.hash.startsWith('#claim=')) return
    const ticket = viewGate.current.beginOperation()
    if (!ticket) return
    const fragment = window.location.hash
    const linkToImport = window.location.href
    setBusy(true); setError('')
    try {
      const commitment = await api.importPaymentLink(linkToImport)
      if (!viewGate.current.isCurrent(ticket)) return
      setSelectedImportedClaim(commitment)
      const cleanup = clearImportedPaymentLink(fragment)
      if (cleanup === 'failed') setError('The note was saved, but the browser kept its secret in the address bar. Remove the link before sharing your screen.')
      if (cleanup === 'not-current') setError('The note was saved, but the address bar changed before its secret could be cleared. Check the current link.')
    } catch (cause) {
      if (viewGate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (viewGate.current.finish(ticket)) { setBusy(false); refresh() }
    }
  }
  const pendingPayments = data.activity?.filter(item => item.pending && item.txHash) ?? []
  const hasPendingDeposit = pendingPayments.some(item => item.operation === 'deposit')
  const depositQuote = api.getDepositQuote?.(count)
  const fundingAddress = api.getFundingAddress?.() ?? null
  const depositStatus = depositGate({ routeReady: connectionReady, routeConnecting: Boolean(connectionMessage?.startsWith('Connecting privately')), paymentWorkerReady: !nymPaymentUnavailable,
    activityLoaded: data.activity !== null, activityFailed: Boolean(dataErrors.activity), pendingDeposit: hasPendingDeposit,
    balanceWei: data.publicBalance, balanceFailed: Boolean(dataErrors.publicBalance), maximumDebitWei: depositQuote?.maximumDebitWei })
  const amount = `${formatEth(BigInt(count) * noteWei, 1)} ETH`
  const privateNotes = data.notes
  const sendCount = activeSendCount ?? (privateNotes === null ? count : Math.min(count, Math.max(1, privateNotes)))
  const sendAmount = `${formatEth(BigInt(sendCount) * noteWei, 1)} ETH`
  const canSend = validAddress(recipient) && privateNotes !== null && privateNotes > 0 && sendCount <= privateNotes
  const sendQuote = api.getClaimQuote?.(sendCount)
  const claimQuote = api.getClaimQuote?.(1)
  const claimFragment = window.location.hash.startsWith('#claim=') ? window.location.href : ''
  const claimableImport = selectedImportedClaim ?? importedClaims[0] ?? null
  const dashboardErrors = { ...dataErrors }
  if (!connectionReady && connectionMessage && !connectionMessage.startsWith('Connecting privately')) {
    for (const key of ['publicBalance', 'privateBalance', 'notes', 'tokens'] as const) {
      if (data[key] === null) dashboardErrors[key] = true
    }
  }

  return <div className={`px-app px-${theme}`}>
    {simulated && <div className="px-simulated" role="status">SIMULATED · Visual preview only. No chain transactions.</div>}
    {!connectionReady && <div className={connectionMessage?.startsWith('Connecting privately') ? 'px-route-wait' : 'px-error'} role="status">{connectionMessage ?? "Reconnect the private connection to continue. Your current payment remains on this screen."}</div>}
    {nymPaymentUnavailable && connectionReady && <div className="px-route-wait" role="status">Nym supports private lookups here. Nox required for payment; choose Nox in Connection before depositing, sending, or claiming.</div>}
    <header className="px-header"><button disabled={busy} className="px-brand" onClick={() => navigate('dashboard')} aria-label="0xPay dashboard"><img src={logo} alt="" /><span>0xPay<small>PRIVATE WALLET</small></span></button><nav aria-label="Wallet navigation"><button disabled={busy} aria-current={screen === 'dashboard' ? 'page' : undefined} onClick={() => navigate('dashboard')}>Overview</button><button disabled={busy} aria-current={screen === 'send' ? 'page' : undefined} onClick={() => navigate('send')}>Send</button><button disabled={busy} aria-current={screen === 'link' || screen === 'claim' ? 'page' : undefined} onClick={() => navigate('link')}>Links</button></nav><div className="px-header-end"><span className={`px-route ${privateRouteReady ? 'px-route-ok' : 'px-route-direct'}`} title={route.calls === null ? 'Route statistics unavailable' : `${route.calls} routed calls · ${route.direct} direct calls`}><i />{!connectionReady ? 'Private connection unavailable' : nymPaymentUnavailable ? 'Private lookup · Anon-RPC NYM' : route.kind === 'anon-rpc' && route.worker ? `Private route · Anon-RPC ${route.worker.toUpperCase()}` : route.kind === 'direct' ? 'Direct RPC route' : 'Route status unavailable'}</span><button className="px-theme-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? '☼' : '◐'}</button></div></header>
    <main className="px-main" aria-busy={busy}>
      {screen === 'dashboard' && <>
        <Dashboard data={data} errors={dashboardErrors} onNavigate={navigate} onRetry={refresh} canRetry={connectionReady && !busy} privateNotesOnly={privateNotesOnly} onPrivateNotesOnlyChange={setPrivateNotesOnly} />
        {importedClaims.length > 0 && <section className="px-flow-card" aria-label="Imported payment notes"><h2>Received payment note</h2><p>{importedClaims.length} imported {importedClaims.length === 1 ? 'note is' : 'notes are'} saved in this encrypted wallet. Claim one into your public account when ready. The payout address and amount will be public.</p><button type="button" className="px-button px-button-primary" disabled={busy} onClick={() => navigate('claim')}>Claim received note ↗</button></section>}
        {pendingPayments.length > 0 && <section className="px-flow-card" aria-label="Payments awaiting verification">
          <h2>Check existing payments</h2>
          <p>A previous response was lost or verification did not finish. These notes remain reserved. Checking reads the exact saved transaction; it never sends again.</p>
          {pendingPayments.map(item => <div className="px-review" key={item.id ?? item.txHash}>
            <strong>{item.operation === 'claim' ? 'Private send' : 'Deposit'} · awaiting verification</strong>
            <code title={item.txHash}>{item.txHash}</code>
            <button type="button" className="px-button px-button-secondary" disabled={!connectionReady || busy || Boolean(checkingHash) || !api.checkPendingPayment} onClick={() => void checkExisting(item.txHash!)}>{checkingHash === item.txHash ? 'Checking…' : 'Check existing transaction'}</button>
          </div>)}
          {!connectionReady && <p>Reconnect the private route to check these payments.</p>}
          {recoveryStatus && <p role="status">{recoveryStatus}</p>}
        </section>}
      </>}
      {screen === 'deposit' && <section className="px-flow">
        <button disabled={busy} className="px-back" onClick={() => navigate('dashboard')}>← Overview</button>
        <p className="px-kicker">ADD FUNDS PRIVATELY</p>
        <h1>Move funds into<br /><em>your private balance.</em></h1>
        <p className="px-lead">Each deposit creates one encrypted 0.1 ETH note in your wallet vault. The deposit itself is public.</p>
        <div className="px-flow-card">
          <label htmlFor="deposit-count">Number of notes</label>
          <div className="px-counter">
            <button disabled={busy} onClick={() => { setCount(Math.max(1, count - 1)); setReview(false) }} aria-label="Remove one note">−</button>
            <strong id="deposit-count">{count}</strong>
            <button disabled={busy} onClick={() => { setCount(Math.min(20, count + 1)); setReview(false) }} aria-label="Add one note">+</button>
          </div>
          <p>{amount} moves from your public balance.</p>
          <div className="px-review px-funding" aria-label="Deposit funding">
            <h2>Funding check</h2>
            <div><span>Funding address</span><strong><code>{fundingAddress ?? 'Unavailable'}</code>{fundingAddress && <button type="button" className="px-copy-address" onClick={() => { void navigator.clipboard.writeText(fundingAddress).then(() => setFundingAddressCopied(true)).catch(() => setError('Could not copy the funding address. Select it above to copy manually.')) }}>{fundingAddressCopied ? 'Copied' : 'Copy'}</button>}</strong></div>
            <div><span>Available</span><strong>{dataErrors.publicBalance ? 'Unavailable' : data.publicBalance === null ? 'Checking…' : `${formatEth(data.publicBalance, 8)} ETH`}</strong></div>
            <div><span>Deposit</span><strong>{amount}</strong></div>
            <div><span>Maximum network fee</span><strong>{depositQuote ? `${formatEth(depositQuote.maxNetworkFeeWei, 8)} ETH` : 'Unavailable'}</strong></div>
            <div><span>Required maximum debit</span><strong>{depositQuote ? `${formatEth(depositQuote.maximumDebitWei, 8)} ETH` : 'Unavailable'}</strong></div>
            <p>This is a signed maximum. Actual gas may cost less.</p>
          </div>
          {depositStatus.shortfallWei > 0n && <p className="px-funding-shortfall" role="status">Add at least {formatEth(depositStatus.shortfallWei, 18)} devnet ETH to the address above.</p>}
          {depositStatus.shortfallWei > 0n && api.requestDevnetFunds && <button type="button" className="px-button px-button-secondary" disabled={busy || !connectionReady || nymPaymentUnavailable} onClick={() => void requestDevnetFunds()}>Request 1 devnet ETH</button>}
          {fundingRequestStatus && <p role="status">{fundingRequestStatus}</p>}
          {depositStatus.reason && depositStatus.shortfallWei === 0n && <p role="status">{depositStatus.reason}</p>}
          {(dataErrors.publicBalance || dataErrors.activity) && <button type="button" className="px-button px-button-secondary" disabled={!connectionReady || busy} onClick={refresh}>Retry funding check</button>}
          {review && <div className="px-review"><h2>Review deposit</h2><div><span>Private balance receives</span><strong>{count} encrypted {count === 1 ? 'note' : 'notes'}</strong></div><p>Anyone can see the public deposit. A later claim can be linked by timing or a small anonymity set.</p></div>}
          {!review
            ? <button disabled={busy || !depositStatus.ready} className="px-button px-button-primary" onClick={() => setReview(true)}>Review deposit ↗</button>
            : <button disabled={busy || done || !depositStatus.ready} className="px-button px-button-primary" onClick={() => void run(emit => api.depositNotes(count, emit))}>{busy ? 'Depositing…' : done ? 'Deposited' : 'Confirm deposit'}</button>}
        </div>
        {steps.length > 0 && <div className="px-event-log" role="status">{steps.map((step, i) => <p key={i}>{step.kind === 'included' ? `Included in block ${step.blockNumber}` : step.kind}</p>)}</div>}
        {done && <div className="px-success"><p role="status">Deposit included. Back up the encrypted note before restoring on another device; recovery words alone do not restore notes.</p><button type="button" className="px-button px-button-secondary" disabled={busy} onClick={() => backupTrigger.current?.click()}>Back up this note</button></div>}
      </section>}
      {screen === 'send' && <section className="px-flow">
        <button disabled={busy} className="px-back" onClick={() => navigate('dashboard')}>← Overview</button>
        <p className="px-kicker">PRIVATE SEND</p>
        <h1>A private transfer,<br /><em>made simple.</em></h1>
        <p className="px-lead">Send from your encrypted notes. The recipient needs no ETH and takes no action.</p>
        {privateNotes === null ? <div className="px-flow-card" role="status"><h2>{dataErrors.notes ? 'Could not read private notes' : 'Checking your private notes'}</h2><p>{!connectionReady ? 'Reconnect the private route to check your notes.' : dataErrors.notes ? 'The note check failed. No payment can start until it succeeds.' : 'Your available amount will appear when the wallet finishes reading the pool.'}</p>{dataErrors.notes && <button className="px-button px-button-secondary" disabled={!connectionReady || busy} onClick={refresh}>Retry note check</button>}</div>
          : privateNotes === 0 ? <div className="px-flow-card"><h2>No private notes ready to send</h2><p>This pool pays in 0.1 ETH notes. Add a note to your private balance before choosing a recipient.</p><button className="px-button px-button-primary" disabled={busy || !connectionReady || nymPaymentUnavailable} onClick={() => navigate('deposit')}>Add to private balance ↗</button></div>
            : <div className="px-flow-card">
              <label htmlFor="send-count">Amount</label>
              <div className="px-counter"><button disabled={busy || done || sendCount <= 1} onClick={() => { setActiveSendCount(null); setCount(Math.max(1, sendCount - 1)); setReview(false) }} aria-label="Remove 0.1 ETH">−</button><strong id="send-count">{sendAmount}</strong><button disabled={busy || done || sendCount >= Math.min(20, privateNotes)} onClick={() => { setActiveSendCount(null); setCount(Math.min(20, privateNotes, sendCount + 1)); setReview(false) }} aria-label="Add 0.1 ETH">+</button></div>
              <p>Each note holds 0.1 ETH. {sendCount} {sendCount === 1 ? 'note' : 'notes'} selected · {privateNotes} available. The recipient gets the selected amount less the claim fee.</p>
              <label htmlFor="recipient">Recipient address</label>
              <input disabled={busy} id="recipient" className="px-input" value={recipient} onChange={e => { setRecipient(e.target.value.trim()); setReview(false) }} placeholder="0x…" autoComplete="off" spellCheck={false} aria-invalid={recipient.length > 0 && !validAddress(recipient)} />
              <small className="px-help">Fresh wallets work. The recipient needs 0 ETH.</small>
              {review && <div className="px-review"><h2>Review private send</h2><div><span>Private</span><strong>Your wallet address and source note are not in the claim</strong></div><div><span>Public</span><strong>Pool payout · {sendAmount} before fee · {short(recipient)}</strong></div><div><span>Gas</span><strong>The pool pays</strong></div>{sendQuote && <><div><span>Claim fee</span><strong>{formatEth(sendQuote.feeWei, 8)} ETH</strong></div><div><span>Recipient gets</span><strong>{formatEth(sendQuote.recipientWei, 8)} ETH</strong></div></>}<p>The claim fee includes the pool gas budget and margin; it is not the measured network fee. The recipient and payout are public. A small devnet pool and timing can reduce privacy. For routed calls, Anon-RPC hides your IP from the RPC; it still sees request contents.</p></div>}
              {!review ? <button className="px-button px-button-primary" disabled={!canSend || busy || !connectionReady || nymPaymentUnavailable} onClick={() => { setCount(sendCount); setReview(true) }}>Review transfer ↗</button> : <button className="px-button px-button-primary" disabled={!canSend || busy || done || !connectionReady || nymPaymentUnavailable} onClick={() => { setActiveSendCount(sendCount); setCount(sendCount); void run(emit => api.privateSend({ to: recipient as Address, count: sendCount, onStep: emit })) }}>{busy ? 'Sending privately…' : done ? 'Transfer complete' : 'Submit private send'}</button>}
            </div>}
        {steps.length > 0 && <Stepper steps={steps} count={count} />}{done && <p className="px-success" role="status">Private send complete.</p>}
      </section>}
      {screen === 'link' && <section className="px-flow"><button disabled={busy} className="px-back" onClick={() => navigate('dashboard')}>← Overview</button><p className="px-kicker">PAYMENT LINK</p><h1>Send a note.<br /><em>Share a link.</em></h1><p className="px-lead">The link contains a bearer secret in its URL fragment. Anyone with it can claim the note. Share it privately.</p><div className="px-flow-card"><h2>Create a payment link</h2><p>A 0.1 ETH note is deposited and encoded into a link. The receiver claims it into their wallet with a fresh 0 ETH key. Until then, your wallet still holds the same note and can claim it too; this link is not a completed payment.</p><button className="px-button px-button-primary" disabled={busy || Boolean(link) || !connectionReady || nymPaymentUnavailable} onClick={() => void run(() => api.createPaymentLink(), result => setLink(String(result)))}>{busy ? 'Creating link…' : link ? 'Link ready' : 'Create 0.1 ETH link'}</button>{link && <div className="px-link-result"><QrCode value={link} /><label htmlFor="created-link">Bearer link · keep private</label><input id="created-link" value={link} readOnly /><button className="px-button px-button-secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setError('Clipboard unavailable; select and copy the link.'))}>{copied ? 'Copied' : 'Copy link'}</button></div>}</div></section>}
      {screen === 'claim' && <section className="px-flow"><p className="px-kicker">CLAIM PAYMENT LINK</p><h1>A private payment<br /><em>is waiting for you.</em></h1><p className="px-lead">Import the bearer note into your encrypted wallet first. The app then removes its secret from this page's address bar. A fresh 0 ETH key submits the claim; the payout address and amount are public on chain.</p><div className="px-flow-card"><h2>Claim 0.1 ETH note</h2>{claimQuote ? <p>The pool pays gas. Claim fee: <strong>{formatEth(claimQuote.feeWei, 8)} ETH</strong>. Your wallet receives <strong>{formatEth(claimQuote.recipientWei, 8)} ETH</strong>. This fee covers the pool gas budget and margin, not the measured network fee.</p> : <p>The pool pays gas from the note. Review its claim fee before submitting.</p>}{claimFragment ? <button className="px-button px-button-primary" disabled={busy || !connectionReady} onClick={() => void importClaim()}>{busy ? 'Importing…' : 'Import note to wallet'}</button> : claimableImport ? <button className="px-button px-button-primary" disabled={busy || done || !connectionReady || nymPaymentUnavailable} onClick={() => void run(emit => api.claimImportedLink(claimableImport, emit), () => refresh())}>{busy ? 'Claiming…' : done ? 'Claim complete' : 'Claim privately'}</button> : <p>No payment note is ready. Open a payment link or import one into this wallet.</p>}</div>{steps.length > 0 && <Stepper steps={steps} />}</section>}
      {error && <div className="px-error" role="alert">{error}</div>}
      <footer className="px-footer"><div><strong>0xPay</strong><span>Privacy, in your hands.</span></div><button onClick={() => setDrawer(true)}>How it works ↗</button><NoteBackupControls api={api} paymentBusy={busy} triggerRef={backupTrigger} onRestored={() => { if (connectionReady) refresh() }} /><a href="https://github.com/Anand-0037" target="_blank" rel="noopener noreferrer">Anand on GitHub</a><small>Devnet only · DEV trusted setup · Unaudited · Draft ERC-8421</small></footer>
    </main>
    {drawer && <div className="px-drawer-backdrop" onClick={() => setDrawer(false)}><aside className="px-drawer" role="dialog" aria-modal="true" aria-label="How it works" onClick={e => e.stopPropagation()}><button className="px-drawer-close" onClick={() => setDrawer(false)} aria-label="Close">×</button><p className="px-kicker">UNDER THE HOOD</p><h2>Three frames.<br />One private payout.</h2><FrameDiagram /><p>A fresh 0 ETH sender verifies execution. The staked pool verifies the proof and approves payment. The final frame sends funds to the recipient.</p><p>The canonical mempool’s validation gas and storage rules reject this claim. A correctly configured alternative mempool can admit this staked payer. An earlier CLI claim was included on the public devnet after the sidecar configuration was corrected. That earlier receipt is separate from this wallet’s current payment. The live transfer shows its actual response.</p><p>No trusted relayer is needed. Sidecars and block builders still handle inclusion. The pool requires an ETH gas float. The RPC sees request contents even when Anon-RPC hides your client IP for routed calls.</p></aside></div>}
  </div>
}

/** Wallet host integration while the pool API is being finalized. */
export function PayApp({ api }: { api: PoolApi }) { return <PayAppView api={adaptPoolApi(api)} /> }
