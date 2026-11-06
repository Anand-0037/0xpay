import { useCallback, useEffect, useRef, useState } from 'react'
import { JsonRpcProvider } from 'ethers'
import { APP_RPC_URL, PrivateRpc, type RouteStats } from './rpc'
import { bindEthersToPrivateRoute, unbindEthersRoute } from './rpc/ethers-transport'
import { WalletPanel } from './wallet/WalletPanel'
import type { WalletSession } from './wallet/lifecycle'
import { ConnectionDetails } from './ui/ConnectionDetails'
import { trafficSnapshot } from './net/network-guard'
import brandLogo from './assets/0xpay-logo.png'
import './App.css'

type RouteState =
  | { status: 'connecting'; stats: RouteStats }
  | { status: 'ready'; blockNumber: number; generation: number; stats: RouteStats }
  | { status: 'failed'; message: string; stats: RouteStats }
type EngineState =
  | { status: 'waiting' | 'starting' }
  | { status: 'ready'; shieldFeeBasisPoints: bigint }
  | { status: 'failed'; message: string; reload?: boolean }

const emptyStats: RouteStats = { attempted: 0, completed: 0, failed: 0, bootstrapReads: 0 }

function App() {
  const [route, setRoute] = useState<RouteState>({ status: 'connecting', stats: emptyStats })
  const [engine, setEngine] = useState<EngineState>({ status: 'waiting' })
  const [wallet, setWallet] = useState<WalletSession | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const rpcRef = useRef<PrivateRpc | null>(null)
  const uiGeneration = useRef(0)
  const engineReady = useRef(false)

  const connectRoute = useCallback(async (rpc: PrivateRpc, retry = false) => {
    const generation = ++uiGeneration.current
    setRoute({ status: 'connecting', stats: rpc.stats })
    if (!engineReady.current) setEngine({ status: 'waiting' })
    let startingEngine = false
    try {
      const { blockNumber } = retry ? await rpc.reconnect() : await rpc.connect()
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      bindEthersToPrivateRoute(rpc)
      const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
      let ethersBlock: number
      try { ethersBlock = await provider.getBlockNumber() }
      finally { provider.destroy() }
      if (ethersBlock < blockNumber) throw new Error('RPC returned an older block')
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      setRoute({ status: 'ready', blockNumber: ethersBlock, generation, stats: rpc.stats })
      if (engineReady.current) return
      startingEngine = true
      setEngine({ status: 'starting' })
      const { startSepoliaEngine } = await import('./railgun/engine')
      const { shieldFeeBasisPoints } = await startSepoliaEngine(rpc)
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      engineReady.current = true
      setEngine({ status: 'ready', shieldFeeBasisPoints })
      setRoute((current) => current.status === 'ready' ? { ...current, stats: rpc.stats } : current)
    } catch (error) {
      if (rpcRef.current !== rpc || uiGeneration.current !== generation) return
      const message = error instanceof Error ? error.message : 'Private route failed'
      if (startingEngine && /(?:failed to fetch|error loading) dynamically imported module/i.test(message)) {
        setEngine({ status: 'failed', message: 'A newer version is available. Refresh this page to continue.', reload: true })
        return
      }
      if (startingEngine) setEngine({ status: 'failed', message })
      if (!startingEngine) unbindEthersRoute(rpc)
      setRoute({ status: 'failed', message, stats: rpc.stats })
    }
  }, [])

  useEffect(() => {
    const rpc = new PrivateRpc()
    rpcRef.current = rpc
    queueMicrotask(() => { if (rpcRef.current === rpc) void connectRoute(rpc) })
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
  }, [connectRoute])

  const retryRoute = () => {
    if (engine.status === 'failed' && engine.reload) { window.location.reload(); return }
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
  const routeLabel = route.status === 'ready'
    ? 'Private connection · Nym'
    : route.status === 'connecting' ? 'Connecting privately…' : 'Connection interrupted'

  return <div className="app-shell">
    <header className="app-header">
      <strong className="brand"><img src={brandLogo} alt="" />0xPay</strong>
      <span className="network-context">Ethereum Sepolia</span>
      <button type="button" className={`route-chip ${route.status}`} aria-expanded={connectionOpen} aria-controls="connection-details" onClick={() => setConnectionOpen(true)}>
        <span className="route-dot" aria-hidden="true" />{routeLabel}
      </button>
      {wallet && <span className="wallet-status">Wallet unlocked</span>}
    </header>

    <ConnectionDetails open={connectionOpen} route={route} engine={engine} traffic={trafficSnapshot()} onClose={() => setConnectionOpen(false)} onReconnect={retryRoute} onDisconnect={disconnectRoute} />

    <main className="wallet-main">
      <WalletPanel routeVersion={route.status === 'ready' ? route.generation : -1} blockNumber={route.status === 'ready' ? route.blockNumber : null} engineReady={engine.status === 'ready'} shieldFeeBasisPoints={engine.status === 'ready' ? engine.shieldFeeBasisPoints : null} connectionFailed={route.status === 'failed' || engine.status === 'failed'} onRetry={retryRoute} session={wallet} onSession={setWallet} />
      {engine.status === 'failed' && engine.reload && <div className="route-error" role="alert">{engine.message} <button type="button" onClick={retryRoute}>Refresh app</button></div>}
      {wallet && route.status === 'failed' && <div className="route-error" role="alert">Private route is down. No direct RPC fallback is used. <button type="button" onClick={retryRoute}>Reconnect</button></div>}
    </main>
  </div>
}

export default App
