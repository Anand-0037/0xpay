import {
  NETWORK_CONFIG, NetworkName, RailgunWalletBalanceBucket, TXIDVersion,
  type RailgunBalancesEvent,
} from '@railgun-community/shared-models'

export type PrivateWethBalanceUpdate = {
  walletId: string
  bucket: RailgunWalletBalanceBucket
  amountWei: bigint
  receivedAt: number
}

type Listener = (update: PrivateWethBalanceUpdate) => void

const network = NETWORK_CONFIG[NetworkName.EthereumSepolia]
const wethAddress = network.baseToken.wrappedAddress.toLowerCase()
const listeners = new Map<string, Set<Listener>>()
const refreshes = new Map<string, Promise<bigint>>()
const scans = new Map<string, Promise<void>>()
let callbackReady: Promise<void> | undefined

function onBalancesUpdated(event: RailgunBalancesEvent) {
  if (event.txidVersion !== TXIDVersion.V2_PoseidonMerkle ||
      event.chain.type !== network.chain.type || event.chain.id !== network.chain.id ||
      event.balanceBucket === RailgunWalletBalanceBucket.Spent) return
  const amountWei = event.erc20Amounts.reduce((total, token) =>
    token.tokenAddress.toLowerCase() === wethAddress ? total + token.amount : total, 0n)
  const matching = listeners.get(event.railgunWalletID)
  if (!matching?.size) return
  const update: PrivateWethBalanceUpdate = {
    walletId: event.railgunWalletID,
    bucket: event.balanceBucket,
    amountWei,
    receivedAt: Date.now(),
  }
  for (const listener of matching) listener(update)
}

async function ensureCallback() {
  callbackReady ??= import('@railgun-community/wallet').then(({ setOnBalanceUpdateCallback }) => {
    setOnBalanceUpdateCallback(onBalancesUpdated)
  }).catch((error) => {
    callbackReady = undefined
    throw error
  })
  await callbackReady
}

export async function observePrivateWethBalance(walletId: string, listener: Listener): Promise<() => void> {
  if (!walletId) throw new Error('Unlock a private wallet before reading its balance')
  await ensureCallback()
  let matching = listeners.get(walletId)
  if (!matching) { matching = new Set(); listeners.set(walletId, matching) }
  matching.add(listener)
  return () => {
    const current = listeners.get(walletId)
    current?.delete(listener)
    if (current?.size === 0) listeners.delete(walletId)
  }
}

function beginSdkScan(walletId: string): Promise<void> {
  const existing = scans.get(walletId)
  if (existing) return existing
  const run = (async () => {
    const { refreshBalances } = await import('@railgun-community/wallet')
    await refreshBalances(network.chain, [walletId])
  })()
  scans.set(walletId, run)
  void run.finally(() => { if (scans.get(walletId) === run) scans.delete(walletId) }).catch(() => {})
  return run
}

/** SDK UTXO balance callbacks can precede the later TXID scan's completion.
 * Wait for an actual new Spendable callback, not for all background work to end.
 * This proves a received SDK balance, not that every chain scan reached its tip.
 */
export function createFreshBalanceReader(
  observe: (walletId: string, listener: Listener) => Promise<() => void>,
  scan: (walletId: string) => Promise<void>, timeoutMs = 120_000,
) {
  return async (walletId: string): Promise<bigint> => {
    let acceptFresh: (amountWei: bigint) => void = () => {}
    const fresh = new Promise<bigint>((resolve) => { acceptFresh = resolve })
    const unsubscribe = await observe(walletId, (update) => {
      if (update.walletId === walletId && update.bucket === RailgunWalletBalanceBucket.Spendable) acceptFresh(update.amountWei)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('No fresh spendable balance was received. Its amount is unknown; retry when the private route is ready.')), timeoutMs)
      })
      return await Promise.race([fresh, scan(walletId).then(() => fresh), timeout])
    } finally {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }
}

const readFreshBalance = createFreshBalanceReader(observePrivateWethBalance, beginSdkScan)

export async function refreshPrivateWethBalance(walletId: string): Promise<bigint> {
  if (!walletId) throw new Error('Unlock a private wallet before reading its balance')
  const existing = refreshes.get(walletId)
  if (existing) return existing
  const run = readFreshBalance(walletId)
  refreshes.set(walletId, run)
  try { return await run }
  finally { if (refreshes.get(walletId) === run) refreshes.delete(walletId) }
}

/** Require a fresh SDK Spendable event, including the SDK's POI bucket decision. */
export async function verifiedSpendableWeth(walletId: string): Promise<bigint> {
  return refreshPrivateWethBalance(walletId)
}
