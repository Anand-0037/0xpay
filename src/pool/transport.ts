import type { PrivateRpc } from '../rpc.ts'
import { APP_RPC_URL, LOCAL_RPC_URL, MEMPOOL_RPC_URL, LOCAL_MEMPOOL_URL } from '../rpc/networks.ts'
import type { RpcTransport } from './index.ts'

// The Nym exit currently drops Content-Type on requests to the alt-mempool
// sidecar (/rpc), which responds 415. Standard chain reads work at the devnet
// root instead. Keep writes and sidecar-specific methods at their own endpoint.
const ROOT_READ_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
  'eth_getLogs',
  'eth_call',
])

function targetFor(route: PrivateRpc, url: string, body: unknown): string {
  if (route.chain !== 'devnet' || route.network !== 'nym' || url !== MEMPOOL_RPC_URL) return url
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('method' in body)) return url
  return typeof body.method === 'string' && ROOT_READ_METHODS.has(body.method) ? APP_RPC_URL : url
}

/** Every application JSON-RPC request passes through the selected Anon-RPC worker. */
export function privateTransport(route: PrivateRpc): RpcTransport {
  return async (url, body) => {
    const allowed = route.chain === 'local' ? [LOCAL_RPC_URL, LOCAL_MEMPOOL_URL] : [APP_RPC_URL, MEMPOOL_RPC_URL, 'https://altmempool.forshtat.com/rpc']
    if (!allowed.includes(url)) throw new Error(`Unsupported RPC destination: ${url}`)
    const response = await route.fetchRpc(JSON.stringify(body), targetFor(route, url, body))
    return response.json()
  }
}
