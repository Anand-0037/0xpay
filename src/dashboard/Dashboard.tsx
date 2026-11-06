import type { Activity, PayApi } from '../pay/types'

const ETH = 10n ** 18n
export function formatEth(value: bigint, digits = 4): string {
  const whole = value / ETH
  const fraction = (value % ETH).toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}

function Balance({ value }: { value: bigint | null }) {
  return value === null ? <span className="px-skeleton px-balance-skeleton" aria-label="Loading balance" /> : <strong className="px-value">{formatEth(value)} <small>ETH</small></strong>
}

export type DashboardData = {
  publicBalance: bigint | null
  privateBalance: bigint | null
  notes: number | null
  tokens: Awaited<ReturnType<PayApi['tokenPortfolio']>> | null
  activity: Activity[] | null
}

export default function Dashboard({ data, onNavigate }: { data: DashboardData; onNavigate: (screen: 'deposit' | 'send' | 'link') => void }) {
  return <>
    <section className="px-intro"><div><p className="px-kicker">YOUR WALLET · DEVNET</p><h1>Money moves.<br /><em>Privacy stays.</em></h1><p>Send from a private balance without asking your recipient to prepare a wallet or pay gas.</p></div><div className="px-orbit" aria-hidden="true"><span>0x</span><i /><i /><i /></div></section>
    <section className="px-balance-grid" aria-label="Balances">
      <article className="px-balance-card px-private"><div className="px-card-top"><span className="px-icon">◈</span><span className="px-tag">PRIVATE</span></div><h2>Private balance</h2><Balance value={data.privateBalance} /><p>{data.notes === null ? <span className="px-skeleton px-inline-skeleton" /> : `${data.notes} unspent 0.1 ETH notes`} <span aria-hidden="true">·</span> Fixed denomination pool</p><button className="px-button px-button-primary" onClick={() => onNavigate('send')}>Send privately <span aria-hidden="true">↗</span></button></article>
      <article className="px-balance-card"><div className="px-card-top"><span className="px-icon">◇</span><span className="px-tag">PUBLIC</span></div><h2>Public balance</h2><Balance value={data.publicBalance} /><p>Visible on the devnet ledger</p><button className="px-button px-button-secondary" onClick={() => onNavigate('deposit')}>Add to private balance <span aria-hidden="true">↗</span></button></article>
    </section>
    <div className="px-section-grid"><section className="px-panel"><div className="px-section-title"><div><p className="px-kicker">ASSETS</p><h2>Portfolio</h2></div><span className="px-muted">Devnet</span></div>{data.tokens === null ? <div className="px-list-skeleton"><span className="px-skeleton" /><span className="px-skeleton" /></div> : data.tokens.length ? data.tokens.map((token, i) => <div className="px-list-row" key={`${token.symbol}-${i}`}><span className="px-asset-icon">{token.symbol.slice(0, 1)}</span><span><strong>{token.symbol}</strong><small>Public token</small></span><strong className="px-row-end">{Number.isSafeInteger(token.decimals) ? formatEth(token.balance * ETH / 10n ** BigInt(token.decimals ?? 0)) : '—'}</strong></div>) : <p className="px-empty">No public tokens found.</p>}</section>
    <section className="px-panel"><div className="px-section-title"><div><p className="px-kicker">ON CHAIN</p><h2>Activity</h2></div><span className="px-muted">Recent</span></div>{data.activity === null ? <div className="px-list-skeleton"><span className="px-skeleton" /><span className="px-skeleton" /></div> : data.activity.length ? data.activity.map((item, i) => <div className="px-list-row" key={item.id ?? item.txHash ?? i}><span className="px-asset-icon">↗</span><span><strong>{item.title ?? item.kind ?? 'Transaction'}</strong><small>{item.timestamp ? new Date(item.timestamp).toLocaleString() : item.txHash ? `${item.txHash.slice(0, 10)}…` : 'On chain'}</small></span><strong className="px-row-end">{typeof item.amountWei === 'bigint' ? `${formatEth(item.amountWei)} ETH` : ''}</strong></div>) : <p className="px-empty">No activity yet. Your first private transfer will appear here.</p>}</section></div>
    <section className="px-shortcuts"><div><p className="px-kicker">A QUIETER WAY TO PAY</p><h2>Made for real moments.</h2></div><div className="px-shortcut-grid"><button onClick={() => onNavigate('send')}><span>↗</span><strong>Donate privately</strong><small>Send to a cause</small></button><button onClick={() => onNavigate('link')}><span>▤</span><strong>Request / link</strong><small>Share a bearer note</small></button><button onClick={() => onNavigate('send')}><span>✳</span><strong>Tip a creator</strong><small>Send to an address</small></button></div></section>
  </>
}
