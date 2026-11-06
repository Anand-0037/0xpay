import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { JsonRpcProvider } from 'ethers'
import { APP_RPC_URL, PrivateRpc, type RouteStats } from './rpc'
import { bindEthersToPrivateRoute, unbindEthersRoute } from './rpc/ethers-transport'
import { connectInitialPrivateRoute } from './rpc/startup'
import { PRIVACY_NETWORKS, privacyNetworkFromSearch, type PrivacyNetwork } from './rpc/networks'
import type { WalletSession } from './wallet/lifecycle'
import { ConnectionDetails, ConnectionProgress } from './ui/ConnectionDetails'
import { PaymentUseCases } from './ui/PaymentUseCases'
import { AgentWorkspace } from './agents/AgentWorkspace'
import brandLogo from './assets/0xpay-logo.png'
import './App.css'
import './wallet/RecoveryPhraseInput.css'
import './agents/AgentWorkspace.css'

type RouteState =
  | { status: 'connecting'; stats: RouteStats; startedAt: number; elapsedMs: number; stage: 'starting-worker' | 'validating-chain'; observedAttempts: number; observedFailures: number }
  | { status: 'ready'; blockNumber: number; generation: number; stats: RouteStats }
  | { status: 'failed'; message: string; stats: RouteStats; elapsedMs?: number; disconnectedByUser?: boolean }
type EngineState =
  | { status: 'waiting' | 'starting' }
  | { status: 'ready'; shieldFeeBasisPoints: bigint }
  | { status: 'failed'; message: string; reload?: boolean }

const emptyStats: RouteStats = { attempted: 0, completed: 0, failed: 0, bootstrapReads: 0 }
const WalletPanel = lazy(() => import('./wallet/WalletPanel').then((module) => ({ default: module.WalletPanel })))

function App() {
  const [route, setRoute] = useState<RouteState>(() => ({ status: 'connecting', stats: emptyStats,
    startedAt: performance.now(), elapsedMs: 0, stage: 'starting-worker', observedAttempts: 0, observedFailures: 0 }))
  const [engine, setEngine] = useState<EngineState>({ status: 'waiting' })
  const [wallet, setWallet] = useState<WalletSession | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [rpcClient, setRpcClient] = useState<PrivateRpc | null>(null)
  // Separate page lifetimes stop the wallet's background SDK services before
  // entering Agents. No queried account is ever placed in the URL.
  const entry = new URLSearchParams(window.location.search).get('view')
  const view = entry === 'agents' ? 'agents' : 'payments'
  const privacyNetwork = privacyNetworkFromSearch(window.location.search)
  const workerLabel = PRIVACY_NETWORKS[privacyNetwork].label
  const rpcRef = useRef<PrivateRpc | null>(null)
  const uiGeneration = useRef(0)
  const engineResult = useRef<{ shieldFeeBasisPoints: bigint } | null>(null)

  const connectRoute = useCallback(async (rpc: PrivateRpc, retry = false) => {
    const generation = ++uiGeneration.current
    const startedAt = performance.now()
    // A previous wallet-service error is not the outcome of this new attempt.
    setEngine((current) => current.status === 'failed' ? { status: 'waiting' } : current)
    setRoute({ status: 'connecting', stats: rpc.stats, startedAt, elapsedMs: 0, stage: 'starting-worker',
      observedAttempts: rpc.stats.attempted, observedFailures: rpc.stats.failed })
    unbindEthersRoute(rpc)
    try {
      const { blockNumber } = retry ? await rpc.reconnect() : await connectInitialPrivateRoute(rpc)
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      if (rpc.chain === 'polygon-readonly') {
        // No signing/provider/RAILGUN initialization on the agent read route.
        setRoute({ status: 'ready', blockNumber, generation, stats: rpc.stats })
        return
      }
      setRoute((current) => current.status === 'connecting' && uiGeneration.current === generation
        ? { ...current, stage: 'validating-chain', elapsedMs: performance.now() - startedAt, stats: rpc.stats } : current)
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
      // fails. Stop it as well, so no view can use that route.
      rpc.disconnect()
      setRoute({ status: 'failed', message, stats: rpc.stats, elapsedMs: performance.now() - startedAt })
    }
  }, [])

  useEffect(() => {
    const rpc = new PrivateRpc(undefined, privacyNetwork, view === 'agents' ? 'polygon-readonly' : 'sepolia')
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
      } else if (rpc.status === 'ready' || rpc.status === 'connecting') {
        setRoute((current) => {
          const stats = rpc.stats
          if (current.status === 'connecting') return { ...current, stats, elapsedMs: performance.now() - current.startedAt,
            stage: stats.failed > current.observedFailures ? 'starting-worker' : stats.attempted > current.observedAttempts ? 'validating-chain' : current.stage,
            observedAttempts: stats.attempted, observedFailures: stats.failed }
          return current.status === 'ready' ? { ...current, stats } : current
        })
      }
    }, 1_000)
    return () => {
      window.clearInterval(poll)
      unbindEthersRoute(rpc)
      rpc.close()
      rpcRef.current = null
    }
  }, [connectRoute, privacyNetwork, view])

  const readyGeneration = route.status === 'ready' ? route.generation : -1
  useEffect(() => {
    // The market workspace must not start the payment engine, POI services,
    // indexing or wallet storage just to inspect a public market position.
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
    setRoute({ status: 'failed', message: 'You disconnected the private route. Reconnect when you are ready to continue.', stats: rpc.stats, disconnectedByUser: true })
  }
  const changeNetwork = (next: PrivacyNetwork) => {
    if (next === privacyNetwork || !Object.hasOwn(PRIVACY_NETWORKS, next)) return
    const destination = new URL(window.location.href)
    destination.searchParams.set('network', next)
    window.location.assign(destination.href)
  }
  const routeLabel = route.status === 'ready'
    ? `Private connection · ${workerLabel}`
    : route.status === 'connecting' ? 'Connecting privately…' : route.disconnectedByUser ? 'Disconnected by you' : 'Connection interrupted'
  const connectionMessage = route.status === 'failed' ? route.message : engine.status === 'failed' ? engine.message : undefined

  return <div className="app-shell">
    <header className="app-header">
      <strong className="brand"><img src={brandLogo} alt="" />0xPay</strong>
      <nav className="app-navigation" aria-label="Application">
        <a href={`?view=wallet&network=${privacyNetwork}`} aria-current={view === 'payments' ? 'page' : undefined}>Wallet</a>
        <a href={`?view=agents&network=${privacyNetwork}`} aria-current={view === 'agents' ? 'page' : undefined}>Agents</a>
      </nav>
      <span className="network-context">{view === 'agents' ? 'Polygon · read-only' : 'Sepolia testnet'}</span>
      <button type="button" className={`route-chip ${route.status}`} aria-expanded={connectionOpen} aria-controls="connection-details" onClick={() => setConnectionOpen(true)}>
        <span className="route-dot" aria-hidden="true" />{routeLabel}
      </button>
      {wallet && <span className="wallet-status">Wallet unlocked</span>}
    </header>

    <ConnectionDetails open={connectionOpen} route={route} engine={engine} onClose={() => setConnectionOpen(false)} onReconnect={retryRoute} onDisconnect={disconnectRoute} context={view} privacyNetwork={privacyNetwork} onNetworkChange={changeNetwork} />

    <main className="wallet-main">
      {view === 'agents' ? <AgentWorkspace route={rpcClient} routeGeneration={readyGeneration} onReconnect={retryRoute} /> : <Suspense fallback={<p role="status">Opening your wallet…</p>}>
        {route.status === 'connecting' && <p className="wallet-privacy-note" role="status"><ConnectionProgress stage={route.stage} elapsedMs={route.elapsedMs} networkLabel={workerLabel} /></p>}
        <WalletPanel routeVersion={readyGeneration} blockNumber={route.status === 'ready' ? route.blockNumber : null} engineReady={engine.status === 'ready'} shieldFeeBasisPoints={engine.status === 'ready' ? engine.shieldFeeBasisPoints : null} connectionFailed={route.status === 'failed' || engine.status === 'failed'} connectionMessage={connectionMessage} disconnectedByUser={route.status === 'failed' && route.disconnectedByUser} connectionActionLabel={engine.status === 'failed' && engine.reload ? 'Refresh app' : 'Reconnect'} onRetry={retryRoute} session={wallet} onSession={setWallet} />
        {!wallet && <PaymentUseCases />}
      </Suspense>}
    </main>
    <footer className="app-footer"><span>0xPay</span><nav aria-label="Footer"><a href="https://github.com/Anand-0037/0xpay" target="_blank" rel="noopener noreferrer">Source</a><a href="https://github.com/Anand-0037" target="_blank" rel="noopener noreferrer" aria-label="Anand on GitHub">GitHub</a><a href="https://x.com/AnandVashisht15" target="_blank" rel="noopener noreferrer" aria-label="Anand on X">X</a></nav></footer>
  </div>
}

export default App
