import type { Activity, PayApi } from '../pay/types'

const ETH = 10n ** 18n
export function formatEth(value: bigint, digits = 4): string {
  const whole = value / ETH
  const fraction = (value % ETH).toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}

export type DashboardData = {
  publicBalance: bigint | null
  privateBalance: bigint | null
  notes: number | null
  tokens: Awaited<ReturnType<PayApi['tokenPortfolio']>> | null
  activity: Activity[] | null
}
export type DashboardErrors = Partial<Record<keyof DashboardData, boolean>>

function ReadError({ label, onRetry, canRetry }: { label: string; onRetry?: () => void; canRetry: boolean }) {
  return <div className="px-read-error" role="status"><span>{label} unavailable.</span><small>{canRetry ? 'Your other wallet data can still load.' : 'Reconnect your private route to try again.'}</small>{onRetry && <button type="button" disabled={!canRetry} onClick={onRetry}>Retry wallet reads <span aria-hidden="true">↻</span></button>}</div>
}

function Balance({ value, failed = false }: { value: bigint | null; failed?: boolean }) {
  if (failed) return <strong className="px-value px-unavailable" aria-label="Balance unavailable">— <small>ETH</small></strong>
  return value === null ? <span className="px-skeleton px-balance-skeleton" aria-label="Loading balance" /> : <strong className="px-value" title={`${value} wei`}>{formatEth(value)} <small>ETH</small></strong>
}

export default function Dashboard({ data, errors = {}, onNavigate, onRetry, canRetry = true, privateNotesOnly = false, onPrivateNotesOnlyChange }: {
  data: DashboardData
  errors?: DashboardErrors
  onNavigate: (screen: 'deposit' | 'send' | 'link') => void
  onRetry?: () => void
  canRetry?: boolean
  privateNotesOnly?: boolean
  onPrivateNotesOnlyChange?: (enabled: boolean) => void
}) {
  const readError = (label: string) => <ReadError label={label} onRetry={onRetry} canRetry={canRetry} />
  return <>
    <section className="px-intro"><div><p className="px-kicker">YOUR WALLET · DEVNET</p><h1>A payment for them.<br /><em>Privacy for you.</em></h1><p>Send from your private notes. The pool pays gas, so your recipient can start with zero ETH.</p></div><div className="px-payment-core" aria-hidden="true"><img src="/private-payment-core.webp" alt="" width="1100" height="1100" decoding="async" draggable={false} /></div></section>
    {onPrivateNotesOnlyChange && <section className="px-panel" aria-label="Wallet read mode"><div className="px-section-title"><div><p className="px-kicker">WALLET READS</p><h2>{privateNotesOnly ? 'Private notes only' : 'Public balances shown'}</h2></div><button type="button" className="px-button px-button-secondary" onClick={() => onPrivateNotesOnlyChange(!privateNotesOnly)}>{privateNotesOnly ? 'Show public balances' : 'Pause public balances'}</button></div><p>{privateNotesOnly ? 'Funding-account and public-token balance reads are paused. Pool and payment reads still use the private route.' : 'Funding-account and public-token balances are loaded through the private route. The RPC can still link requests made in one session.'}</p></section>}
    <section className="px-balance-grid" aria-label="Balances">
      <article className="px-balance-card px-private"><div className="px-card-top"><span className="px-icon" aria-hidden="true">◈</span><span className="px-tag">PRIVATE NOTES</span></div><h2>Private balance</h2><Balance value={data.privateBalance} failed={errors.privateBalance} /><p>{errors.notes ? 'Note count unavailable' : data.notes === null ? <span className="px-skeleton px-inline-skeleton" aria-label="Loading note count" /> : `${data.notes} unspent 0.1 ETH notes`} <span aria-hidden="true">·</span> Fixed denomination pool</p>{(errors.privateBalance || errors.notes) && readError('Private notes')}<button className="px-button px-button-primary" onClick={() => onNavigate('send')}>Send privately <span aria-hidden="true">↗</span></button></article>
      <article className="px-balance-card"><div className="px-card-top"><span className="px-icon" aria-hidden="true">◇</span><span className="px-tag">PUBLIC WALLET</span></div><h2>Public balance</h2>{privateNotesOnly ? <strong className="px-value">Paused</strong> : <Balance value={data.publicBalance} failed={errors.publicBalance} />}<p>{privateNotesOnly ? 'Show public balances to check funding before a deposit.' : 'Available for deposits and their network gas'}</p>{!privateNotesOnly && errors.publicBalance && readError('Public balance')}<button className="px-button px-button-secondary" onClick={() => privateNotesOnly && onPrivateNotesOnlyChange ? onPrivateNotesOnlyChange(false) : onNavigate('deposit')}>{privateNotesOnly ? 'Show public balances' : 'Add to private balance'} <span aria-hidden="true">↗</span></button></article>
    </section>
    <div className="px-section-grid">
      <section className="px-panel"><div className="px-section-title"><div><p className="px-kicker">ASSETS</p><h2>Portfolio</h2></div><span className="px-muted">Devnet</span></div>{privateNotesOnly ? <p className="px-empty">Public token reads paused.</p> : errors.tokens ? readError('Portfolio') : data.tokens === null ? <div className="px-list-skeleton" aria-label="Loading portfolio"><span className="px-skeleton" /><span className="px-skeleton" /></div> : data.tokens.length ? data.tokens.map((token, i) => <div className="px-list-row" key={`${token.symbol}-${i}`}><span className="px-asset-icon" aria-hidden="true">{token.symbol.slice(0, 1)}</span><span><strong>{token.symbol}</strong><small>Public token</small></span><strong className="px-row-end">{Number.isSafeInteger(token.decimals) ? formatEth(token.balance * ETH / 10n ** BigInt(token.decimals ?? 0)) : '—'}</strong></div>) : <p className="px-empty">No public tokens found.</p>}</section>
      <section className="px-panel"><div className="px-section-title"><div><p className="px-kicker">YOUR PAYMENTS</p><h2>Activity</h2></div><span className="px-muted">Recent</span></div>{errors.activity ? readError('Activity') : data.activity === null ? <div className="px-list-skeleton" aria-label="Loading activity"><span className="px-skeleton" /><span className="px-skeleton" /></div> : data.activity.length ? data.activity.map((item, i) => <div className="px-list-row" key={item.id ?? item.txHash ?? i}><span className="px-asset-icon" aria-hidden="true">↗</span><span><strong>{item.title ?? item.kind ?? 'Transaction'}</strong><small>{item.timestamp ? new Date(item.timestamp).toLocaleString() : item.txHash ? `${item.txHash.slice(0, 10)}…` : 'On chain'}</small></span><strong className="px-row-end">{typeof item.amountWei === 'bigint' ? `${formatEth(item.amountWei)} ETH` : ''}</strong></div>) : <p className="px-empty">Your first deposit or payment will appear here.</p>}</section>
    </div>
    <section className="px-shortcuts"><div><p className="px-kicker">ONE WALLET. REAL MOMENTS.</p><h2>Make it a payment.</h2></div><div className="px-shortcut-grid"><button onClick={() => onNavigate('send')}><span aria-hidden="true">↗</span><strong>Pay a contributor</strong><small>Send to their address</small></button><button onClick={() => onNavigate('link')}><span aria-hidden="true">▤</span><strong>Send a payment link</strong><small>Share a note privately</small></button><button onClick={() => onNavigate('send')}><span aria-hidden="true">✳</span><strong>Tip a creator</strong><small>The pool pays claim gas</small></button></div></section>
  </>
}
