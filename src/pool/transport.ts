import type { PrivateRpc } from '../rpc.ts'
import { APP_RPC_URL, LOCAL_RPC_URL, MEMPOOL_RPC_URL, LOCAL_MEMPOOL_URL } from '../rpc/networks.ts'
import type { RpcTransport } from './index.ts'

/** Every application JSON-RPC request passes through the selected Anon-RPC worker. */
export function privateTransport(route: PrivateRpc): RpcTransport {
  return async (url, body) => {
    const allowed = route.chain === 'local' ? [LOCAL_RPC_URL, LOCAL_MEMPOOL_URL] : [APP_RPC_URL, MEMPOOL_RPC_URL, 'https://altmempool.forshtat.com/rpc']
    if (!allowed.includes(url)) throw new Error(`Unsupported RPC destination: ${url}`)
    const response = await route.fetchRpc(JSON.stringify(body), url)
    return response.json()
  }
}
