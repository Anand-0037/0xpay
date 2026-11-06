import { useEffect, useRef, useState } from 'react'
import { formatEther } from 'ethers'
import { RailgunWalletBalanceBucket } from '@railgun-community/shared-models'
import { observePrivateWethBalance, refreshPrivateWethBalance } from '../railgun/balance'

export type PrivateBalanceProps = {
  walletId: string
  routeReady: boolean
  routeError?: string
  refreshKey?: number
}

const buckets = [
  [RailgunWalletBalanceBucket.Spendable, 'Spendable'],
  [RailgunWalletBalanceBucket.ShieldPending, 'Shield pending'],
  [RailgunWalletBalanceBucket.ShieldBlocked, 'Shield blocked'],
  [RailgunWalletBalanceBucket.ProofSubmitted, 'Proof submitted'],
  [RailgunWalletBalanceBucket.MissingInternalPOI, 'Awaiting internal POI'],
  [RailgunWalletBalanceBucket.MissingExternalPOI, 'Awaiting external POI'],
] as const

type BucketAmounts = Partial<Record<RailgunWalletBalanceBucket, bigint>>

export function PrivateBalance(props: PrivateBalanceProps) {
  return <PrivateBalanceForWallet key={`${props.walletId}:${props.routeReady}:${props.refreshKey ?? 0}`} {...props} />
}

function PrivateBalanceForWallet({ walletId, routeReady, routeError }: PrivateBalanceProps) {
  const [amounts, setAmounts] = useState<BucketAmounts>({})
  const [lastUpdate, setLastUpdate] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  async function refresh(id: string, version: number) {
    if (generation.current !== version) return
    setError('')
    setRefreshing(true)
    try {
      await refreshPrivateWethBalance(id)
    } catch (cause) {
      if (generation.current === version) setError(cause instanceof Error ? cause.message : 'Private balance scan failed')
    } finally {
      if (generation.current === version) setRefreshing(false)
    }
  }

  useEffect(() => {
    const version = ++generation.current
    if (!routeReady || !walletId) return () => { generation.current += 1 }

    let unsubscribe: (() => void) | undefined
    void observePrivateWethBalance(walletId, (update) => {
      if (generation.current !== version || update.walletId !== walletId) return
      setAmounts((current) => ({ ...current, [update.bucket]: update.amountWei }))
      setLastUpdate(update.receivedAt)
    }).then((stop) => {
      if (generation.current !== version) { stop(); return }
      unsubscribe = stop
      setSubscribed(true)
      void refresh(walletId, version)
    }).catch((cause) => {
      if (generation.current === version) setError(cause instanceof Error ? cause.message : 'Could not observe private balances')
    })
    return () => { generation.current += 1; unsubscribe?.() }
  }, [walletId, routeReady])

  const routeProblem = !routeReady ? routeError || 'Private route is unavailable. Balance reads have stopped.' : ''
  const status = routeProblem ? routeProblem : error ? error : refreshing ? 'Syncing private balance…' :
    lastUpdate ? `Updated at ${new Date(lastUpdate).toLocaleTimeString()}` :
      subscribed ? 'Syncing your private balance. The first scan may take a few minutes.' : 'Preparing balance…'

  return <section className="private-balance" aria-labelledby="private-balance-heading">
    <div className="private-balance-heading"><div><p className="eyebrow">PRIVATE BALANCE</p><h2 id="private-balance-heading">WETH on Sepolia</h2></div>
      {routeReady && subscribed && !refreshing && <button type="button" onClick={() => void refresh(walletId, generation.current)}>Refresh balance</button>}
    </div>
    <p className="private-balance-status" role={routeProblem || error ? 'alert' : 'status'}>{status}</p>
    <div className="private-balance-grid">
      {buckets.map(([bucket, label]) => <div key={bucket}>
        <span>{label}</span><strong>{routeProblem ? '—' : amounts[bucket] === undefined ? 'Syncing' : `${formatEther(amounts[bucket])} WETH`}</strong>
      </div>)}
    </div>
  </section>
}
