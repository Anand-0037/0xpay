import { useEffect, useState } from 'react'
import type { PrivateRpc } from '../rpc'
import { formatBaseUsd, type LendingPosition } from './position'
import { readLendingAssets, type LendingAssetRow } from './assets'

type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'>
type Props = { route: Route; position: LendingPosition }
type Result = { route: Route; account: string; blockHash: string } & (
  { status: 'ready'; rows: LendingAssetRow[] } | { status: 'error'; message: string }
)

/** Never round a positive balance down to a displayed zero. */
// oxlint-disable-next-line react/only-export-components -- Shared pure formatter has bigint precision regression coverage.
export function formatAssetAmount(amount: bigint, decimals: number) {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('Unsupported token amount.')
  }
  const unit = 10n ** BigInt(decimals)
  const whole = (amount / unit).toString()
  const fraction = decimals ? (amount % unit).toString().padStart(decimals, '0') : ''
  const exactFraction = fraction.replace(/0+$/, '')
  const exact = exactFraction ? `${whole}.${exactFraction}` : whole
  const precision = Math.min(decimals, 6)
  const compactFraction = fraction.slice(0, precision).replace(/0+$/, '')
  const compact = amount > 0n && amount < unit && !compactFraction
    ? `<0.${'0'.repeat(precision - 1)}1`
    : compactFraction ? `${whole}.${compactFraction}` : whole
  return { exact, compact }
}

function TokenAmount({ amount, row, baseCurrencyUnit }: { amount: bigint; row: LendingAssetRow; baseCurrencyUnit: bigint }) {
  const { exact, compact } = formatAssetAmount(amount, row.decimals)
  const valuation = amount * row.priceBase / (10n ** BigInt(row.decimals))
  return <div className="lending-asset-balance">
    <span className="lending-asset-amount" title={`${exact} ${row.symbol}`} aria-label={`${exact} ${row.symbol}`}>
      {compact} <span>{row.symbol}</span>
    </span>
    <span className="lending-asset-value" title="Testnet oracle valuation">{formatBaseUsd(valuation, baseCurrencyUnit)}</span>
  </div>
}

function AssetGroup({ rows, borrowed, baseCurrencyUnit }: { rows: LendingAssetRow[]; borrowed?: boolean; baseCurrencyUnit: bigint }) {
  const visible = rows.filter(row => borrowed ? row.stableDebt + row.variableDebt > 0n : row.supplied > 0n)
  return <section className="lending-asset-group" aria-label={borrowed ? 'Borrowed assets' : 'Supplied assets'}>
    <h4>{borrowed ? 'Borrowed' : 'Supplied'} <span>{visible.length}</span></h4>
    {visible.length === 0 ? <p className="lending-assets-message">{borrowed ? 'No outstanding debt.' : 'No supplied assets.'}</p> :
      <ul>{visible.map(row => <li key={row.asset}>
        <div className="lending-asset-name">
          <strong title={`Asset contract: ${row.asset}`}>{row.symbol}</strong>
          {!borrowed && <span>Collateral: {row.collateralEnabled ? 'Yes' : 'No'}</span>}
          {borrowed && <span>{row.stableDebt > 0n && row.variableDebt > 0n ? 'Stable + variable debt' : row.stableDebt > 0n ? 'Stable debt' : 'Variable debt'}</span>}
        </div>
        <TokenAmount amount={borrowed ? row.stableDebt + row.variableDebt : row.supplied} row={row} baseCurrencyUnit={baseCurrencyUnit} />
      </li>)}</ul>}
  </section>
}

export function LendingAssets(props: Props) {
  // A new snapshot or failed route discards the old component synchronously.
  return <LendingAssetsForSnapshot key={`${props.position.account}:${props.position.blockHash}:${props.route.status}`} {...props} />
}

function LendingAssetsForSnapshot({ route, position }: Props) {
  const [result, setResult] = useState<Result | null>(null)
  useEffect(() => {
    let active = true
    if (route.status !== 'ready') return () => { active = false }
    const source = { route, account: position.account, blockHash: position.blockHash }
    void readLendingAssets(route, position).then(rows => {
      if (active && route.status === 'ready') setResult({ ...source, status: 'ready', rows })
    }).catch((cause: unknown) => {
      if (active) setResult({ ...source, status: 'error', message: cause instanceof Error ? cause.message : 'Assets could not be loaded through the private route.' })
    })
    return () => { active = false }
  }, [route, position])

  const current = result?.route === route && result.account === position.account && result.blockHash === position.blockHash ? result : null
  return <section className="lending-assets" aria-labelledby="lending-assets-heading">
    <div className="lending-assets-heading">
      <h3 id="lending-assets-heading">Position assets</h3>
      <span>Sepolia · Block {position.blockNumber.toLocaleString('en-US')}</span>
    </div>
    <p className="lending-assets-caption">Token balances and testnet oracle values at the same snapshot. Testnet assets have no implied market value.</p>
    {route.status !== 'ready' ? <p className="lending-assets-message" role="status">Asset reads paused. Reconnect the private route.</p> :
      !current ? <p className="lending-assets-message" role="status" aria-live="polite">Loading assets through the private route…</p> :
      current.status === 'error' ? <p className="lending-assets-error" role="alert">{current.message}</p> :
      <div className="lending-assets-grid"><AssetGroup rows={current.rows} baseCurrencyUnit={position.baseCurrencyUnit} /><AssetGroup rows={current.rows} borrowed baseCurrencyUnit={position.baseCurrencyUnit} /></div>}
  </section>
}
