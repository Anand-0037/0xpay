import { FetchRequest } from 'ethers'
import { APP_RPC_URL, type PrivateRpc } from '../rpc.ts'

let activeRoute: PrivateRpc | null = null
let registered = false

/** Ethers creates new providers inside Railgun. Register before loading any SDK provider. */
export function bindEthersToPrivateRoute(route: PrivateRpc) {
  if (!registered) {
    FetchRequest.registerGetUrl(async (request) => {
      if (request.url !== APP_RPC_URL || request.method !== 'POST' || request.body === null) {
        throw new Error('Ethers request outside the pinned private RPC route')
      }
      if (!activeRoute) throw new Error('Private RPC route is unavailable')
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
}

export function unbindEthersRoute(route: PrivateRpc) {
  if (activeRoute === route) activeRoute = null
}

export function assertPrivateRouteReady() {
  if (activeRoute?.status !== 'ready') throw new Error('Private route is unavailable. Reconnect before reviewing or sending.')
}
