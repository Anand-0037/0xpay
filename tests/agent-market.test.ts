import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPublicMarketEvidence, loadMarkets, loadOrderBook, type MarketSummary } from '../src/agents/market.ts'

// Synthetic parser fixtures only. These are not live markets or API evidence.
const conditionId = `0x${'a'.repeat(64)}`
const market: MarketSummary = { id: '1001', version: 'v1', conditionId, question: 'Fixture question?', slug: 'fixture-question',
  endDate: null, outcomes: [{ tokenId: '101', name: 'Yes' }, { tokenId: '102', name: 'No' }], active: true, acceptingOrders: true }
const gamma = () => ({ id: market.id, version: 'v1', conditionId, question: market.question, slug: market.slug,
  endDate: null, outcomes: '["Yes","No"]', clobTokenIds: '["101","102"]', active: true, closed: false,
  acceptingOrders: true, enableOrderBook: true })
const book = () => ({ asset_id: '101', market: conditionId, timestamp: String(Date.now()), min_order_size: '5',
  asks: [{ price: '0.7', size: '10.000001' }, { price: '0.6', size: '2.50' }],
  bids: [{ price: '0.2', size: '9' }, { price: '0.4', size: '3' }] })
async function withFetch<T>(mock: typeof fetch, run: () => Promise<T>) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try { return await run() } finally { globalThis.fetch = original }
}
const returning = (value: unknown): typeof fetch => async () => Response.json(value)

test('markets use only documented direct public GET filters without credentials or bodies', async () => {
  await withFetch(async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://gamma-api.polymarket.com')
    assert.equal(url.pathname, '/markets')
    assert.deepEqual([...url.searchParams.entries()].sort(), [['active', 'true'], ['ascending', 'false'], ['closed', 'false'], ['limit', '20'], ['order', 'volume24hr'], ['version', 'v1']])
    assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error')
    assert.equal(init?.body, undefined)
    assert.deepEqual(init?.headers, { accept: 'application/json' })
    return Response.json([gamma()])
  }, async () => {
    const [loaded] = await loadMarkets()
    const { description, resolutionSource, retrievedAt, sourceUrl, sourceSha256, ...summary } = loaded
    assert.deepEqual(summary, market)
    assert.equal(description, null); assert.equal(resolutionSource, null)
    assert.equal(retrievedAt! > 0, true); assert.equal(new URL(sourceUrl!).pathname, '/markets')
    assert.match(sourceSha256!, /^[0-9a-f]{64}$/)
  })
})

test('empty catalog is an actual empty result, never populated with fixture markets', async () => {
  await withFetch(returning([]), async () => assert.deepEqual(await loadMarkets(), []))
})

test('book validates identity and preserves exact micro units while ordering best prices first', async () => {
  const response = book(), before = Date.now()
  await withFetch(async (input, init) => {
    assert.equal(String(input), 'https://clob.polymarket.com/book?token_id=101')
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined)
    return Response.json(response)
  }, async () => {
    const result = await loadOrderBook(market, 0)
    assert.equal(result.tokenId, '101'); assert.equal(result.outcome, 'Yes')
    assert.equal(result.sourceTimestamp, Number(response.timestamp))
    assert.ok(result.fetchedAt >= before && result.fetchedAt <= Date.now())
    assert.deepEqual(result.asks, [{ priceMicros: 600000, sizeMicros: 2500000 }, { priceMicros: 700000, sizeMicros: 10000001 }])
    assert.deepEqual(result.bids.map((row) => row.priceMicros), [400000, 200000])
    assert.equal(result.minOrderSizeMicros, 5000000)
  })
})

test('missing source time stays unknown rather than being replaced with fetch time', async () => {
  const response = { ...book(), timestamp: null }
  await withFetch(returning(response), async () => assert.equal((await loadOrderBook(market, 0)).sourceTimestamp, null))
})

test('ask-only book remains explicit and does not invent bids', async () => {
  await withFetch(returning({ ...book(), bids: [] }), async () => assert.deepEqual((await loadOrderBook(market, 0)).bids, []))
})

for (const [label, patch] of [
  ['v2', { version: 'v2' }], ['unsupported version', { version: 'v3' }],
  ['missing version', { version: undefined }], ['null version', { version: null }],
  ['duplicate tokens', { clobTokenIds: '["101","101"]' }], ['duplicate outcomes', { outcomes: '["Yes","Yes"]' }],
  ['wrong outcome length', { clobTokenIds: '["101"]' }], ['outcome JSON', { outcomes: 'not json' }],
  ['noncanonical token', { clobTokenIds: '["00101","102"]' }], ['oversized token', { clobTokenIds: `["${'9'.repeat(78)}","102"]` }],
  ['invalid condition', { conditionId: '0x1234' }], ['invalid boolean', { active: false, closed: 'false' }],
  ['invalid book flag', { acceptingOrders: false, enableOrderBook: 'false' }], ['invalid date', { endDate: 'invalid-date' }],
] as const) {
  test(`market metadata rejects ${label}`, async () => {
    await withFetch(returning([{ ...gamma(), ...patch }]), async () => assert.rejects(loadMarkets()))
  })
}

test('catalog skips duplicate market IDs but rejects excessive response rows', async () => {
  let skipped = 0
  await withFetch(returning([gamma(), gamma()]), async () => assert.equal((await loadMarkets(undefined, undefined, count => { skipped = count })).length, 1))
  assert.equal(skipped, 1)
  await withFetch(returning(Array.from({ length: 21 }, gamma)), async () => assert.rejects(loadMarkets(), /market list/))
})

for (const [label, patch] of [
  ['wrong token', { asset_id: '102' }], ['wrong condition', { market: `0x${'b'.repeat(64)}` }],
  ['stale source', { timestamp: String(Date.now() - 180000) }], ['future source', { timestamp: String(Date.now() + 60000) }],
  ['seconds mistaken for milliseconds', { timestamp: String(Math.floor(Date.now() / 1000)) }],
  ['empty asks', { asks: [] }], ['missing asks', { asks: undefined }],
  ['crossed book', { bids: [{ price: '0.8', size: '1' }] }],
  ['duplicate levels', { asks: [{ price: '0.5', size: '1' }, { price: '0.50', size: '2' }] }],
  ['too many levels', { asks: Array.from({ length: 2001 }, () => ({ price: '0.5', size: '1' })) }],
  ['zero minimum', { min_order_size: '0' }],
] as const) {
  test(`order book rejects ${label}`, async () => {
    await withFetch(returning({ ...book(), ...patch }), async () => assert.rejects(loadOrderBook(market, 0)))
  })
}

for (const price of ['01', '.5', '1.', '1e-1', '-0.5', ' 0.5', '0.0000001', '1.000001', '0', 0.5]) {
  test(`price does not round or coerce unsupported decimal ${String(price)}`, async () => {
    await withFetch(returning({ ...book(), asks: [{ price, size: '1' }] }), async () => assert.rejects(loadOrderBook(market, 0)))
  })
}

for (const size of ['0', '-1', '0.0000001', '9007199254.740992', '1e3', 1]) {
  test(`size rejects unsupported decimal or unsafe units ${String(size)}`, async () => {
    await withFetch(returning({ ...book(), asks: [{ price: '0.6', size }] }), async () => assert.rejects(loadOrderBook(market, 0)))
  })
}

test('paused and invalid outcomes do not issue a venue request', async () => {
  let requests = 0
  await withFetch(async () => { requests++; throw new Error('No network expected') }, async () => {
    await assert.rejects(loadOrderBook({ ...market, active: false }, 0), /paused/)
    await assert.rejects(loadOrderBook({ ...market, acceptingOrders: false }, 0), /paused/)
    await assert.rejects(loadOrderBook(market, -1), /valid market outcome/)
    await assert.rejects(loadOrderBook(market, 0.5), /valid market outcome/)
    await assert.rejects(loadOrderBook(market, 2), /valid market outcome/)
    assert.equal(requests, 0)
  })
})

test('order-book entry point rejects v2 or unidentified markets before fetching', async () => {
  let requests = 0
  await withFetch(async () => { requests++; throw new Error('Unexpected request') }, async () => {
    for (const version of ['v2', undefined, null]) {
      await assert.rejects(loadOrderBook({ ...market, version } as MarketSummary, 0), /explicitly identified v1/)
    }
    assert.equal(requests, 0)
  })
})

test('pre-cancelled read never fetches and in-flight cancellation reaches fetch', async () => {
  const before = new AbortController(); before.abort()
  await withFetch(async () => { throw new Error('Unexpected network') }, async () => assert.rejects(loadMarkets(before.signal), { name: 'AbortError' }))
  const active = new AbortController()
  await withFetch(async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    queueMicrotask(() => active.abort())
  }), async () => assert.rejects(loadOrderBook(market, 0, active.signal), { name: 'AbortError' }))
})

test('venue timeout cancels a stalled request without issuing retries', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  await withFetch(async (_input, init) => new Promise((_resolve, reject) => {
    requests++
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }), async () => {
    const pending = loadMarkets()
    context.mock.timers.tick(15001)
    await assert.rejects(pending, { name: 'TimeoutError' })
    assert.equal(requests, 1)
  })
})

test('injected private transport gets sixty seconds rather than the direct fifteen-second limit', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, direct = 0
  let transportSignal: AbortSignal | undefined
  await withFetch(async () => { direct++; throw new Error('Unexpected direct fetch') }, async () => {
    const pending = loadMarkets(undefined, async (_url, signal) => new Promise<Response>((_resolve, reject) => {
      calls++; transportSignal = signal
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const rejected = assert.rejects(pending, { name: 'TimeoutError' })
    context.mock.timers.tick(15_001)
    assert.equal(transportSignal?.aborted, false)
    context.mock.timers.tick(44_999)
    await rejected
    assert.equal(calls, 1); assert.equal(direct, 0)
    assert.equal(transportSignal?.aborted, true)
  })
})

test('caller cancellation immediately reaches an injected private transport without retry', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = loadOrderBook(market, 0, controller.signal, async (_url, signal) => new Promise<Response>((_resolve, reject) => {
    calls++
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort(); await rejected
  assert.equal(calls, 1)
  await assert.rejects(loadMarkets(controller.signal, async () => { calls++; return Response.json([]) }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('blocked/missing venue responses remain errors without fallback', async () => {
  for (const status of [403, 451, 404, 500]) {
    let calls = 0
    await withFetch(async () => { calls++; return new Response('Unavailable', { status }) }, async () => {
      await assert.rejects(loadMarkets())
      assert.equal(calls, 1)
    })
  }
})

test('responses are bounded before JSON parsing and during streamed reads', async () => {
  await withFetch(async () => new Response('[]', { headers: { 'content-length': '2000001' } }), async () => assert.rejects(loadMarkets(), /too large/))
  await withFetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2000001)); controller.close() } })), async () => assert.rejects(loadMarkets(), /too large/))
  await withFetch(async () => new Response('{invalid'), async () => assert.rejects(loadMarkets()))
})

test('research evidence comes from retrieved metadata and book, not merely a linked reference URL', async () => {
  const reference = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
  const requests: string[] = []
  await withFetch(async (url) => {
    requests.push(String(url))
    return Response.json(String(url).includes('gamma-api') ? [{ ...gamma(), description: 'Fixture resolution rules.\nA second line.', resolutionSource: reference }] : book())
  }, async () => {
    const [loaded] = await loadMarkets(), snapshot = await loadOrderBook(loaded, 0)
    const sources = await buildPublicMarketEvidence(loaded, snapshot)
    assert.deepEqual(sources.map(source => source.id), ['S1', 'S2'])
    assert.match(sources[0].text, /Fixture resolution rules/)
    assert.ok(sources[0].text.includes(reference))
    assert.match(sources[0].text, /contents were NOT retrieved/)
    assert.match(sources[1].text, /PUBLIC VENUE ORDER-BOOK SNAPSHOT, not a trade or forecast/)
    assert.equal(sources[0].retrievedAt, loaded.retrievedAt)
    assert.equal(sources[1].retrievedAt, snapshot.fetchedAt)
    assert.deepEqual(sources.map(source => source.url), requests)
    assert.ok(requests.every(url => !url.includes('federalreserve.gov')))
    assert.ok(sources.every(source => Object.keys(source).sort().join(',') === 'id,retrievedAt,text,url'))
    await assert.rejects(buildPublicMarketEvidence({ ...loaded }, snapshot), /actually retrieved/)
    await assert.rejects(buildPublicMarketEvidence(loaded, { ...snapshot }), /actually retrieved/)
    snapshot.asks[0].priceMicros++
    await assert.rejects(buildPublicMarketEvidence(loaded, snapshot), /unchanged/)
  })
})

test('full bounded rules are split without silently dropping text or claiming independent sources', async () => {
  const rules = `${'r'.repeat(7990)}END_RULES`
  await withFetch(async url => Response.json(String(url).includes('gamma-api') ? [{ ...gamma(), description: rules }] : book()), async () => {
    const [loaded] = await loadMarkets(), snapshot = await loadOrderBook(loaded, 0)
    const sources = await buildPublicMarketEvidence(loaded, snapshot)
    assert.deepEqual(sources.map(source => source.id), ['S1', 'S2', 'S3'])
    assert.ok(sources.every(source => source.text.length <= 6000))
    assert.ok(sources[1].text.includes('END_RULES'))
    assert.ok(sources[0].text.includes('parts are not independent sources'))
    assert.equal(sources[0].url, sources[1].url)
  })
})

test('market metadata mutation invalidates evidence, and models cannot supply source records', async () => {
  await assert.rejects(buildPublicMarketEvidence(market, { market, outcome: 'Yes', tokenId: '101', fetchedAt: Date.now(),
    sourceTimestamp: Date.now(), asks: [{ priceMicros: 600000, sizeMicros: 1000000 }], bids: [], minOrderSizeMicros: 1000000 }), /actually retrieved/)
  await withFetch(async url => Response.json(String(url).includes('gamma-api') ? [gamma()] : book()), async () => {
    const [loaded] = await loadMarkets(), snapshot = await loadOrderBook(loaded, 0)
    loaded.description = 'Unretrieved model claim'
    await assert.rejects(buildPublicMarketEvidence(loaded, snapshot), /unchanged/)
  })
})

test('metadata supports only safe bounded public source references and descriptions', async () => {
  for (const resolutionSource of ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com', 'plain source name']) {
    await withFetch(returning([{ ...gamma(), resolutionSource }]), async () => assert.equal((await loadMarkets())[0].resolutionSource, null))
  }
  const invalidDescription = (error: unknown) => error instanceof Error && /invalid or unsupported/.test(error.message) &&
    error.cause instanceof Error && /description/.test(error.cause.message)
  await withFetch(returning([{ ...gamma(), description: 'x'.repeat(8001) }]), async () => assert.rejects(loadMarkets(), invalidDescription))
  await withFetch(returning([{ ...gamma(), description: 'bad\u0000rules' }]), async () => assert.rejects(loadMarkets(), invalidDescription))
})
