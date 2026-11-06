import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PrivateRpc, type RouteStats } from './rpc.ts'
import { PRIVACY_NETWORKS, chainNetworkFromSearch, privacyNetworkFromSearch, type PrivacyNetwork } from './rpc/networks.ts'
import { ConnectionDetails } from './ui/ConnectionDetails.tsx'
import { WalletPanel } from './wallet/WalletPanel.tsx'
import type { WalletSession } from './wallet/lifecycle.ts'
import { createPayApi } from './pool/api.ts'
import { trafficSnapshot } from './net/network-guard.ts'
import brandLogo from './assets/0xpay-logo.png'
import './App.css'
const payModules = import.meta.glob('./pay/PayApp.tsx', { eager: true }) as Record<string, { default?: React.ComponentType<{ api: ReturnType<typeof createPayApi> }> }>
const PayApp = payModules['./pay/PayApp.tsx']?.default
const emptyStats: RouteStats = { attempted: 0, completed: 0, failed: 0, bootstrapReads: 0 }
type Route = { status: 'connecting' | 'ready' | 'failed'; stats: RouteStats; blockNumber?: number; message?: string }
export default function App() {
  const privacyNetwork = privacyNetworkFromSearch(window.location.search), chainNetwork = chainNetworkFromSearch(window.location.search)
  const [route, setRoute] = useState<Route>({ status: 'connecting', stats: emptyStats })
  const [rpc, setRpc] = useState<PrivateRpc | null>(null)
  const [wallet, setWallet] = useState<WalletSession | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const rpcRef = useRef<PrivateRpc | null>(null)
  const connect = useCallback(async (client: PrivateRpc, retry = false) => {
    setRoute({ status: 'connecting', stats: client.stats })
    try { const result = retry ? await client.reconnect() : await client.connect(); if (rpcRef.current === client) setRoute({ status: 'ready', blockNumber: result.blockNumber, stats: client.stats }) }
    catch (error) { if (rpcRef.current === client) setRoute({ status: 'failed', message: String(error), stats: client.stats }) }
  }, [])
  useEffect(() => { const client = new PrivateRpc(undefined, privacyNetwork, chainNetwork); rpcRef.current = client; queueMicrotask(() => { if (rpcRef.current === client) { setRpc(client); void connect(client) } }); return () => { client.close(); rpcRef.current = null } }, [privacyNetwork, chainNetwork, connect])
  useEffect(() => { if (!rpc) return; const timer = window.setInterval(() => { if (rpc.status === 'degraded' || rpc.status === 'failed' || rpc.status === 'closed') setRoute(previous => previous.status === 'failed' ? previous : { status: 'failed', stats: rpc.stats, message: 'Private connection interrupted. Reconnect to continue.' }) }, 500); return () => window.clearInterval(timer) }, [rpc])
  const api = useMemo(() => rpc && route.status === 'ready' ? createPayApi(rpc) : null, [rpc, route.status])
  const changeNetwork = (next: PrivacyNetwork) => { const url = new URL(window.location.href); url.searchParams.set('network', next); window.location.assign(url.href) }
  return <div className="app-shell"><header className="app-header"><strong className="brand"><img src={brandLogo} alt="" />0xPay</strong><span className="network-context">{chainNetwork === 'local' ? 'Local devnet' : 'Alt mempool devnet'}</span><button type="button" className={`route-chip ${route.status}`} onClick={() => setConnectionOpen(true)}>{route.status === 'ready' ? `Private connection · ${PRIVACY_NETWORKS[privacyNetwork].label}` : route.status === 'connecting' ? 'Connecting privately…' : 'Connection interrupted'}</button></header>
    <ConnectionDetails open={connectionOpen} route={route} engine={{ status: 'ready' }} traffic={trafficSnapshot()} onClose={() => setConnectionOpen(false)} onReconnect={() => { if (rpcRef.current) void connect(rpcRef.current, true) }} onDisconnect={() => { rpcRef.current?.disconnect(); setRoute({ status: 'failed', stats: rpcRef.current?.stats ?? emptyStats, message: 'Disconnected' }) }} privacyNetwork={privacyNetwork} onNetworkChange={changeNetwork} />
    <main className="wallet-main"><WalletPanel session={wallet} onSession={setWallet} blockNumber={route.blockNumber ?? null}>{api && PayApp ? <PayApp api={api} /> : <p role="status">{route.status === 'ready' ? 'Privacy wallet is ready. Payment screens are being connected.' : route.message ?? 'Connecting to Anon-RPC…'}</p>}</WalletPanel></main>
    <footer className="app-footer">0xPay · Devnet only</footer></div>
}
