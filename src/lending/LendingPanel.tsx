import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PrivateRpc } from '../rpc'
import { readLendingPosition, type LendingPosition, formatBaseUsd, formatHealthFactor, modelPosition } from './position'
import { LendingAssets } from './LendingAssets'

type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'>
type Props = { route: Route | null; routeGeneration: number; onReconnect: () => void }
type Snapshot = { position: LendingPosition; route: Route; generation: number; input: string }
const EXAMPLE = '0x7a3db09ccf7cfb619cdbff6ade911498d5a022c6'
const POOL = '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951'
const WAD = 10n ** 18n

function riskLabel(debt: bigint, health: bigint | null) {
  if (debt === 0n) return { label: 'No outstanding debt', tone: 'neutral', description: 'No borrow debt was reported in this snapshot.' }
  if (health === null) return { label: 'Risk unavailable', tone: 'warning', description: 'A health factor could not be calculated.' }
  if (health < WAD) return { label: 'Below liquidation threshold', tone: 'danger', description: 'This snapshot shows a health factor below 1. Liquidation may be possible; it does not confirm that a liquidation occurred.' }
  if (health === WAD) return { label: 'At liquidation threshold', tone: 'warning', description: 'The health factor is exactly 1 at this block. Interest and market movements can change it.' }
  return { label: 'Above liquidation threshold', tone: 'neutral', description: 'The health factor is above 1 at this block. This is a snapshot, not a guarantee against liquidation.' }
}

export function LendingPanel(props: Props) {
  // Keep only the draft query in page memory across reconnects. The keyed
  // snapshot/scenario below is discarded whenever the route changes.
  const [account, setAccount] = useState('')
  return <LendingPanelForRoute key={`${props.routeGeneration}:${props.route?.status ?? 'unavailable'}`} {...props} account={account} onAccountChange={setAccount} />
}

function LendingPanelForRoute({ route, routeGeneration, onReconnect, account, onAccountChange }: Props & { account: string; onAccountChange: (value: string) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dropPercent, setDropPercent] = useState(0)
  const [repayPercent, setRepayPercent] = useState(0)
  const request = useRef(0)
  const active = useRef(true)
  const latest = useRef({ route, generation: routeGeneration, status: route?.status })
  const routeReady = route?.status === 'ready' && routeGeneration >= 0
  const connecting = !route || route.status === 'connecting' || (route.status === 'ready' && routeGeneration < 0)

  useEffect(() => {
    latest.current = { route, generation: routeGeneration, status: route?.status }
  }, [route, routeGeneration, routeReady])
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  function editAccount(value: string) {
    request.current++
    onAccountChange(value)
    setSnapshot(null)
    setLoading(false)
    setError('')
    setDropPercent(0)
    setRepayPercent(0)
  }

  async function loadPosition(input = account) {
    const normalized = input.trim()
    setError('')
    setSnapshot(null)
    if (!route || route.status !== 'ready' || routeGeneration < 0) { setError('Reconnect the private route before loading a position.'); return }
    if (!/^0x[0-9a-fA-F]{40}$/.test(normalized)) { setError('Enter an Ethereum 0x address. Wallet connection is not required.'); return }
    const id = ++request.current
    const source = route
    const generation = routeGeneration
    setLoading(true)
    setDropPercent(0)
    setRepayPercent(0)
    try {
      const position = await readLendingPosition(source, normalized)
      if (!active.current || id !== request.current || latest.current.route !== source ||
        latest.current.generation !== generation || latest.current.status !== 'ready' || source.status !== 'ready') return
      if (position.account.toLowerCase() !== normalized.toLowerCase() || position.chainId !== 11155111) throw new Error('Position response does not match this account and network.')
      setSnapshot({ position, route: source, generation, input: normalized.toLowerCase() })
    } catch (cause) {
      if (active.current && id === request.current) setError(cause instanceof Error ? cause.message : 'The position could not be loaded through the private route.')
    } finally { if (active.current && id === request.current) setLoading(false) }
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void loadPosition() }
  const position = routeReady && snapshot?.route === route && snapshot.generation === routeGeneration &&
    snapshot.input === account.trim().toLowerCase() ? snapshot.position : null
  const risk = position ? riskLabel(position.debtBase, position.debtBase === 0n ? null : position.healthFactorWad) : null
  let scenario: ReturnType<typeof modelPosition> | null = null
  let scenarioError = ''
  if (position) {
    try { scenario = modelPosition(position, { collateralDropBps: BigInt(dropPercent) * 100n, repayBase: position.debtBase * BigInt(repayPercent) / 100n }) }
    catch (cause) { scenarioError = cause instanceof Error ? cause.message : 'This scenario could not be calculated.' }
  }

  return <section className="lending-workspace" aria-labelledby="lending-title">
    <div className="lending-hero"><p className="lending-eyebrow">AAVE V3 · ETHEREUM SEPOLIA</p><h1 id="lending-title">Check your loan,<br /><em>privately.</em></h1><p>See collateral, debt and liquidation risk without connecting a wallet. Position reads use the private RPC route.</p></div>
    <div className="lending-card lending-search">
      <form onSubmit={submit}><label htmlFor="lending-account">Wallet address</label><div className="lending-input-row"><input id="lending-account" value={account} onChange={(event) => editAccount(event.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="0x…" aria-describedby="lending-address-help" /><button className="lending-primary" type="submit" disabled={!routeReady || loading}>{loading ? 'Loading position…' : 'Check position'}<span aria-hidden="true">↗</span></button></div><p id="lending-address-help" className="lending-muted">This app doesn’t save the address or add it to the URL.</p></form>
      <button className="lending-example" type="button" disabled={!routeReady || loading} onClick={() => { editAccount(EXAMPLE); void loadPosition(EXAMPLE) }}>Try a public example <span aria-hidden="true">→</span></button>
      {!routeReady && <p className="lending-route-message" role="status">{connecting ? 'Connecting through the privacy network…' : <>Position reads have stopped. <button type="button" onClick={onReconnect}>Reconnect privately</button></>}</p>}
      {loading && <p className="lending-muted" role="status">Reading a real Aave position through Anon-RPC…</p>}
      {error && <p className="lending-error" role="alert">{error}</p>}
    </div>

    {position && risk && <div className="lending-results" aria-live="polite">
      <div className="lending-result-heading"><div><p className="lending-eyebrow">POSITION SNAPSHOT</p><h2>Aave position</h2></div><button type="button" className="lending-secondary" disabled={loading} onClick={() => void loadPosition()}>Refresh snapshot</button></div>
      <div className="lending-metrics"><div className="lending-card"><span>Collateral</span><strong>{formatBaseUsd(position.collateralBase, position.baseCurrencyUnit)}</strong></div><div className="lending-card"><span>Outstanding debt</span><strong>{formatBaseUsd(position.debtBase, position.baseCurrencyUnit)}</strong></div><div className="lending-card"><span>Borrowing headroom</span><strong>{formatBaseUsd(position.availableBorrowBase, position.baseCurrencyUnit)}</strong></div></div>
      {route && <LendingAssets route={route} position={position} />}
      <div className={`lending-card lending-health ${risk.tone}`}><div><span className="lending-eyebrow">HEALTH FACTOR</span><strong>{position.debtBase === 0n ? 'No debt' : formatHealthFactor(position.healthFactorWad)}</strong></div><div><h3>{risk.label}</h3><p>{risk.description}</p></div></div>
      <p className="lending-snapshot">Testnet oracle values · Snapshot at block {position.blockNumber.toLocaleString()} · {new Date(position.blockTimestamp * 1000).toLocaleString()} · Refresh before making a decision.</p>

      <details className="lending-card lending-scenario"><summary>Stress-test this snapshot</summary><p className="lending-muted">Explore a local estimate using this snapshot. No repayment or transaction is sent.</p><div className="lending-sliders"><label htmlFor="collateral-drop"><span>Collateral value haircut <strong>{dropPercent}%</strong></span><input id="collateral-drop" type="range" min="0" max="100" step="1" value={dropPercent} onChange={(event) => setDropPercent(Number(event.target.value))} /></label><label htmlFor="debt-repayment"><span>Debt repaid in scenario <strong>{repayPercent}%</strong></span><input id="debt-repayment" type="range" min="0" max="100" step="1" value={repayPercent} onChange={(event) => setRepayPercent(Number(event.target.value))} /></label></div>{scenario && <div className="lending-model-result"><span>Estimated health factor</span><strong>{scenario.debtBase === 0n ? 'No debt' : scenario.healthFactorWad === null ? 'Unavailable' : formatHealthFactor(scenario.healthFactorWad)}</strong><span>Remaining debt: {formatBaseUsd(scenario.debtBase, position.baseCurrencyUnit)}</span></div>}{scenarioError && <p className="lending-error" role="alert">{scenarioError}</p>}<p className="lending-muted">Applies an independent haircut to collateral value while debt values and protocol parameters stay fixed. Debt stays fixed even when the same asset is supplied and borrowed, so this is not a shared asset-price simulation. Repayment assumes no collateral withdrawal. Interest and execution costs are excluded.</p></details>

      <details className="lending-technical"><summary>Snapshot & privacy details</summary><dl><div><dt>Account</dt><dd>{position.account}</dd></div><div><dt>Market</dt><dd>Aave V3 · Ethereum Sepolia</dd></div><div><dt>Pool</dt><dd><a href={`https://sepolia.etherscan.io/address/${POOL}`} target="_blank" rel="noreferrer noopener">{POOL} ↗</a></dd></div><div><dt>Liquidation threshold</dt><dd>{(Number(position.liquidationThresholdBps) / 100).toFixed(2)}%</dd></div></dl><p>The position is public onchain. Anon-RPC reduces direct linkage between your IP and the address queried at the RPC provider; it does not make loans or transactions private. The worker’s setup lookup and network bootstrap are separate trust dependencies. Borrowing headroom is account-level; asset liquidity and reserve limits can further restrict borrowing. The pool link opens a public explorer outside this route.</p></details>
    </div>}
  </section>
}
