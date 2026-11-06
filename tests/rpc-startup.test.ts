import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateRpc } from '../src/rpc.ts'
import { connectInitialPrivateRoute } from '../src/rpc/startup.ts'

test('a cold first-read timeout gets one fresh private worker and preserves failed telemetry', async () => {
  let workers = 0
  let closed = 0
  let direct = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => { direct++; throw new Error('Direct request forbidden') }
  const route = new PrivateRpc(() => {
    const index = ++workers
    return { ready: Promise.resolve(), close() { closed++ }, async fetch(_url, init) {
      if (index === 1) throw new Error('operation timed out')
      const request = JSON.parse(await new Response(init.body).text())
      assert.ok(['eth_chainId', 'eth_blockNumber'].includes(request.method))
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0xaa36a7' : '0xabc123' })
    } }
  })
  try {
    assert.equal((await connectInitialPrivateRoute(route)).blockNumber, 11256099)
    assert.equal(workers, 2)
    assert.equal(closed, 1)
    assert.equal(route.stats.failed, 1)
    assert.equal(route.stats.completed, 2)
    assert.equal(route.stats.attempted, 3)
    assert.equal(direct, 0)
  } finally { route.close(); globalThis.fetch = original }
})

test('a second startup timeout stops, and wrong-chain responses never trigger a retry', async () => {
  let workers = 0
  const timeout = new PrivateRpc(() => {
    workers++
    return { ready: Promise.resolve(), close() {}, async fetch() { throw new Error('operation timed out') } }
  })
  try {
    await assert.rejects(connectInitialPrivateRoute(timeout), /timed out/)
    assert.equal(workers, 2)
    assert.equal(timeout.status, 'failed')
  } finally { timeout.close() }
  workers = 0
  const wrong = new PrivateRpc(() => {
    workers++
    return { ready: Promise.resolve(), close() {}, async fetch(_url, init) {
      const request = JSON.parse(await new Response(init.body).text())
      return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x1' })
    } }
  })
  try {
    await assert.rejects(connectInitialPrivateRoute(wrong), /Unexpected chain/)
    assert.equal(workers, 1)
  } finally { wrong.close() }
})
