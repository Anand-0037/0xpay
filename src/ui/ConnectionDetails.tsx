import { useEffect, useRef } from 'react'
import type { RouteStats } from '../rpc'
import type { TrafficEntry, TrafficKind } from '../net/network-guard'

type Route = { status: 'connecting' | 'ready' | 'failed'; stats: RouteStats; message?: string; blockNumber?: number }
type Engine = { status: 'waiting' | 'starting' | 'ready' | 'failed'; message?: string; shieldFeeBasisPoints?: bigint; reload?: boolean }

export function ConnectionDetails({ open, route, engine, traffic, onClose, onReconnect }: {
  open: boolean; route: Route; engine: Engine; traffic: { counts: Record<TrafficKind, number>; recent: TrafficEntry[] }; onClose: () => void; onReconnect: () => void
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) closeButton.current?.focus() }, [open])
  if (!open) return null
  return <div className="connection-overlay" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <button className="connection-scrim" type="button" aria-label="Close connection details" onClick={onClose} />
    <aside id="connection-details" className="connection-drawer" role="dialog" aria-modal="true" aria-label="Connection details">
      <div className="connection-top"><div><p className="eyebrow">CONNECTION DETAILS</p><h2>How this wallet connects</h2></div><button ref={closeButton} type="button" onClick={onClose} aria-label="Close connection details">×</button></div>
      <div className={`connection-state ${route.status}`}><span className="route-dot" aria-hidden="true" /><strong>{route.status === 'ready' ? 'Private read route ready' : route.status === 'connecting' ? 'Connecting through Nym' : 'Private read route down'}</strong></div>
      {(route.status === 'failed' || engine.status === 'failed') && <><p role="alert">{engine.status === 'failed' ? engine.message : route.message}</p><button type="button" onClick={onReconnect}>{engine.status === 'failed' && engine.reload ? 'Refresh app' : 'Reconnect'}</button></>}
      <dl className="connection-list">
        <div><dt>Network</dt><dd>Ethereum Sepolia{route.blockNumber !== undefined ? ` · block ${route.blockNumber.toLocaleString()}` : ''}</dd></div>
        <div><dt>Worker</dt><dd>Nym via Anon-RPC</dd></div>
        <div><dt>RPC reads</dt><dd>{route.stats.completed}/{route.stats.attempted} completed through worker · {route.stats.failed} failed</dd></div>
        <div><dt>Worker bootstrap</dt><dd>{route.stats.bootstrapReads} direct specifier reads</dd></div>
        <div><dt>Other page requests</dt><dd>POI {traffic.counts.poi ?? 0} direct · artifacts {traffic.counts.artifacts ?? 0} direct · indexer {traffic.counts.indexer ?? 0} direct · blocked {traffic.counts.blocked ?? 0}</dd></div>
        <div><dt>RAILGUN</dt><dd>{engine.status === 'ready' ? `Connected · shield fee ${engine.shieldFeeBasisPoints?.toString()} basis points` : engine.status === 'starting' ? 'Connecting' : engine.status === 'failed' ? `Error: ${engine.message}` : 'Waiting for private route'}</dd></div>
      </dl>
      <p className="connection-coverage">RPC reads above used the worker. The worker lookup, privacy checks, proof downloads and indexer requests are direct. This panel counts page fetch and XHR, not traffic inside the worker, browser-native loads, or a connected wallet extension. A successful request alone does not prove anonymity.</p>
      <div className="traffic-recent"><h3>Recent page destinations</h3><ul>{traffic.recent.map((entry, index) => <li key={`${index}-${entry.host}`}><span>{entry.kind}</span><code>{entry.host}</code><span>{entry.outcome}</span></li>)}</ul></div>
    </aside>
  </div>
}
