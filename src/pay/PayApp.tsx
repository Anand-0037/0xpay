import { useCallback, useEffect, useState } from 'react'
import Dashboard, { formatEth, type DashboardData } from '../dashboard/Dashboard'
import type { Address, ClaimStep, PayApi } from './types'
import type { PoolApi } from '../pool/api'
import { adaptPoolApi } from './adapter'
import logo from '../assets/0xpay-logo.png'
import QrCode from './QrCode'
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
    const proof = find('proof'), canonical = find('canonical'), alt = find('alt'), included = find('included'), balance = find('balance')
    return <section className="px-stepper" key={i} aria-label={`Note ${i + 1} progress`}>{count > 1 && <h3>Note {i + 1}</h3>}
      <div className={proof ? 'done' : events.length ? 'active' : ''}><span className="px-step-dot" /><div><strong>Build private proof</strong><small>{proof ? `Completed in ${(proof.ms / 1000).toFixed(1)}s` : events.length ? 'Preparing claim in your browser…' : 'Waiting to start'}</small></div></div>
      <div className={canonical ? canonical.accepted ? 'warn' : 'done' : ''}><span className="px-step-dot" /><div><strong>Public mempool {canonical ? canonical.accepted ? 'ACCEPTED' : 'REJECTED' : 'check'}</strong><small>{canonical ? canonical.reason : 'Awaiting real response'}</small>{canonical && !canonical.accepted && <small>Canonical rules limit validation gas and payer storage access.</small>}</div></div>
      <div className={alt ? alt.accepted ? 'done' : 'warn' : ''}><span className="px-step-dot" /><div><strong>Alt mempool {alt ? alt.accepted ? 'ADMITTED' : 'REJECTED' : 'submission'}</strong><small>{alt?.reason ?? (alt?.txHash ? short(alt.txHash) : 'Awaiting real response')}</small></div></div>
      <div className={included ? 'done' : ''}><span className="px-step-dot" /><div><strong>{included ? `Included in block ${included.blockNumber}` : 'Inclusion'}</strong>{included && <a href={included.explorerUrl} target="_blank" rel="noopener noreferrer">Open explorer · search hash ↗</a>}</div></div>
      <div className={balance ? 'done' : ''}><span className="px-step-dot" /><div><strong>Recipient balance</strong><small>{balance ? `${formatEth(balance.balanceWei)} ETH · ${short(balance.address)}` : 'Waiting for chain balance'}</small></div></div>
    </section>
  })}</div>
}

function FrameDiagram() {
  return <svg className="px-frame-svg" role="img" aria-label="Frame transaction: verify fresh sender, verify pool proof and payment, then claim from pool" viewBox="0 0 680 126" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="12" width="190" height="100" rx="16" fill="currentColor" opacity=".08"/><text x="20" y="50">01 · VERIFY</text><text x="20" y="78">Fresh sender</text><path d="M198 62h30m-8-7 8 7-8 7" stroke="currentColor" fill="none"/><rect x="236" y="12" width="207" height="100" rx="16" fill="currentColor" opacity=".08"/><text x="255" y="50">02 · VERIFY</text><text x="255" y="78">Pool proof + gas</text><path d="M450 62h30m-8-7 8 7-8 7" stroke="currentColor" fill="none"/><rect x="488" y="12" width="191" height="100" rx="16" fill="currentColor" opacity=".08"/><text x="507" y="50">03 · SENDER</text><text x="507" y="78">Pool claim</text></svg>
}

export default function PayAppView({ api }: { api: PayApi }) {
  const [screen, setScreen] = useState<Screen>(() => window.location.hash.startsWith('#claim=') ? 'claim' : 'dashboard')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [data, setData] = useState<DashboardData>(emptyData)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [count, setCount] = useState(1)
  const [recipient, setRecipient] = useState('')
  const [review, setReview] = useState(false)
  const [steps, setSteps] = useState<ClaimStep[]>([])
  const [done, setDone] = useState(false)
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const route = api.route()
  const simulated = new URLSearchParams(window.location.search).get('stub') === '1'

  const refresh = useCallback(() => {
    setData(emptyData)
    const read = <K extends keyof DashboardData>(key: K, promise: Promise<DashboardData[K]>) => promise.then(value => setData(current => ({ ...current, [key]: value }))).catch(e => setError(e instanceof Error ? e.message : 'Could not load wallet data'))
    void read('publicBalance', api.getPublicBalance())
    void read('privateBalance', api.getPrivateBalance())
    void read('notes', api.listNotes().then(notes => notes.filter(note => note.spent !== true).length))
    void read('tokens', api.tokenPortfolio())
    void read('activity', api.activity())
  }, [api])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { const onHash = () => { if (window.location.hash.startsWith('#claim=')) setScreen('claim') }; window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash) }, [])

  const navigate = (next: Screen) => { setScreen(next); setError(''); setReview(false); setSteps([]); setDone(false); setBusy(false); if (next === 'dashboard') refresh() }
  const onStep = (step: ClaimStep) => setSteps(current => [...current, step])
  const run = async (operation: () => Promise<unknown>) => {
    setError(''); setSteps([]); setDone(false); setBusy(true)
    try { await operation(); setDone(true); refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const amount = `${formatEth(BigInt(count) * noteWei, 1)} ETH`
  const privateNotes = data.notes
  const canSend = validAddress(recipient) && (privateNotes === null || count <= privateNotes)
  const claimFragment = window.location.hash.startsWith('#claim=') ? window.location.href : ''

  return <div className={`px-app px-${theme}`}>
    {simulated && <div className="px-simulated" role="status">SIMULATED · Visual preview only. No chain transactions.</div>}
    <header className="px-header"><button className="px-brand" onClick={() => navigate('dashboard')} aria-label="0xPay dashboard"><img src={logo} alt="" /><span>0xPay<small>PRIVATE WALLET</small></span></button><nav aria-label="Wallet navigation"><button aria-current={screen === 'dashboard' ? 'page' : undefined} onClick={() => navigate('dashboard')}>Overview</button><button aria-current={screen === 'send' ? 'page' : undefined} onClick={() => navigate('send')}>Send</button><button aria-current={screen === 'link' || screen === 'claim' ? 'page' : undefined} onClick={() => navigate('link')}>Links</button></nav><div className="px-header-end"><span className={`px-route ${route.kind === 'anon-rpc' && route.direct === 0 ? 'px-route-ok' : 'px-route-direct'}`} title={route.calls === null ? 'Route statistics unavailable' : `${route.calls} routed calls · ${route.direct} direct calls`}><i />{route.kind === 'anon-rpc' && route.worker ? `Private route · Anon-RPC ${route.worker.toUpperCase()}` : route.kind === 'direct' ? 'Direct RPC route' : 'Route status unavailable'}</span><button className="px-theme-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? '☼' : '◐'}</button></div></header>
    <main className="px-main">
      {screen === 'dashboard' && <Dashboard data={data} onNavigate={navigate} />}
      {screen === 'deposit' && <section className="px-flow"><button className="px-back" onClick={() => navigate('dashboard')}>← Overview</button><p className="px-kicker">ADD FUNDS PRIVATELY</p><h1>Move funds into<br /><em>your private balance.</em></h1><p className="px-lead">Each deposit creates one encrypted 0.1 ETH note in your wallet vault. The deposit itself is public.</p><div className="px-flow-card"><label htmlFor="deposit-count">Number of notes</label><div className="px-counter"><button onClick={() => setCount(Math.max(1, count - 1))} aria-label="Remove one note">−</button><strong id="deposit-count">{count}</strong><button onClick={() => setCount(Math.min(20, count + 1))} aria-label="Add one note">+</button></div><p>{amount} moves from your public balance</p>{review && <div className="px-review"><h2>Review deposit</h2><div><span>Public transaction</span><strong>{amount}</strong></div><div><span>Private balance receives</span><strong>{count} encrypted {count === 1 ? 'note' : 'notes'}</strong></div><p>Anyone can see the deposit. Your later claim is unlinkable within the pool’s anonymity set.</p></div>}{!review ? <button className="px-button px-button-primary" onClick={() => setReview(true)}>Review deposit ↗</button> : <button disabled={busy || done} className="px-button px-button-primary" onClick={() => void run(() => api.depositNotes(count, onStep))}>{busy ? 'Depositing…' : done ? 'Deposited' : 'Confirm deposit'}</button>}</div>{steps.length > 0 && <div className="px-event-log" role="status">{steps.map((step, i) => <p key={i}>{step.kind === 'included' ? `Included in block ${step.blockNumber}` : step.kind}</p>)}</div>}{done && <p className="px-success" role="status">Deposit complete. Your balance is refreshing.</p>}</section>}
      {screen === 'send' && <section className="px-flow"><button className="px-back" onClick={() => navigate('dashboard')}>← Overview</button><p className="px-kicker">PRIVATE SEND</p><h1>A private transfer,<br /><em>made simple.</em></h1><p className="px-lead">Send from your encrypted notes. The recipient needs no ETH and takes no action.</p><div className="px-flow-card"><label htmlFor="send-count">Amount</label><div className="px-counter"><button onClick={() => setCount(Math.max(1, count - 1))} aria-label="Remove 0.1 ETH">−</button><strong id="send-count">{amount}</strong><button onClick={() => setCount(count + 1)} aria-label="Add 0.1 ETH">+</button></div><p>{count} {count === 1 ? 'note' : 'notes'} used{privateNotes === null ? '' : ` · ${privateNotes} available`}</p><label htmlFor="recipient">Recipient address</label><input id="recipient" className="px-input" value={recipient} onChange={e => setRecipient(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} aria-invalid={recipient.length > 0 && !validAddress(recipient)} /><small className="px-help">Fresh wallets work. The recipient needs 0 ETH.</small>{review && <div className="px-review"><h2>Review private send</h2><div><span>Private</span><strong>Your wallet address and source note are not in the claim</strong></div><div><span>Public</span><strong>Pool payout · {amount} before fee · {short(recipient)}</strong></div><div><span>Gas</span><strong>Pool pays from the note; recipient receives the remainder</strong></div><p>The recipient and payout are public. A small devnet pool and timing can reduce privacy. For routed calls, Anon-RPC hides your IP from the RPC; it still sees request contents.</p></div>}{!review ? <button className="px-button px-button-primary" disabled={!canSend || busy} onClick={() => setReview(true)}>Review transfer ↗</button> : <button className="px-button px-button-primary" disabled={!canSend || busy || done} onClick={() => void run(() => api.privateSend({ to: recipient as Address, count, onStep }))}>{busy ? 'Sending privately…' : done ? 'Transfer complete' : 'Submit private send'}</button>}</div>{steps.length > 0 && <Stepper steps={steps} count={count} />}{done && <p className="px-success" role="status">Private send complete.</p>}</section>}
      {screen === 'link' && <section className="px-flow"><button className="px-back" onClick={() => navigate('dashboard')}>← Overview</button><p className="px-kicker">PAYMENT LINK</p><h1>Send a note.<br /><em>Share a link.</em></h1><p className="px-lead">The link contains a bearer secret in its URL fragment. Anyone with it can claim the note. Share it privately.</p><div className="px-flow-card"><h2>Create a payment link</h2><p>A 0.1 ETH note is deposited and encoded into a link. The receiver claims into their unlocked wallet. A fresh 0 ETH key submits the claim.</p><button className="px-button px-button-primary" disabled={busy || Boolean(link)} onClick={() => void run(async () => setLink(await api.createPaymentLink()))}>{busy ? 'Creating link…' : link ? 'Link ready' : 'Create 0.1 ETH link'}</button>{link && <div className="px-link-result"><QrCode value={link} /><label htmlFor="created-link">Bearer link · keep private</label><input id="created-link" value={link} readOnly /><button className="px-button px-button-secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setError('Clipboard unavailable; select and copy the link.'))}>{copied ? 'Copied' : 'Copy link'}</button></div>}</div></section>}
      {screen === 'claim' && <section className="px-flow"><p className="px-kicker">CLAIM PAYMENT LINK</p><h1>A private payment<br /><em>is waiting for you.</em></h1><p className="px-lead">A fresh 0 ETH key submits the claim. The payout goes to your unlocked wallet, whose address is public on chain. Your link secret stays in the URL fragment.</p><div className="px-flow-card"><h2>Claim 0.1 ETH note</h2><p>Gas is paid by the pool from the note. The payout is 0.1 ETH minus the actual claim fee.</p><button className="px-button px-button-primary" disabled={busy || done || !claimFragment} onClick={() => void run(() => api.claimLink(claimFragment, onStep))}>{busy ? 'Claiming…' : done ? 'Claim complete' : 'Claim privately'}</button></div>{steps.length > 0 && <Stepper steps={steps} />}</section>}
      {error && <div className="px-error" role="alert">{error}</div>}
      <footer className="px-footer"><div><strong>0xPay</strong><span>Privacy, in your hands.</span></div><button onClick={() => setDrawer(true)}>How it works ↗</button><small>Devnet only · DEV trusted setup · Unaudited · Draft ERC-8421</small></footer>
    </main>
    {drawer && <div className="px-drawer-backdrop" onClick={() => setDrawer(false)}><aside className="px-drawer" role="dialog" aria-modal="true" aria-label="How it works" onClick={e => e.stopPropagation()}><button className="px-drawer-close" onClick={() => setDrawer(false)} aria-label="Close">×</button><p className="px-kicker">UNDER THE HOOD</p><h2>Three frames.<br />One private payout.</h2><FrameDiagram /><p>A fresh 0 ETH sender verifies execution. The staked pool verifies the proof and approves payment. The final frame sends funds to the recipient.</p><p>The canonical mempool’s validation gas and storage rules reject this claim. A correctly configured alternative mempool can admit this staked payer. The public devnet currently rejects the proof precompile; the local sidecar included a claim. The live transfer shows its actual response.</p><p>No trusted relayer is needed. Sidecars and block builders still handle inclusion. The pool requires an ETH gas float. The RPC sees request contents even when Anon-RPC hides your client IP for routed calls.</p></aside></div>}
  </div>
}

/** Wallet host integration while the pool API is being finalized. */
export function PayApp({ api }: { api: PoolApi }) { return <PayAppView api={adaptPoolApi(api)} /> }
