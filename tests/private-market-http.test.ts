import test from 'node:test'
import assert from 'node:assert/strict'
import { PrivateRpc } from '../src/rpc.ts'
import { loadMarkets, loadOrderBook } from '../src/agents/market.ts'

// Synthetic transport/parser fixtures, not evidence of live venue access.
const catalog = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&order=volume24hr&ascending=false&version=v1'
const bookUrl = 'https://clob.polymarket.com/book?token_id=101'
const conditionId = `0x${'a'.repeat(64)}`
const gamma = { id: '1001', version: 'v1', conditionId, question: 'Fixture question?', slug: 'fixture-question',
  endDate: null, outcomes: '["Yes","No"]', clobTokenIds: '["101","102"]', active: true, closed: false,
  acceptingOrders: true, enableOrderBook: true }
const book = () => ({ asset_id: '101', market: conditionId, timestamp: String(Date.now()), min_order_size: '5',
  asks: [{ price: '0.7', size: '10' }], bids: [{ price: '0.6', size: '9' }] })
function routeWith(onMarket: (url: string, init: RequestInit, worker: number) => Promise<Response> | Response) {
  let workers = 0
  return new PrivateRpc(() => {
    const worker = ++workers
    return { ready: Promise.resolve(), close() {}, async fetch(url: string, init: RequestInit) {
      if (init.method === 'POST') {
        const request = JSON.parse(String(init.body))
        return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x89' : '0x123' })
      }
      return onMarket(url, init, worker)
    } }
  }, 'nox', 'polygon-readonly')
}
async function noDirect<T>(run: () => Promise<T>) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('Direct transport forbidden in this test') }
  try { const result = await run(); assert.equal(calls, 0); return result }
  finally { globalThis.fetch = original }
}

test('public market GETs use the same worker without credentials and keep HTTP counters separate', async () => noDirect(async () => {
  const sent: string[] = []
  const route = routeWith((url, init) => {
    sent.push(url)
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined)
    assert.deepEqual(init.headers, { accept: 'application/json' })
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error')
    assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.cache, 'no-store')
    return Response.json({ public: true })
  })
  try {
    await route.connect()
    const rpcBefore = route.stats
    assert.deepEqual(await (await route.fetchPublicMarket(catalog)).json(), { public: true })
    const snapshot = route.stats
    await route.fetchPublicMarket(bookUrl)
    assert.deepEqual(sent, [catalog, bookUrl])
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 2, completed: 2, failed: 0 })
    assert.deepEqual(snapshot.publicMarketCounts, { attempted: 1, completed: 1, failed: 0 })
    assert.equal(route.stats.attempted, rpcBefore.attempted)
    assert.deepEqual(route.stats.methodCounts, rpcBefore.methodCounts)
    assert.equal(JSON.stringify(route.stats).includes('token_id'), false)
  } finally { route.close() }
}))

test('unknown URLs, account queries, orders and credentials fail before reaching the worker', async () => {
  let requests = 0
  const route = routeWith(() => { requests++; return Response.json([]) })
  try {
    await route.connect()
    for (const url of ['https://polygon.publicnode.com', `${catalog}&account=0x1111111111111111111111111111111111111111`,
      'https://clob.polymarket.com/order', `${bookUrl}&token_id=102`, 'https://clob.polymarket.com/book?token_id=0',
      'https://user:password@clob.polymarket.com/book?token_id=101', bookUrl.replace('https:', 'http:'),
      `${bookUrl}#account`, 'http://localhost:4202/api/research', '/api/research', 'not-a-url']) {
      await assert.rejects(route.fetchPublicMarket(url), /Unsupported public market/)
    }
    assert.equal(requests, 0)
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 0, completed: 0, failed: 0 })
  } finally { route.close() }
})

test('connecting, disconnected, closed and already-aborted requests never reach market transport', async () => {
  let requests = 0
  const route = routeWith(() => { requests++; return Response.json([]) })
  await assert.rejects(route.fetchPublicMarket(catalog), /needs reconnecting/)
  await route.connect()
  const controller = new AbortController(); controller.abort()
  await assert.rejects(route.fetchPublicMarket(catalog, controller.signal), { name: 'AbortError' })
  route.disconnect()
  await assert.rejects(route.fetchPublicMarket(catalog), /needs reconnecting/)
  route.close()
  await assert.rejects(route.fetchPublicMarket(catalog), /needs reconnecting/)
  assert.equal(requests, 0)
  assert.deepEqual(route.stats.publicMarketCounts, { attempted: 0, completed: 0, failed: 0 })
})

test('venue HTTP rejection is counted as failed and is not RPC failure or a successful market response', async () => noDirect(async () => {
  let calls = 0
  const route = routeWith(() => ++calls === 1 ? new Response('venue refuses access', { status: 451 }) : Response.json([]))
  try {
    await route.connect()
    const rpcBefore = route.stats
    const rejected = await route.fetchPublicMarket(catalog)
    assert.equal(rejected.status, 451); assert.equal(route.status, 'ready')
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 1, completed: 0, failed: 1 })
    await route.fetchPublicMarket(catalog)
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 2, completed: 1, failed: 1 })
    assert.equal(route.stats.failed, rpcBefore.failed)
  } finally { route.close() }
}))

test('worker failure blocks subsequent market requests until reconnect, without direct retry', async () => noDirect(async () => {
  const route = routeWith((_url, _init, worker) => {
    if (worker === 1) throw new Error('mixnet unavailable')
    return Response.json([])
  })
  try {
    await route.connect()
    await assert.rejects(route.fetchPublicMarket(catalog), /mixnet unavailable/)
    assert.equal(route.status, 'degraded')
    await assert.rejects(route.fetchPublicMarket(catalog), /needs reconnecting/)
    await route.reconnect()
    assert.deepEqual(await (await route.fetchPublicMarket(catalog)).json(), [])
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 2, completed: 1, failed: 1 })
  } finally { route.close() }
}))

test('caller cancellation rejects promptly even if the worker ignores abort, without degrading RPC', async () => {
  let release: (response: Response) => void = () => {}
  const delayed = new Promise<Response>(resolve => { release = resolve })
  const route = routeWith(() => delayed)
  try {
    await route.connect()
    const controller = new AbortController()
    const pending = route.fetchPublicMarket(catalog, controller.signal)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    controller.abort(); await rejected
    assert.equal(route.status, 'ready')
    release(Response.json([])); await Promise.resolve()
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 1, completed: 0, failed: 1 })
  } finally { release(Response.json([])); route.close() }
})

test('reconnect invalidates in-flight results and old replies cannot update the replacement route', async () => {
  let release: (response: Response) => void = () => {}
  const delayed = new Promise<Response>(resolve => { release = resolve })
  const route = routeWith((_url, _init, worker) => worker === 1 ? delayed : Response.json({ fresh: true }))
  try {
    await route.connect()
    const stale = route.fetchPublicMarket(catalog)
    const rejected = assert.rejects(stale, /disconnected or replaced/)
    await route.reconnect(); await rejected
    release(Response.json({ stale: true })); await Promise.resolve()
    assert.equal(route.status, 'ready')
    assert.deepEqual(await (await route.fetchPublicMarket(catalog)).json(), { fresh: true })
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 2, completed: 1, failed: 1 })
  } finally { release(Response.json([])); route.close() }
})

test('a concurrent RPC failure invalidates a late public market response', async () => {
  let release: (response: Response) => void = () => {}
  const delayed = new Promise<Response>(resolve => { release = resolve })
  let failRpc = false
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {}, async fetch(_url, init) {
    if (init.method === 'GET') return delayed
    if (failRpc) throw new Error('worker lost')
    const request = JSON.parse(String(init.body))
    return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x89' : '0x123' })
  } }), 'nox', 'polygon-readonly')
  try {
    await route.connect()
    const pending = route.fetchPublicMarket(catalog)
    failRpc = true
    await assert.rejects(route.fetchRpc('{"method":"eth_call"}'), /worker lost/)
    const rejected = assert.rejects(pending, /replaced or stopped route/)
    release(Response.json([])); await rejected
    assert.equal(route.status, 'degraded')
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 1, completed: 0, failed: 1 })
  } finally { release(Response.json([])); route.close() }
})

test('closing promptly cancels pending HTTP without allowing a late success', async () => {
  const route = routeWith(() => new Promise<Response>(() => {}))
  await route.connect()
  const pending = route.fetchPublicMarket(catalog)
  const rejected = assert.rejects(pending, /disconnected or replaced/)
  route.close(); await rejected
  assert.equal(route.status, 'closed')
  assert.deepEqual(route.stats.publicMarketCounts, { attempted: 1, completed: 0, failed: 1 })
})

test('bounded market timeout degrades the route even when the worker never settles', async context => {
  const route = routeWith(() => new Promise<Response>(() => {}))
  try {
    await route.connect()
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const rejected = assert.rejects(route.fetchPublicMarket(catalog), /timed out/)
    context.mock.timers.tick(60_001); await rejected
    assert.equal(route.status, 'degraded')
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 1, completed: 0, failed: 1 })
  } finally { context.mock.timers.reset(); route.close() }
})

test('declared and streamed oversized responses are rejected without invalidating RPC health', async () => {
  for (const response of [
    () => new Response('too large', { headers: { 'content-length': '2000001' } }),
    () => new Response('malformed length', { headers: { 'content-length': '1e9' } }),
    () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); controller.close() } })),
  ]) {
    const route = routeWith(response)
    try {
      await route.connect()
      await assert.rejects(route.fetchPublicMarket(catalog), /too large/)
      assert.equal(route.status, 'ready')
      assert.deepEqual(route.stats.publicMarketCounts, { attempted: 1, completed: 0, failed: 1 })
    } finally { route.close() }
  }
})

test('a stalled response body is cancelled without publishing partial success', async () => {
  let cancelled = false
  const route = routeWith(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('[')) }, cancel() { cancelled = true },
  })))
  try {
    await route.connect()
    const controller = new AbortController()
    const pending = route.fetchPublicMarket(catalog, controller.signal)
    await Promise.resolve(); await Promise.resolve()
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    controller.abort(); await rejected; await Promise.resolve()
    assert.equal(cancelled, true)
    assert.equal(route.status, 'ready')
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 1, completed: 0, failed: 1 })
  } finally { route.close() }
})

test('unexpected redirect or final URL is rejected before exposing the body', async () => {
  for (const property of [{ redirected: true }, { url: 'https://clob.polymarket.com/order' }]) {
    const route = routeWith(() => {
      const response = Response.json([])
      for (const [key, value] of Object.entries(property)) Object.defineProperty(response, key, { value })
      return response
    })
    try {
      await route.connect()
      await assert.rejects(route.fetchPublicMarket(catalog), /redirects/)
      assert.equal(route.status, 'ready')
    } finally { route.close() }
  }
})

test('market adapters explicitly consume the injected worker transport and retain strict parsing', async () => noDirect(async () => {
  const route = routeWith(url => Response.json(url === catalog ? [gamma] : book()))
  try {
    await route.connect()
    const fetcher = (url: string, signal?: AbortSignal) => route.fetchPublicMarket(url, signal)
    const [market] = await loadMarkets(undefined, fetcher)
    const snapshot = await loadOrderBook(market, 0, undefined, fetcher)
    assert.equal(snapshot.tokenId, '101'); assert.equal(snapshot.asks[0].priceMicros, 700_000)
    assert.deepEqual(route.stats.publicMarketCounts, { attempted: 2, completed: 2, failed: 0 })
    assert.equal(route.stats.attempted, 2, 'only connect chain and block are blockchain RPC requests')
  } finally { route.close() }
}))

test('adapter injection failure never falls back to direct venue fetch', async () => noDirect(async () => {
  await assert.rejects(loadMarkets(undefined, async () => { throw new Error('private venue unavailable') }), /private venue unavailable/)
}))
