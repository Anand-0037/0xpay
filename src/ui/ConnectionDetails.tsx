import { useEffect, useRef } from 'react'
import type { RouteStats } from '../rpc'
import { PRIVACY_NETWORKS, type PrivacyNetwork } from '../rpc/networks'

type Route = { status: 'connecting' | 'ready' | 'failed'; stats: RouteStats; message?: string; blockNumber?: number
  stage?: 'starting-worker' | 'validating-chain'; elapsedMs?: number; disconnectedByUser?: boolean }
type Engine = { status: 'waiting' | 'starting' | 'ready' | 'failed'; message?: string; shieldFeeBasisPoints?: bigint; reload?: boolean }

/** Time and phase come from observed connection state; this is not a progress estimate. */
export function ConnectionProgress({ stage = 'starting-worker', elapsedMs = 0, networkLabel }: {
  stage?: Route['stage']; elapsedMs?: number; networkLabel: string
}) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  return <span className="connection-progress"><span className="connection-spinner" aria-hidden="true" /><span>{stage === 'validating-chain' ? 'Checking the network' : `Connecting through ${networkLabel}`} · {seconds}s</span></span>
}

export function ConnectionDetails({ open, route, engine, onClose, onReconnect, onDisconnect, context = 'payments', privacyNetwork = 'nym', onNetworkChange }: {
  open: boolean; route: Route; engine: Engine; onClose: () => void; onReconnect: () => void; onDisconnect: () => void; context?: 'lending' | 'payments' | 'agents'
  privacyNetwork?: PrivacyNetwork; onNetworkChange?: (network: PrivacyNetwork) => void
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
  const networkLabel = PRIVACY_NETWORKS[privacyNetwork].label
  return <div className="connection-overlay">
    <button className="connection-scrim" type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} />
    <aside ref={drawer} id="connection-details" className="connection-drawer" role="dialog" aria-modal="true" aria-labelledby="connection-title" aria-describedby="connection-explanation">
      <div className="connection-top"><h2 id="connection-title">Connection</h2><button ref={closeButton} type="button" onClick={onClose} aria-label="Close connection details">×</button></div>
      <div className={`connection-state ${route.status}`} role="status"><span className="route-dot" aria-hidden="true" /><strong>{route.status === 'ready' ? `Connected through ${networkLabel}` : route.status === 'connecting' ? `Connecting through ${networkLabel}…` : route.disconnectedByUser ? 'Disconnected by you' : 'Connection failed'}</strong></div>
      {route.status === 'connecting' && <p><ConnectionProgress stage={route.stage} elapsedMs={route.elapsedMs} networkLabel={networkLabel} /></p>}
      <p className="connection-provider">{networkLabel} via Anon-RPC · {context === 'agents' ? 'Polygon' : 'Sepolia testnet'}</p>
      {onNetworkChange && <div className="connection-network">
        <label htmlFor="privacy-network">Privacy network</label>{' '}
        <select id="privacy-network" value={privacyNetwork} onChange={(event) => {
          const value = event.currentTarget.value
          if ((value === 'nox' || value === 'nym') && value !== privacyNetwork) onNetworkChange(value)
        }}><option value="nox">Nox</option><option value="nym">Nym</option></select>
        <p>{context === 'payments' ? 'Changing networks restarts the connection and locks an open wallet.' : 'Changing networks restarts the connection. Read the position again before continuing.'}</p>
      </div>}
      <p id="connection-explanation">{context === 'lending' ? `Position queries use ${networkLabel}. Your onchain position stays public.` : context === 'agents' ? `Market data and account reads use ${networkLabel}. If the connection fails, those requests stop.` : `Your wallet’s blockchain requests use ${networkLabel}. If the connection fails, requests stop.`}</p>
      {context === 'payments' && route.status === 'ready' && (engine.status === 'waiting' || engine.status === 'starting') && <p role="status">Preparing your wallet…</p>}
      {(route.status === 'failed' || (context === 'payments' && engine.status === 'failed')) && <>
        <p role={route.disconnectedByUser ? 'status' : 'alert'}>{route.status === 'failed' ? route.message ?? 'The private connection stopped.' : engine.message ?? 'Wallet services could not connect.'}</p>
        {route.elapsedMs !== undefined && !route.disconnectedByUser && <p>Connection attempt stopped after {Math.max(0, Math.floor(route.elapsedMs / 1000))}s.</p>}
        <button type="button" onClick={onReconnect}>{context === 'payments' && engine.status === 'failed' && engine.reload ? 'Refresh app' : 'Reconnect'}</button>
      </>}
      {route.status === 'ready' && <button className="connection-disconnect" type="button" onClick={onDisconnect}>Disconnect private route</button>}
      <details className="connection-privacy">
      <summary>Privacy coverage</summary>
      <p>{context === 'agents' ? 'Public market data and supported Polygon reads use Anon-RPC. AI research receives public market evidence through the app server and 0G separately. Optional policy signing uses your browser wallet’s connection. Orders here are simulated and do not move funds.' : context === 'lending' ? 'Only position reads use Anon-RPC. This view does not start RAILGUN or its services.' : 'Blockchain requests from this wallet use Anon-RPC. Privacy checks, proof downloads and indexing use separate connections. The gas-paying address remains public.'}</p>
      <p>Initial setup and app downloads use separate connections. Anon-RPC does not hide public onchain activity or protect every connection on your device.</p>
      </details>
    </aside>
  </div>
}
