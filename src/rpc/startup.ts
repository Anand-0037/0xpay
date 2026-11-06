import type { PrivateRpc } from '../rpc.ts'

/** One bounded retry for a cold worker's read-only network health probe. */
export async function connectInitialPrivateRoute(route: PrivateRpc) {
  try { return await route.connect() }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    const stats = route.stats
    // No application/account reads or signed broadcasts happen before connect.
    // Wrong-chain/invalid RPC replies, worker bootstrap failure and user
    // disconnect/replacement are not retryable under this rule.
    if (route.status !== 'failed' || stats.attempted < 1 || stats.attempted > 2 ||
      stats.failed !== 1 || !/timed out|timeout/i.test(message)) throw error
    return route.reconnect()
  }
}
