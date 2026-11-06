export type PrivacyNetwork = 'nym' | 'nox'

export const APP_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
// Official Polygon public endpoint list. Agent mode is read-only; this is not
// a venue order transport or an extension of the Sepolia RAILGUN deployment.
// https://docs.polygon.technology/pos/reference/rpc-endpoints
export const AGENT_RPC_URL = 'https://polygon.publicnode.com'

// Published worker identities, not ordinary RPC fallback endpoints:
// https://ethereum.github.io/anon-rpc/adopters/
// https://ethereum.github.io/anon-rpc/demo/?worker=nox
export const PRIVACY_NETWORKS = {
  nym: { label: 'Nym', specifier: '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0', bootstrapRpc: 'https://ethereum-rpc.publicnode.com' },
  nox: { label: 'Nox', specifier: '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A', bootstrapRpc: APP_RPC_URL },
} as const

export function privacyNetworkFromSearch(search: string): PrivacyNetwork {
  return new URLSearchParams(search).get('network') === 'nym' ? 'nym' : 'nox'
}

const SELECTORS = new Set(['0x3898587d', '0x1c67ff29'])
type BootstrapParams = [{ to: string; data: string }, 'latest']

/** A fixed worker lookup must never carry an account, custom call field or extra argument. */
export function workerBootstrapParams(value: unknown, network: PrivacyNetwork): BootstrapParams | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 2 || !('method' in value) || value.method !== 'eth_call' ||
    !('params' in value) || !Array.isArray(value.params) || value.params.length !== 2 || value.params[1] !== 'latest') return null
  const call: unknown = value.params[0]
  if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).length !== 2 ||
    !('to' in call) || typeof call.to !== 'string' || call.to.toLowerCase() !== PRIVACY_NETWORKS[network].specifier.toLowerCase() ||
    !('data' in call) || typeof call.data !== 'string' || !SELECTORS.has(call.data)) return null
  // Reconstruct the call rather than forwarding the supplied object.
  return [{ to: PRIVACY_NETWORKS[network].specifier, data: call.data }, 'latest']
}
