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
const refreshes = new Map<string, Promise<void>>()
let callbackReady: Promise<void> | undefined

function onBalancesUpdated(event: RailgunBalancesEvent) {
  if (event.txidVersion !== TXIDVersion.V2_PoseidonMerkle ||
      event.chain.type !== network.chain.type || event.chain.id !== network.chain.id ||
      event.balanceBucket === RailgunWalletBalanceBucket.Spent) return
  const matching = listeners.get(event.railgunWalletID)
  if (!matching?.size) return
  const amountWei = event.erc20Amounts.reduce((total, token) =>
    token.tokenAddress.toLowerCase() === wethAddress ? total + token.amount : total, 0n)
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

export async function refreshPrivateWethBalance(walletId: string): Promise<void> {
  if (!walletId) throw new Error('Unlock a private wallet before reading its balance')
  await ensureCallback()
  const existing = refreshes.get(walletId)
  if (existing) return existing
  const run = (async () => {
    const { refreshBalances } = await import('@railgun-community/wallet')
    await refreshBalances(network.chain, [walletId])
  })()
  refreshes.set(walletId, run)
  try { await run }
  finally { if (refreshes.get(walletId) === run) refreshes.delete(walletId) }
}
