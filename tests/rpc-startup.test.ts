import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateRpc } from '../src/rpc.ts'
import { connectInitialPrivateRoute } from '../src/rpc/startup.ts'
import { PRIVACY_NETWORKS } from '../src/rpc/networks.ts'

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

const lookup = { method: 'eth_call', params: [{ to: PRIVACY_NETWORKS.nox.specifier, data: '0x3898587d' }, 'latest'] }
const workerReply = (body: BodyInit | null | undefined) => {
  const request = JSON.parse(String(body))
  return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0xaa36a7' : '0x123' })
}

test('transient fixed bootstrap lookup retries once on the same URL before one worker connects', async () => {
  const original = globalThis.fetch; let direct = 0; let workers = 0
  globalThis.fetch = async (url, init) => {
    direct++
    assert.equal(String(url), PRIVACY_NETWORKS.nox.bootstrapRpc)
    const payload = JSON.parse(String(init?.body))
    assert.equal(payload.method, 'eth_call'); assert.deepEqual(payload.params, lookup.params)
    assert.equal(typeof payload.id, 'number'); assert.equal(init?.credentials, 'omit')
    if (direct === 1) throw new TypeError('Failed to fetch')
    return Response.json({ jsonrpc: '2.0', id: payload.id, result: `0x${'a'.repeat(64)}` })
  }
  const route = new PrivateRpc((_record, bootstrap) => {
    workers++
    return { ready: bootstrap(lookup), close() {}, async fetch(_url, init) { return workerReply(init.body) } }
  }, 'nox')
  try {
    await connectInitialPrivateRoute(route)
    assert.equal(route.status, 'ready'); assert.equal(workers, 1); assert.equal(direct, 2)
    assert.equal(route.stats.bootstrapReads, 1); assert.equal(route.stats.completed, 2)
  } finally { route.close(); globalThis.fetch = original }
})

test('bootstrap malformed JSON, RPC error, wrong id, malformed ABI and HTTP403 never retry', async () => {
  const original = globalThis.fetch
  try {
    for (const kind of ['json', 'rpc-error', 'id', 'abi', 'forbidden']) {
      let calls = 0; let workers = 0
      globalThis.fetch = async (_url, init) => {
        calls++; const payload = JSON.parse(String(init?.body))
        if (kind === 'json') return new Response('{')
        if (kind === 'forbidden') return new Response('', { status: 403 })
        return Response.json({ jsonrpc: '2.0', id: kind === 'id' ? payload.id + 1 : payload.id, result: kind === 'abi' ? '0x12' : `0x${'a'.repeat(64)}`, ...(kind === 'rpc-error' ? { error: { code: -32000, message: 'fixture unavailable' } } : {}) })
      }
      const route = new PrivateRpc((_record, bootstrap) => {
        workers++
        return { ready: bootstrap(lookup), close() {}, async fetch() { assert.fail('No worker request after invalid bootstrap') } }
      }, 'nox')
      try {
        await assert.rejects(connectInitialPrivateRoute(route), /Nox worker bootstrap/)
        assert.equal(calls, 1); assert.equal(workers, 1); assert.equal(route.stats.bootstrapReads, 0)
      } finally { route.close() }
    }
  } finally { globalThis.fetch = original }
})

test('two transient bootstrap failures stop without replacing the worker or changing endpoint', async () => {
  const original = globalThis.fetch; let calls = 0; let workers = 0
  globalThis.fetch = async (url) => { calls++; assert.equal(String(url), PRIVACY_NETWORKS.nox.bootstrapRpc); throw new TypeError('Failed to fetch') }
  const route = new PrivateRpc((_record, bootstrap) => {
    workers++
    return { ready: bootstrap(lookup), close() {}, async fetch() { assert.fail('No worker requests') } }
  }, 'nox')
  try {
    await assert.rejects(connectInitialPrivateRoute(route), /Nox worker bootstrap network request failed after two attempts/)
    assert.equal(calls, 2); assert.equal(workers, 1); assert.equal(route.status, 'failed')
  } finally { route.close(); globalThis.fetch = original }
})

test('disconnect during bootstrap aborts it and cannot retry or start a replacement worker', async () => {
  const original = globalThis.fetch; let calls = 0; let workers = 0; let release!: () => void
  globalThis.fetch = async (_url, init) => {
    calls++
    await new Promise<void>(resolve => { release = resolve })
    assert.equal(init?.signal?.aborted, true)
    throw new TypeError('Failed to fetch')
  }
  const route = new PrivateRpc((_record, bootstrap) => {
    workers++
    return { ready: bootstrap(lookup), close() {}, async fetch() { assert.fail('No worker requests after disconnect') } }
  }, 'nox')
  try {
    const connecting = connectInitialPrivateRoute(route)
    route.disconnect(); release()
    await assert.rejects(connecting, /bootstrap was cancelled/)
    assert.equal(calls, 1); assert.equal(workers, 1); assert.equal(route.status, 'degraded')
  } finally { route.close(); globalThis.fetch = original }
})

test('a replaced bootstrap response cannot increment bootstrap counts or alter the new route', async () => {
  const original = globalThis.fetch; let calls = 0; let release!: () => void
  globalThis.fetch = async (_url, init) => {
    const index = ++calls
    if (index === 1) await new Promise<void>(resolve => { release = resolve })
    const request = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: '2.0', id: request.id, result: `0x${'a'.repeat(64)}` })
  }
  const route = new PrivateRpc((_record, bootstrap) => ({ ready: bootstrap(lookup), close() {}, async fetch(_url, init) { return workerReply(init.body) } }), 'nox')
  try {
    const old = route.connect()
    await route.reconnect(); release()
    await assert.rejects(old, /bootstrap was cancelled/)
    assert.equal(route.status, 'ready'); assert.equal(route.stats.bootstrapReads, 1); assert.equal(calls, 2)
  } finally { route.close(); globalThis.fetch = original }
})
