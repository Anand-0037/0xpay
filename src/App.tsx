import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PrivateRpc, PrivateRpcLifecycleError, type RouteStats } from './rpc.ts'
import { PRIVACY_NETWORKS, chainNetworkFromSearch, privacyNetworkFromSearch, type PrivacyNetwork } from './rpc/networks.ts'
import { ConnectionDetails } from './ui/ConnectionDetails.tsx'
import { WalletPanel } from './wallet/WalletPanel.tsx'
import type { WalletSession } from './wallet/lifecycle.ts'
import { createPayApi } from './pool/api.ts'
import { trafficSnapshot } from './net/network-guard.ts'
import brandLogo from './assets/0xpay-logo.png'
import './App.css'
const payModules = import.meta.glob('./pay/PayApp.tsx', { eager: true }) as Record<string, { default?: React.ComponentType<{ api: ReturnType<typeof createPayApi>; connectionReady: boolean; connectionMessage?: string; connectionVersion: number }> }>
const PayApp = payModules['./pay/PayApp.tsx']?.default
const emptyStats: RouteStats = { attempted: 0, completed: 0, failed: 0, bootstrapReads: 0 }
type Route = { status: 'connecting' | 'ready' | 'failed' | 'disconnected'; stats: RouteStats; blockNumber?: number; message?: string }
export default function App() {
  const privacyNetwork = privacyNetworkFromSearch(window.location.search), chainNetwork = chainNetworkFromSearch(window.location.search)
  const [route, setRoute] = useState<Route>({ status: 'connecting', stats: emptyStats })
  const [rpc, setRpc] = useState<PrivateRpc | null>(null)
  const [wallet, setWallet] = useState<WalletSession | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [connectionVersion, setConnectionVersion] = useState(0)
  const rpcRef = useRef<PrivateRpc | null>(null)
  const connect = useCallback(async (client: PrivateRpc, retry = false) => {
    setRoute({ status: 'connecting', stats: client.stats })
    try { const result = retry ? await client.reconnect() : await client.connect(); if (rpcRef.current === client) { setConnectionVersion(previous => previous + 1); setRoute({ status: 'ready', blockNumber: result.blockNumber, stats: client.stats }) } }
    catch (error) { if (error instanceof PrivateRpcLifecycleError) return; if (rpcRef.current === client) setRoute({ status: 'failed', message: String(error), stats: client.stats }) }
  }, [])
  useEffect(() => { const client = new PrivateRpc(undefined, privacyNetwork, chainNetwork); rpcRef.current = client; queueMicrotask(() => { if (rpcRef.current === client) { setRpc(client); void connect(client) } }); return () => { client.close(); rpcRef.current = null } }, [privacyNetwork, chainNetwork, connect])
  useEffect(() => { if (!rpc) return; const timer = window.setInterval(() => { if (rpc.status === 'degraded' || rpc.status === 'failed' || rpc.status === 'closed') setRoute(previous => previous.status === 'failed' || previous.status === 'disconnected' ? previous : { status: 'failed', stats: rpc.stats, message: rpc.failure?.message ?? 'Private connection interrupted. Reconnect to continue.' }) }, 500); return () => window.clearInterval(timer) }, [rpc])
  // A route failure blocks the API's transport but must not destroy payment progress.
  const api = useMemo(() => rpc ? createPayApi(rpc) : null, [rpc])
  const changeNetwork = (next: PrivacyNetwork) => { const url = new URL(window.location.href); url.searchParams.set('network', next); window.location.assign(url.href) }
  return <div className="app-shell"><header className="app-header"><strong className="brand"><img src={brandLogo} alt="" />0xPay</strong><span className="network-context">{chainNetwork === 'local' ? 'Local devnet' : 'Alt mempool devnet'}</span><button type="button" className={`route-chip ${route.status}`} onClick={() => setConnectionOpen(true)}>{route.status === 'ready' ? `Private connection · ${PRIVACY_NETWORKS[privacyNetwork].label}` : route.status === 'connecting' ? 'Connecting privately…' : route.status === 'disconnected' ? 'Private connection paused' : 'Connection interrupted'}</button></header>
    <ConnectionDetails open={connectionOpen} networkLabel={chainNetwork === 'local' ? 'Local devnet · chain 1337' : 'Alt mempool devnet · chain 1337'} route={route} traffic={trafficSnapshot()} onClose={() => setConnectionOpen(false)} onReconnect={() => { if (rpcRef.current) void connect(rpcRef.current, true) }} onDisconnect={() => { rpcRef.current?.disconnect(); setRoute({ status: 'disconnected', stats: rpcRef.current?.stats ?? emptyStats, message: 'Disconnected by you. Reconnect when you are ready.' }) }} privacyNetwork={privacyNetwork} onNetworkChange={changeNetwork} />
    <main className="wallet-main"><WalletPanel session={wallet} onSession={setWallet} blockNumber={route.blockNumber ?? null}>{api && PayApp ? <PayApp key={wallet ? `${wallet.id}:${wallet.generation}` : 'locked'} api={api} connectionReady={route.status === 'ready'} connectionMessage={route.message} connectionVersion={connectionVersion} /> : <p role="status">{route.message ?? 'Connecting to Anon-RPC…'}</p>}</WalletPanel></main>
    <footer className="app-footer">0xPay · Devnet only</footer></div>
}
