import test from 'node:test'
import assert from 'node:assert/strict'
import { rpcCallSummary } from '../src/ui/rpc-metrics.ts'

test('frame and legacy submissions never inflate routed-read counts', () => {
  const summary = rpcCallSummary({
    eth_getBalance: { attempted: 4, completed: 3, failed: 1 },
    eth_sendRawTransaction: { attempted: 1, completed: 0, failed: 1 },
    eth_sendFrameTransaction: { attempted: 2, completed: 1, failed: 0 },
    other: { attempted: 5, completed: 5, failed: 0 },
  })
  assert.deepEqual(summary.reads, { attempted: 4, completed: 3, failed: 1 })
  assert.deepEqual(summary.broadcasts, { attempted: 3, completed: 1, failed: 1 })
  assert.deepEqual(rpcCallSummary({}).reads, { attempted: 0, completed: 0, failed: 0 })
})
