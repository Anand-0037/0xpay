import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { JsonRpcProvider } from 'ethers'
import { APP_RPC_URL, PrivateRpc, type RouteStats } from './rpc'
import { bindEthersToPrivateRoute, unbindEthersRoute } from './rpc/ethers-transport'
import { connectInitialPrivateRoute } from './rpc/startup'
import { PRIVACY_NETWORKS, privacyNetworkFromSearch, type PrivacyNetwork } from './rpc/networks'
import type { WalletSession } from './wallet/lifecycle'
import { ConnectionDetails } from './ui/ConnectionDetails'
import { PaymentUseCases } from './ui/PaymentUseCases'
import { LendingPanel } from './lending/LendingPanel'
import { trafficSnapshot } from './net/network-guard'
import brandLogo from './assets/0xpay-logo.png'
import './App.css'
import './lending/LendingPanel.css'
import './lending/LendingAssets.css'

type RouteState =
  | { status: 'connecting'; stats: RouteStats }
  | { status: 'ready'; blockNumber: number; generation: number; stats: RouteStats }
  | { status: 'failed'; message: string; stats: RouteStats }
type EngineState =
  | { status: 'waiting' | 'starting' }
  | { status: 'ready'; shieldFeeBasisPoints: bigint }
  | { status: 'failed'; message: string; reload?: boolean }

const emptyStats: RouteStats = { attempted: 0, completed: 0, failed: 0, bootstrapReads: 0 }
const WalletPanel = lazy(() => import('./wallet/WalletPanel').then((module) => ({ default: module.WalletPanel })))

function App() {
  const [route, setRoute] = useState<RouteState>({ status: 'connecting', stats: emptyStats })
  const [engine, setEngine] = useState<EngineState>({ status: 'waiting' })
  const [wallet, setWallet] = useState<WalletSession | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [rpcClient, setRpcClient] = useState<PrivateRpc | null>(null)
  // Separate page lifetimes stop the wallet's background SDK services before
  // entering lending. No queried account is ever placed in the URL.
  const view = new URLSearchParams(window.location.search).get('view') === 'wallet' ? 'payments' : 'lending'
  const privacyNetwork = privacyNetworkFromSearch(window.location.search)
  const workerLabel = PRIVACY_NETWORKS[privacyNetwork].label
  const rpcRef = useRef<PrivateRpc | null>(null)
  const uiGeneration = useRef(0)
  const engineResult = useRef<{ shieldFeeBasisPoints: bigint } | null>(null)

  const connectRoute = useCallback(async (rpc: PrivateRpc, retry = false) => {
    const generation = ++uiGeneration.current
    setRoute({ status: 'connecting', stats: rpc.stats })
    unbindEthersRoute(rpc)
    try {
      const { blockNumber } = retry ? await rpc.reconnect() : await connectInitialPrivateRoute(rpc)
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      bindEthersToPrivateRoute(rpc, { healthOnly: true })
      const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
      let ethersBlock: number
      try { ethersBlock = await provider.getBlockNumber() }
      finally { provider.destroy() }
      if (ethersBlock < blockNumber) throw new Error('RPC returned an older block')
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      bindEthersToPrivateRoute(rpc)
      setRoute({ status: 'ready', blockNumber: ethersBlock, generation, stats: rpc.stats })
    } catch (error) {
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      const message = error instanceof Error ? error.message : 'Private route failed'
      unbindEthersRoute(rpc)
      // A worker can be ready even when the subsequent ethers/block check
      // fails. Stop it as well, so the lending view cannot use that route.
      rpc.disconnect()
      setRoute({ status: 'failed', message, stats: rpc.stats })
    }
  }, [])

  useEffect(() => {
    const rpc = new PrivateRpc(undefined, privacyNetwork)
    rpcRef.current = rpc
    queueMicrotask(() => {
      if (rpcRef.current === rpc) { setRpcClient(rpc); void connectRoute(rpc) }
    })
    const poll = window.setInterval(() => {
      if (rpcRef.current !== rpc) return
      if (rpc.status === 'degraded' || rpc.status === 'failed') {
        setRoute((current) => current.status === 'failed'
          ? { ...current, stats: rpc.stats }
          : { status: 'failed', message: 'Private route stopped. Reconnect to continue.', stats: rpc.stats })
      } else if (rpc.status === 'ready') {
        setRoute((current) => current.status === 'ready' ? { ...current, stats: rpc.stats } : current)
      }
    }, 2_000)
    return () => {
      window.clearInterval(poll)
      unbindEthersRoute(rpc)
      rpc.close()
      rpcRef.current = null
    }
  }, [connectRoute, privacyNetwork])

  const readyGeneration = route.status === 'ready' ? route.generation : -1
  useEffect(() => {
    // Lending is an independent read-only dApp: it must not start the payment
    // engine, POI requests, indexing or wallet storage just to inspect a loan.
    if (view !== 'payments' || readyGeneration < 0 || !rpcRef.current) return
    if (engineResult.current) { setEngine({ status: 'ready', ...engineResult.current }); return }
    const lifetime = new AbortController()
    const rpc = rpcRef.current
    setEngine({ status: 'starting' })
    void import('./railgun/engine').then(({ startSepoliaEngine }) => startSepoliaEngine(rpc)).then((result) => {
      engineResult.current = result
      if (!lifetime.signal.aborted) setEngine({ status: 'ready', ...result })
    }).catch((error: unknown) => {
      if (lifetime.signal.aborted) return
      const message = error instanceof Error ? error.message : 'Wallet services could not start.'
      const reload = /(?:failed to fetch|error loading) dynamically imported module/i.test(message)
      setEngine({ status: 'failed', message, reload })
    })
    return () => { lifetime.abort() }
  }, [view, readyGeneration])

  const retryRoute = () => {
    if (view === 'payments' && engine.status === 'failed' && engine.reload) { window.location.reload(); return }
    if (rpcRef.current) void connectRoute(rpcRef.current, true)
  }
  const disconnectRoute = () => {
    const rpc = rpcRef.current
    if (!rpc) return
    uiGeneration.current += 1
    unbindEthersRoute(rpc)
    rpc.disconnect()
    setRoute({ status: 'failed', message: 'Private route disconnected. Reconnect to resume requests.', stats: rpc.stats })
  }
  const changeNetwork = (next: PrivacyNetwork) => {
    if (next === privacyNetwork || !Object.hasOwn(PRIVACY_NETWORKS, next)) return
    const destination = new URL(window.location.href)
    destination.searchParams.set('network', next)
    window.location.assign(destination.href)
  }
  const routeLabel = route.status === 'ready'
    ? `Private connection · ${workerLabel}`
    : route.status === 'connecting' ? 'Connecting privately…' : 'Connection interrupted'

  return <div className="app-shell">
    <header className="app-header">
      <strong className="brand"><img src={brandLogo} alt="" />0xPay</strong>
      <nav className="app-navigation" aria-label="Application">
        <a href={`?network=${privacyNetwork}`} aria-current={view === 'lending' ? 'page' : undefined}>Lending</a>
        <a href={`?view=wallet&network=${privacyNetwork}`} aria-current={view === 'payments' ? 'page' : undefined}>Wallet</a>
      </nav>
      <span className="network-context">Sepolia testnet</span>
      <button type="button" className={`route-chip ${route.status}`} aria-expanded={connectionOpen} aria-controls="connection-details" onClick={() => setConnectionOpen(true)}>
        <span className="route-dot" aria-hidden="true" />{routeLabel}
      </button>
      {wallet && <span className="wallet-status">Wallet unlocked</span>}
    </header>

    <ConnectionDetails open={connectionOpen} route={route} engine={engine} traffic={trafficSnapshot()} onClose={() => setConnectionOpen(false)} onReconnect={retryRoute} onDisconnect={disconnectRoute} context={view} privacyNetwork={privacyNetwork} onNetworkChange={changeNetwork} />

    <main className="wallet-main">
      {view === 'lending' ? <LendingPanel route={rpcClient} routeGeneration={readyGeneration} onReconnect={retryRoute} /> : <Suspense fallback={<p role="status">Opening your wallet…</p>}>
        <WalletPanel routeVersion={readyGeneration} blockNumber={route.status === 'ready' ? route.blockNumber : null} engineReady={engine.status === 'ready'} shieldFeeBasisPoints={engine.status === 'ready' ? engine.shieldFeeBasisPoints : null} connectionFailed={route.status === 'failed' || engine.status === 'failed'} onRetry={retryRoute} session={wallet} onSession={setWallet} />
        {!wallet && <PaymentUseCases />}
        {engine.status === 'failed' && engine.reload && <div className="route-error" role="alert">{engine.message} <button type="button" onClick={retryRoute}>Refresh app</button></div>}
        {wallet && route.status === 'failed' && <div className="route-error" role="alert">Private route is down. No direct RPC fallback is used. <button type="button" onClick={retryRoute}>Reconnect</button></div>}
      </Suspense>}
    </main>
    <footer className="app-footer"><span>0xPay</span><nav aria-label="Footer"><a href="https://github.com/Anand-0037/0xpay" target="_blank" rel="noopener noreferrer">Source</a><a href="https://github.com/Anand-0037" target="_blank" rel="noopener noreferrer" aria-label="Anand on GitHub">GitHub</a><a href="https://x.com/AnandVashisht15" target="_blank" rel="noopener noreferrer" aria-label="Anand on X">X</a></nav></footer>
  </div>
}

export default App
