import { FetchRequest } from 'ethers'
import { APP_RPC_URL, type PrivateRpc } from '../rpc.ts'

let activeRoute: PrivateRpc | null = null
let healthOnly = false
let registered = false

function isBlockProbe(body: Uint8Array): boolean {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(body))
    const calls: unknown[] = Array.isArray(payload) ? payload : [payload]
    return calls.length > 0 && calls.every((call) => !!call && typeof call === 'object' &&
      Object.keys(call).length === 4 && 'jsonrpc' in call && call.jsonrpc === '2.0' &&
      'id' in call && typeof call.id === 'number' && Number.isSafeInteger(call.id) &&
      'method' in call && call.method === 'eth_blockNumber' && 'params' in call &&
      Array.isArray(call.params) && call.params.length === 0)
  } catch { return false }
}

/** Ethers creates new providers inside Railgun. Register before loading any SDK provider. */
export function bindEthersToPrivateRoute(route: PrivateRpc, options: { healthOnly?: boolean } = {}) {
  if (!registered) {
    FetchRequest.registerGetUrl(async (request) => {
      if (request.url !== APP_RPC_URL || request.method !== 'POST' || request.body === null) {
        throw new Error('Ethers request outside the pinned private RPC route')
      }
      if (activeRoute?.status !== 'ready') throw new Error('Private RPC route is unavailable')
      if (healthOnly && !isBlockProbe(request.body)) throw new Error('Private connection check is not complete')
      const response = await activeRoute.fetchRpc(request.body)
      return {
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()),
      }
    })
    registered = true
  }
  activeRoute = route
  healthOnly = options.healthOnly ?? false
}

export function unbindEthersRoute(route: PrivateRpc) {
  if (activeRoute === route) { activeRoute = null; healthOnly = false }
}

export function assertPrivateRouteReady() {
  if (activeRoute?.status !== 'ready' || healthOnly) throw new Error('Private route is unavailable. Reconnect before reviewing or sending.')
}
