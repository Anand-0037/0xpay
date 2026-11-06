import type { MethodCount } from '../rpc.ts'

const SUBMISSIONS = new Set(['eth_sendRawTransaction', 'eth_sendFrameTransaction'])
function add(total: MethodCount, entry: MethodCount): MethodCount {
  return { attempted: total.attempted + entry.attempted, completed: total.completed + entry.completed, failed: total.failed + entry.failed }
}
// Submissions are transport replies, not reads or proof of settlement.
export function rpcCallSummary(methods: Readonly<Record<string, MethodCount>>) {
  let reads: MethodCount = { attempted: 0, completed: 0, failed: 0 }
  let broadcasts: MethodCount = { attempted: 0, completed: 0, failed: 0 }
  for (const [method, count] of Object.entries(methods)) {
    if (SUBMISSIONS.has(method)) broadcasts = add(broadcasts, count)
    else if (method !== 'other') reads = add(reads, count)
  }
  return { reads, broadcasts }
}
