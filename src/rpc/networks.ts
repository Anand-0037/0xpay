export type PrivacyNetwork = 'nym' | 'nox'
export type ChainNetwork = 'devnet' | 'local'
export const APP_RPC_URL = 'https://altmempool.forshtat.com'
export const MEMPOOL_RPC_URL = 'https://altmempool.forshtat.com/rpc'
export const LOCAL_RPC_URL = import.meta.env?.VITE_LOCAL_RPC_URL || 'http://127.0.0.1:10545'
export const LOCAL_MEMPOOL_URL = import.meta.env?.VITE_LOCAL_MEMPOOL_URL || 'http://127.0.0.1:13000/rpc'
export const PRIVACY_NETWORKS = {
  nym: { label: 'Nym', specifier: '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0', bootstrapRpc: 'https://ethereum-rpc.publicnode.com' },
  nox: { label: 'Nox', specifier: '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A', bootstrapRpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
} as const
export function privacyNetworkFromSearch(search: string): PrivacyNetwork { return new URLSearchParams(search).get('network') === 'nym' ? 'nym' : 'nox' }
// A remote anonymizing worker cannot reach a browser user's loopback sidecar.
// Local protocol testing uses the CLI; URL parameters must not target loopback.
export function chainNetworkFromSearch(_search: string): ChainNetwork { return 'devnet' }
const SELECTORS = new Set(['0x3898587d', '0x1c67ff29'])
type BootstrapParams = [{ to: string; data: string }, 'latest']
export function workerBootstrapParams(value: unknown, network: PrivacyNetwork): BootstrapParams | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !('method' in value) || value.method !== 'eth_call' || !('params' in value) || !Array.isArray(value.params) || value.params.length !== 2 || value.params[1] !== 'latest') return null
  const call: unknown = value.params[0]
  if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).length !== 2 || !('to' in call) || typeof call.to !== 'string' || call.to.toLowerCase() !== PRIVACY_NETWORKS[network].specifier.toLowerCase() || !('data' in call) || typeof call.data !== 'string' || !SELECTORS.has(call.data)) return null
  return [{ to: PRIVACY_NETWORKS[network].specifier, data: call.data }, 'latest']
}
