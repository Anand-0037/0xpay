import { createBrowserDatabase, protectNamespaceReads } from './browser-database'
import { Buffer } from 'buffer'
import type { SnarkJSGroth16 } from '@railgun-community/wallet'
import { APP_RPC_URL, type PrivateRpc } from '../rpc'
import { bindEthersToPrivateRoute } from '../rpc/ethers-transport'
import { createBrowserArtifactStore } from './artifact-store'
import { checkSepoliaPoi, POI_NODE_URL } from './poi'

let startPromise: Promise<{ shieldFeeBasisPoints: bigint; unshieldFeeBasisPoints: bigint }> | undefined
// The SDK's third loadProvider argument is its event polling interval, not a timeout.
const PROVIDER_POLL_INTERVAL_MS = 15_000

export function startSepoliaEngine(route: PrivateRpc) {
  startPromise ??= initialize(route).catch((error) => {
    startPromise = undefined
    throw error
  })
  return startPromise
}

async function initialize(route: PrivateRpc) {
  bindEthersToPrivateRoute(route)
  await checkSepoliaPoi()
  ;(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer
  const [{ startRailgunEngine, loadProvider, unloadProvider, stopRailgunEngine, getProver, getEngine }, { NetworkName }, { groth16 }] = await Promise.all([
    import('@railgun-community/wallet'),
    import('@railgun-community/shared-models'),
    import('snarkjs'),
  ])
  const artifactStore = await createBrowserArtifactStore()
  try {
    await startRailgunEngine(
      '0xpay', createBrowserDatabase('0xpay-railgun-engine'), false, artifactStore,
      false, false, [POI_NODE_URL],
    )
    protectNamespaceReads(getEngine().db)
    // The SDK's older declaration does not match snarkjs's optional-input declaration.
    getProver().setSnarkJSGroth16(groth16 as unknown as SnarkJSGroth16)
    const { feesSerialized } = await loadProvider({
      chainId: 11155111,
      providers: [{ provider: APP_RPC_URL, priority: 1, weight: 2 }],
    }, NetworkName.EthereumSepolia, PROVIDER_POLL_INTERVAL_MS)
    return {
      shieldFeeBasisPoints: BigInt(feesSerialized.shieldFeeV2),
      unshieldFeeBasisPoints: BigInt(feesSerialized.unshieldFeeV2),
    }
  } catch (error) {
    // The SDK caches engine and polling providers separately. Clear both before retry.
    const cleanup = await Promise.allSettled([
      unloadProvider(NetworkName.EthereumSepolia),
    ])
    try { await stopRailgunEngine() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Wallet startup and cleanup failed. Reload this tab before retrying.') }
    const failedCleanup = cleanup.find((result) => result.status === 'rejected')
    if (failedCleanup?.status === 'rejected') throw new AggregateError([error, failedCleanup.reason], 'Wallet startup and provider cleanup failed. Reload this tab before retrying.')
    throw error
  }
}
