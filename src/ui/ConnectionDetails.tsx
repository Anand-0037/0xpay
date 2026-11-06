import { useEffect, useRef } from 'react'
import type { RouteStats } from '../rpc'
import type { TrafficEntry, TrafficKind } from '../net/network-guard'

type Route = { status: 'connecting' | 'ready' | 'failed'; stats: RouteStats; message?: string; blockNumber?: number }
type Engine = { status: 'waiting' | 'starting' | 'ready' | 'failed'; message?: string; shieldFeeBasisPoints?: bigint; reload?: boolean }

export function ConnectionDetails({ open, route, engine, traffic, onClose, onReconnect, onDisconnect }: {
  open: boolean; route: Route; engine: Engine; traffic: { counts: Record<TrafficKind, number>; recent: TrafficEntry[] }; onClose: () => void; onReconnect: () => void; onDisconnect: () => void
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const drawer = useRef<HTMLElement>(null)
  const closeAction = useRef(onClose)
  useEffect(() => { closeAction.current = onClose }, [onClose])
  useEffect(() => {
    if (!open || !drawer.current) return
    const dialog = drawer.current
    const document = dialog.ownerDocument
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    )).filter((element) => {
      if (element.closest('[hidden], [inert]')) return false
      for (let parent = element.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open') && parent.querySelector(':scope > summary') !== element) return false
      }
      const style = document.defaultView?.getComputedStyle(element)
      return style?.display !== 'none' && style?.visibility !== 'hidden'
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeAction.current(); return
      }
      if (event.key !== 'Tab') return
      const controls = focusable()
      const first = controls[0] ?? closeButton.current
      const last = controls.at(-1) ?? first
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first?.focus()
      }
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) closeButton.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    closeButton.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open])
  if (!open) return null
  const methods = Object.entries(route.stats.methodCounts ?? {})
  const readCalls = methods.filter(([method]) => method !== 'eth_sendRawTransaction' && method !== 'other')
    .reduce((total, [, count]) => ({ attempted: total.attempted + count.attempted,
      completed: total.completed + count.completed, failed: total.failed + count.failed }),
    { attempted: 0, completed: 0, failed: 0 })
  const broadcasts = route.stats.methodCounts?.eth_sendRawTransaction ?? { attempted: 0, completed: 0, failed: 0 }
  return <div className="connection-overlay">
    <button className="connection-scrim" type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} />
    <aside ref={drawer} id="connection-details" className="connection-drawer" role="dialog" aria-modal="true" aria-labelledby="connection-title" aria-describedby="connection-explanation">
      <div className="connection-top"><h2 id="connection-title">Connection</h2><button ref={closeButton} type="button" onClick={onClose} aria-label="Close connection details">×</button></div>
      <div className={`connection-state ${route.status}`} role="status"><span className="route-dot" aria-hidden="true" /><strong>{route.status === 'ready' ? 'Connected through Nym' : route.status === 'connecting' ? 'Connecting through Nym…' : 'Connection paused'}</strong></div>
      <p>Ethereum Sepolia</p>
      <p id="connection-explanation">Your wallet’s blockchain requests use Nym. If the connection fails, requests stop.</p>
      {route.status === 'ready' && (engine.status === 'waiting' || engine.status === 'starting') && <p role="status">Preparing your wallet…</p>}
      {(route.status === 'failed' || engine.status === 'failed') && <><p role="alert">{engine.status === 'failed' && engine.reload ? 'Refresh the app to continue.' : route.status === 'failed' ? 'Reconnect to continue using your wallet.' : 'Wallet services could not connect. Try again.'}</p><button type="button" onClick={onReconnect}>{engine.status === 'failed' && engine.reload ? 'Refresh app' : 'Reconnect'}</button></>}
      <details style={{ marginTop: 28 }}>
      <summary>Technical details</summary>
      {(route.message || engine.message) && <p className="connection-coverage">{engine.status === 'failed' ? engine.message : route.message}</p>}
      <dl className="connection-list">
        <div><dt>Network</dt><dd>Ethereum Sepolia{route.blockNumber !== undefined ? ` · block ${route.blockNumber.toLocaleString()}` : ''}</dd></div>
        <div><dt>Worker</dt><dd>Nym via Anon-RPC</dd></div>
        <div><dt>RPC requests</dt><dd>{route.stats.completed}/{route.stats.attempted} completed through worker · {route.stats.failed} failed</dd></div>
        <div><dt>RPC read calls</dt><dd>{readCalls.completed}/{readCalls.attempted} transport replies · {readCalls.failed} failed</dd></div>
        <div><dt>Signed broadcasts</dt><dd>{broadcasts.completed}/{broadcasts.attempted} transport replies · {broadcasts.failed} failed</dd></div>
        <div><dt>Worker bootstrap</dt><dd>{route.stats.bootstrapReads} direct specifier reads</dd></div>
        <div><dt>Other page requests</dt><dd>POI {traffic.counts.poi ?? 0} direct · artifacts {traffic.counts.artifacts ?? 0} direct · indexer {traffic.counts.indexer ?? 0} direct · blocked {traffic.counts.blocked ?? 0}</dd></div>
        <div><dt>RAILGUN</dt><dd>{engine.status === 'ready' ? route.status === 'ready' ? `Connected · shield fee ${engine.shieldFeeBasisPoints?.toString()} basis points` : 'Paused until the private route reconnects' : engine.status === 'starting' ? 'Connecting' : engine.status === 'failed' ? `Error: ${engine.message}` : 'Waiting for private route'}</dd></div>
      </dl>
      <details><summary>RPC methods observed</summary><ul>{methods.map(([method, count]) =>
        <li key={method}><code>{method}</code>: {count.completed}/{count.attempted} transport replies · {count.failed} failed</li>
      )}</ul><p>Calls inside a batch are counted separately. A transport reply does not establish RPC success or transaction settlement. No addresses or request contents are retained here.</p></details>
      <p className="connection-coverage">The counters record requests observed through the worker; a broadcast is counted only when it is attempted. The worker lookup, privacy checks, proof downloads and indexer requests are direct. This panel counts page fetch and XHR, not traffic inside the worker, browser-native loads, or a connected wallet extension. A successful request alone does not prove anonymity.</p>
      <div className="traffic-recent"><h3>Recent page destinations</h3><ul>{traffic.recent.map((entry, index) => <li key={`${index}-${entry.host}`}><span>{entry.kind}</span><code>{entry.host}</code><span>{entry.outcome}</span></li>)}</ul></div>
      {route.status === 'ready' && engine.status === 'ready' && <button type="button" onClick={onDisconnect}>Disconnect private route</button>}
      </details>
    </aside>
  </div>
}
