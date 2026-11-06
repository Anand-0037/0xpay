import Level from 'level-js'
import { Buffer } from 'buffer'
import type { SnarkJSGroth16 } from '@railgun-community/wallet'
import { APP_RPC_URL, type PrivateRpc } from '../rpc'
import { bindEthersToPrivateRoute } from '../rpc/ethers-transport'
import { createBrowserArtifactStore } from './artifact-store'
import { checkSepoliaPoi, POI_NODE_URL } from './poi'

let startPromise: Promise<{ shieldFeeBasisPoints: bigint; unshieldFeeBasisPoints: bigint }> | undefined
const PROVIDER_TIMEOUT_MS = 60_000

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
  const [{ startRailgunEngine, loadProvider, getProver }, { NetworkName }, { groth16 }] = await Promise.all([
    import('@railgun-community/wallet'),
    import('@railgun-community/shared-models'),
    import('snarkjs'),
  ])
  const artifactStore = await createBrowserArtifactStore()
  await startRailgunEngine(
    '0xpay', new Level('0xpay-railgun-engine'), false, artifactStore,
    false, false, [POI_NODE_URL],
  )
  // The SDK's older declaration does not match snarkjs's optional-input declaration.
  getProver().setSnarkJSGroth16(groth16 as unknown as SnarkJSGroth16)
  const { feesSerialized } = await loadProvider({
    chainId: 11155111,
    providers: [{ provider: APP_RPC_URL, priority: 1, weight: 2 }],
  }, NetworkName.EthereumSepolia, PROVIDER_TIMEOUT_MS)
  return {
    shieldFeeBasisPoints: BigInt(feesSerialized.shieldFeeV2),
    unshieldFeeBasisPoints: BigInt(feesSerialized.unshieldFeeV2),
  }
}
