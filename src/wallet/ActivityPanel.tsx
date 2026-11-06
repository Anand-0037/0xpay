import { useState } from 'react'
import { readTransactions, type TransactionKind, type TransactionRecord } from '../domain/tx-journal'

type Props = {
  routeReady: boolean
  fundingAddress?: string
  onRebroadcast?: (hash: string) => Promise<void>
  onRecheck: (kind: TransactionKind, hash: string) => Promise<void>
}

export function ActivityPanel({ routeReady, fundingAddress, onRebroadcast, onRecheck }: Props) {
  const [error, setError] = useState('')
  const [checking, setChecking] = useState<string | null>(null)
  const [, setRevision] = useState(0)

  const snapshot = ((): { entries: TransactionRecord[]; error: string } => {
    try { return { entries: readTransactions(), error: '' } }
    catch (cause) { return { entries: [], error: cause instanceof Error ? cause.message : 'Could not read transaction history' } }
  })()

  async function recheck(kind: TransactionKind, hash: string) {
    if (!routeReady || checking) return
    setChecking(hash)
    setError('')
    try { await onRecheck(kind, hash); setRevision((value) => value + 1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check this transaction') }
    finally { setChecking(null) }
  }

  async function rebroadcast(hash: string) {
    if (!routeReady || checking || !onRebroadcast) return
    setChecking(hash)
    setError('')
    try { await onRebroadcast(hash) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not resend this signed transaction') }
    finally { setRevision((value) => value + 1); setChecking(null) }
  }

  if (!snapshot.entries.length && !error && !snapshot.error) return null

  return <section className="activity-panel" aria-labelledby="activity-heading">
    <div className="activity-heading"><p className="eyebrow">ACTIVITY</p><h2 id="activity-heading">Recent transactions</h2></div>
    {(error || snapshot.error) && <p role="alert">{error || snapshot.error}</p>}
    <ul>{snapshot.entries.slice(0, 8).map((entry) => <li key={entry.hash}>
      <div><strong>{entry.kind === 'shield' ? 'Shield' : 'Private send'}</strong><span>{entry.status}</span></div>
      <a href={`https://sepolia.etherscan.io/tx/${entry.hash}`} target="_blank" rel="noopener noreferrer">{entry.hash.slice(0, 10)}…{entry.hash.slice(-8)} ↗</a>
      {(entry.status === 'submitted' || entry.status === 'unknown') &&
        <button type="button" disabled={!routeReady || checking !== null} onClick={() => void recheck(entry.kind, entry.hash)}>
          {checking === entry.hash ? 'Checking…' : 'Check confirmation'}
        </button>}
      {(entry.status === 'submitted' || entry.status === 'unknown') && entry.signedTransaction &&
        fundingAddress?.toLowerCase() === entry.from.toLowerCase() && onRebroadcast && <>
          <p>Resend the exact saved transaction if its broadcast was interrupted. This keeps the same payment and nonce.</p>
          <button type="button" disabled={!routeReady || checking !== null} onClick={() => void rebroadcast(entry.hash)}>
            {checking === entry.hash ? 'Working…' : 'Resend same signed transaction'}
          </button>
        </>}
    </li>)}</ul>
  </section>
}
