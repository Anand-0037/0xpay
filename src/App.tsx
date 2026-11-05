import { useEffect, useRef, useState } from 'react'
import { JsonRpcProvider } from 'ethers'
import { PrivateRpc, type RouteStats } from './rpc'
import { bindEthersToPrivateRoute, unbindEthersRoute } from './rpc/ethers-transport'
import { APP_RPC_URL } from './rpc'
import './App.css'

type RouteState =
  | { status: 'idle' | 'connecting' }
  | { status: 'ready'; blockNumber: number; stats: RouteStats }
  | { status: 'failed'; message: string; stats?: RouteStats }
type EngineState = { status: 'idle' | 'starting' } | { status: 'ready'; shieldFeeBasisPoints: bigint } | { status: 'failed'; message: string }

function App() {
  const [route, setRoute] = useState<RouteState>({ status: 'idle' })
  const [engine, setEngine] = useState<EngineState>({ status: 'idle' })
  const rpcRef = useRef<PrivateRpc | null>(null)
  useEffect(() => () => {
    if (rpcRef.current) {
      unbindEthersRoute(rpcRef.current)
      rpcRef.current.close()
    }
  }, [])

  async function connectRoute() {
    if (rpcRef.current) {
      unbindEthersRoute(rpcRef.current)
      rpcRef.current.close()
    }
    setRoute({ status: 'connecting' })
    let rpc: PrivateRpc | null = null
    try {
      rpc = new PrivateRpc()
      rpcRef.current = rpc
      const { blockNumber } = await rpc.connect()
      bindEthersToPrivateRoute(rpc)
      const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
      try {
        const ethersBlock = await provider.getBlockNumber()
        if (ethersBlock < blockNumber) throw new Error('Ethers read returned an older block')
        if (rpcRef.current === rpc) setRoute({ status: 'ready', blockNumber: ethersBlock, stats: rpc.stats })
      } finally { provider.destroy() }
    } catch (error) {
      if (rpcRef.current === rpc || rpc === null) {
        rpc?.close()
        if (rpc) unbindEthersRoute(rpc)
        rpcRef.current = null
        setRoute({ status: 'failed', message: error instanceof Error ? error.message : 'Unknown connection error', stats: rpc?.stats })
      }
    }
  }

  async function initializeEngine() {
    const rpc = rpcRef.current
    if (route.status !== 'ready' || !rpc || engine.status === 'starting') return
    setEngine({ status: 'starting' })
    try {
      const { startSepoliaEngine } = await import('./railgun/engine')
      const { shieldFeeBasisPoints } = await startSepoliaEngine(rpc)
      if (rpcRef.current === rpc) {
        setEngine({ status: 'ready', shieldFeeBasisPoints })
        setRoute((current) => current.status === 'ready' ? { ...current, stats: rpc.stats } : current)
      }
    } catch (error) {
      if (rpcRef.current === rpc) setEngine({ status: 'failed', message: error instanceof Error ? error.message : 'Railgun failed to start' })
    }
  }

  return <div className="app-shell">
    <header className="app-header">
      <strong className="brand">0xPay</strong>
      <nav aria-label="Wallet navigation"><span className="nav-current" aria-current="page">Overview</span></nav>
      <div className="network-context"><strong>Ethereum Sepolia</strong><span>{route.status === 'ready' ? `Nym read connected · block ${route.blockNumber.toLocaleString()}` : route.status === 'connecting' ? 'Connecting to Nym…' : 'Nym read not connected'}</span></div>
      <span className="wallet-status">No wallet set up</span>
    </header>

    <main className="wallet-main">
      <div className="section-intro"><span>WALLET OVERVIEW</span><span>Balances appear after wallet setup and synchronization</span></div>
      <div className="balance-grid">
        <section className="private-balance" aria-labelledby="private-heading">
          <p id="private-heading" className="eyebrow">PRIVATE · SPENDABLE</p>
          <div className="balance-line"><strong aria-label="Private balance unavailable">—</strong><span>Asset unavailable</span></div>
          <p>No private funds are available to display. A network connection alone does not make a wallet ready to spend.</p>
          <div className="actions"><button type="button" className="primary" disabled title="Wallet setup and private send are not available yet">Send privately →</button><button type="button" disabled title="Wallet setup and shielding are not available yet">Shield funds</button><button type="button" disabled title="Wallet setup is not available yet">Receive</button><button type="button" disabled title="Wallet setup is not available yet">Withdraw</button></div>
        </section>
        <section className="public-balance" aria-labelledby="public-heading"><p id="public-heading" className="eyebrow">PUBLIC ACCOUNT</p><strong>—</strong><p>No funding wallet connected</p><div className="rule"/><small>Public funding transactions can reveal the source account. A connected read route does not hide wallet or broadcast traffic.</small></section>
      </div>

      <section className="readiness" aria-labelledby="readiness-heading"><div><h2 id="readiness-heading">Payment readiness</h2><p>Connect the private read route first. Wallet funding, shielding and sending are the next build steps.</p></div><button type="button" onClick={connectRoute} disabled={route.status === 'connecting'}>{route.status === 'connecting' ? 'Connecting…' : route.status === 'ready' ? 'Reconnect read route' : 'Connect read route'}</button>
        {'stats' in route && route.stats && <p className="route-stats" aria-live="polite">Routed reads: {route.stats.completed} of {route.stats.attempted} completed via Anon-RPC worker. {route.stats.failed} failed. Bootstrap: {route.stats.bootstrapReads} direct specifier reads. This counter covers this app process only.</p>}
        {route.status === 'ready' && <div className="engine-start"><button type="button" onClick={initializeEngine} disabled={engine.status === 'starting' || engine.status === 'ready'}>{engine.status === 'starting' ? 'Starting Railgun…' : engine.status === 'ready' ? 'Railgun provider connected' : 'Initialize Railgun'}</button>{engine.status === 'ready' && <p>Sepolia shield fee: {engine.shieldFeeBasisPoints.toString()} basis points. Wallet synchronization and spendability still require a wallet.</p>}{engine.status === 'failed' && <p role="alert">Railgun did not start: {engine.message}</p>}</div>}
        <div className="stages"><div className={route.status === 'ready' ? 'stage ready' : 'stage'}><span>01</span><div><strong>Private RPC read</strong><small>{route.status === 'ready' ? 'App and ethers provider block read through Nym' : 'Not verified in this session'}</small></div></div><div className="stage"><span>02</span><div><strong>Wallet synced</strong><small>Not available yet</small></div></div><div className="stage"><span>03</span><div><strong>Shielded funds</strong><small>Not available yet</small></div></div><div className="stage"><span>04</span><div><strong>Ready to send</strong><small>Not available yet</small></div></div></div>
        {route.status === 'failed' && <p className="route-error" role="alert">Read route failed: {route.message}. No direct RPC retry was made for the app read.</p>}
      </section>

      <section className="activity" aria-labelledby="activity-heading"><h2 id="activity-heading">Recent activity</h2><p>There is no wallet activity to show.</p></section>
      <footer>RAILGUN private-payment integration is in progress. Anon-RPC protects only requests routed through its worker; it does not cover every network path or prove anonymity.</footer>
    </main>
  </div>
}

export default App
