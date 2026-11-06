import test from 'node:test'
import assert from 'node:assert/strict'
import { Mnemonic } from 'ethers'
import { requestPublicResearch, ResearchRequestError, type PublicResearchResult } from '../src/agents/research-client'

// Synthetic source and model-response fixtures only, never evidence of paid inference.
const market = { marketId: 'fixture-1', question: 'Synthetic resolution question?', outcomes: ['Yes', 'No'], selectedOutcome: 'Yes' }
const source = { id: 'S1', url: 'https://example.org/public-report', retrievedAt: Date.now(), text: 'A synthetic public source excerpt.' }
function result(): PublicResearchResult {
  return {
    mode: '0g-private-research', model: '0gm-1.0-35b-a3b',
    researcher: { summary: 'Fixture summary', thesis: 'Fixture thesis', estimatedProbabilityMicros: 600000, citations: ['S1'] },
    skeptic: { counterpoints: ['Fixture counterpoint'], resolutionAmbiguities: [], verdict: 'review', citations: ['S1'] },
    receipts: ['researcher', 'skeptic'].map(role => ({ role: role as 'researcher' | 'skeptic', requestId: `fixture-${role}-request`,
      responseKey: null, completionId: null, routerTeeVerified: null, verification: 'not-reported', independentVerification: false })),
    privacy: { providerTrustMode: 'private', proxySeesPlaintext: true },
  }
}
const response = (body: unknown): typeof fetch => async () => Response.json(body)
const hasCode = (code: ResearchRequestError['code']) => (cause: unknown) => cause instanceof ResearchRequestError && cause.code === code

test('client constructs the exact public payload and never serializes caller account, holdings or secret fields', async () => {
  const sensitive = 'DO_NOT_SEND_PRIVATE_SENTINEL'
  const mixedMarket = { ...market, account: sensitive, holdings: { balance: sensitive }, privateKey: sensitive, policy: { extra: sensitive } }
  const mixedSource = { ...source, walletAddress: sensitive, prompt: sensitive, metadata: { private: sensitive } }
  let requests = 0
  const received = await requestPublicResearch(mixedMarket, [mixedSource], { fetcher: async (url, init) => {
    requests++
    assert.equal(url, '/api/research')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.referrerPolicy, 'no-referrer')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.mode, 'same-origin')
    assert.equal(init?.cache, 'no-store')
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json', Accept: 'application/json' })
    assert.deepEqual(JSON.parse(String(init?.body)), { market, sources: [source] })
    assert.doesNotMatch(String(init?.body), /DO_NOT_SEND_PRIVATE_SENTINEL|holdings|privateKey|walletAddress|policy/)
    return Response.json(result())
  } })
  assert.equal(requests, 1)
  assert.equal(received.receipts.every(receipt => receipt.routerTeeVerified === null && receipt.verification === 'not-reported'), true)
  assert.equal(received.privacy.proxySeesPlaintext, true)
})

test('configuration 503 is surfaced without a fabricated model result or raw backend diagnostic disclosure', async () => {
  let calls = 0
  await assert.rejects(requestPublicResearch(market, [source], { fetcher: async () => {
    calls++
    return Response.json({ error: { code: 'NOT_CONFIGURED', message: 'PRIVATE_SERVER_DIAGNOSTIC' } }, { status: 503 })
  } }), cause => {
    assert.ok(cause instanceof ResearchRequestError)
    assert.equal(cause.code, 'unavailable'); assert.equal(cause.status, 503)
    assert.match(cause.message, /not configured.*No model result/)
    assert.doesNotMatch(cause.message, /PRIVATE_SERVER_DIAGNOSTIC/)
    return true
  })
  assert.equal(calls, 1, 'no alternative inference endpoint is attempted')
})

test('client distinguishes safe provider diagnostics from missing local configuration without rendering backend messages', async () => {
  for (const [code, status, phrase] of [['PROVIDER_AUTH', 401, /credential or access/],
    ['PROVIDER_CREDIT', 402, /credit is required/], ['PROVIDER_RATE_LIMIT', 429, /rate-limited/],
    ['PROVIDER_CAPACITY', 503, /could not serve/], ['PROVIDER_REQUEST', 400, /model request/],
    ['PROVIDER_NETWORK', null, /unreachable/], ['INVALID_RESPONSE', 200, /schema or verification/]] as const) {
    let calls = 0
    await assert.rejects(requestPublicResearch(market, [source], { fetcher: async () => {
      calls++
      return Response.json({ error: { code, message: 'PRIVATE_BACKEND_SENTINEL', diagnostics: { providerStatus: status, requestId: 'request-safe' } } }, { status: 503 })
    } }), error => {
      assert.ok(error instanceof ResearchRequestError)
      assert.equal(error.backendCode, code); assert.equal(error.providerStatus, status); assert.equal(error.requestId, 'request-safe')
      assert.match(error.message, phrase); assert.match(error.message, /Request request-safe/)
      if (status !== null) assert.match(error.message, new RegExp(`Provider HTTP ${status}`))
      assert.doesNotMatch(error.message, /PRIVATE_BACKEND_SENTINEL|not configured/)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('client never displays invalid diagnostic identifiers, unknown codes or oversized error bodies', async () => {
  for (const diagnostics of [{ providerStatus: 999, requestId: 'sk-synthetic-secret-value' },
    { providerStatus: 401, requestId: `0x${'11'.repeat(20)}` }, { providerStatus: '401', requestId: 'request@example.org' }]) {
    await assert.rejects(requestPublicResearch(market, [source], { fetcher: async () => Response.json({
      error: { code: 'PROVIDER_AUTH', message: 'PRIVATE_BACKEND_SENTINEL', diagnostics },
    }, { status: 502 }) }), error => {
      assert.ok(error instanceof ResearchRequestError)
      assert.equal(error.requestId, null)
      assert.doesNotMatch(error.message, /sk-synthetic|0x111|request@example|PRIVATE_BACKEND_SENTINEL|999/)
      return true
    })
  }
  for (const body of [{ error: { code: 'PRIVATE_UNKNOWN_CODE', message: 'PRIVATE_BACKEND_SENTINEL' } },
    { error: { code: 'PROVIDER_AUTH', message: 'PRIVATE_BACKEND_SENTINEL'.repeat(1000) } }]) {
    await assert.rejects(requestPublicResearch(market, [source], { fetcher: async () => Response.json(body, { status: 503 }) }), error => {
      assert.ok(error instanceof ResearchRequestError)
      assert.equal(error.backendCode, null); assert.doesNotMatch(error.message, /PRIVATE_/)
      return true
    })
  }
})

for (const [label, mutate] of [
  ['unknown citation', (body: PublicResearchResult) => { body.researcher.citations = ['S2'] }],
  ['duplicate receipt role', (body: PublicResearchResult) => { (body.receipts as unknown[])[1] = body.receipts[0] }],
  ['unverified independent claim', (body: PublicResearchResult) => { Object.assign(body.receipts[0], { independentVerification: true }) }],
  ['failed verification', (body: PublicResearchResult) => { Object.assign(body.receipts[0], { routerTeeVerified: false, verification: 'router-reported' }) }],
  ['no request evidence', (body: PublicResearchResult) => { Object.assign(body.receipts[0], { requestId: null }) }],
  ['non-private provider tier', (body: PublicResearchResult) => { Object.assign(body.privacy, { providerTrustMode: 'standard' }) }],
  ['hidden proxy plaintext', (body: PublicResearchResult) => { Object.assign(body.privacy, { proxySeesPlaintext: false }) }],
  ['substituted model', (body: PublicResearchResult) => { Object.assign(body, { model: 'other-model' }) }],
  ['invalid probability', (body: PublicResearchResult) => { body.researcher.estimatedProbabilityMicros = 1000001 }],
] as const) {
  test(`client refuses ${label}`, async () => {
    const body = result(); mutate(body)
    await assert.rejects(requestPublicResearch(market, [source], { fetcher: response(body) }), hasCode('invalid-response'))
  })
}

test('router verification remains explicitly router-reported and never becomes independent verification', async () => {
  const body = result()
  body.receipts.forEach(receipt => Object.assign(receipt, { routerTeeVerified: true, verification: 'router-reported' }))
  const received = await requestPublicResearch(market, [source], { fetcher: response(body) })
  assert.equal(received.receipts.every(receipt => receipt.verification === 'router-reported' && receipt.independentVerification === false), true)
})

test('invalid private/local sources and excessive inputs stop before any request', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return Response.json(result()) }
  for (const url of ['http://example.org/report', 'https://localhost/report', 'https://127.0.0.1/report', 'https://192.168.1.2/report', 'https://user:pass@example.org/report']) {
    await assert.rejects(requestPublicResearch(market, [{ ...source, url }], { fetcher }), hasCode('invalid-input'))
  }
  await assert.rejects(requestPublicResearch(market, [{ ...source, text: 'x'.repeat(6001) }], { fetcher }), hasCode('invalid-input'))
  await assert.rejects(requestPublicResearch(market, [source, source], { fetcher }), hasCode('invalid-input'))
  await assert.rejects(requestPublicResearch({ ...market, selectedOutcome: 'Other' }, [source], { fetcher }), hasCode('invalid-input'))
  await assert.rejects(requestPublicResearch(market, [source], { fetcher, timeoutMs: 240001 }), hasCode('invalid-input'))
  assert.equal(calls, 0)
})

test('sensitive scalar values stop before the proxy receives any request', async () => {
  // Public deterministic fixtures, never a user's keys or recovery phrase.
  const phrase = Mnemonic.fromEntropy(`0x${'00'.repeat(16)}`).phrase
  const values = [`0x${'11'.repeat(20)}`, `0x${'22'.repeat(32)}`, phrase,
    'My holdings total 900 units.', 'Bearer synthetic-token', 'sk-synthetic-example-key']
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return Response.json(result()) }
  for (const value of values) {
    await assert.rejects(requestPublicResearch({ ...market, question: value }, [source], { fetcher }), hasCode('invalid-input'))
    await assert.rejects(requestPublicResearch(market, [{ ...source, text: value }], { fetcher }), hasCode('invalid-input'))
    await assert.rejects(requestPublicResearch({ ...market, outcomes: [value, 'No'], selectedOutcome: value }, [source], { fetcher }), hasCode('invalid-input'))
  }
  assert.equal(calls, 0)
})

test('percent-encoded account and recovery data in source URLs stop before any request', async () => {
  const address = `0x${'11'.repeat(20)}`
  const phrase = Mnemonic.fromEntropy(`0x${'00'.repeat(16)}`).phrase
  const encodedAddress = [...address].map(char => `%${char.charCodeAt(0).toString(16)}`).join('')
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return Response.json(result()) }
  for (const url of [`https://example.org/report?account=${encodedAddress}`,
    `https://example.org/${encodeURIComponent(phrase)}`, 'https://example.org/report?bad=%zz']) {
    await assert.rejects(requestPublicResearch(market, [{ ...source, url }], { fetcher }), hasCode('invalid-input'))
  }
  assert.equal(calls, 0)
})

test('generic public wallet discussion is accepted without treating it as private holdings', async () => {
  let calls = 0
  await requestPublicResearch(market, [{ ...source, text: 'Public wallet research describes transaction privacy trade-offs.' }], {
    fetcher: async () => { calls++; return Response.json(result()) },
  })
  assert.equal(calls, 1)
})

test('already-cancelled requests never reach the server', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(requestPublicResearch(market, [source], { signal: controller.signal,
    fetcher: async () => { calls++; return Response.json(result()) } }), hasCode('aborted'))
  assert.equal(calls, 0)
})

test('cancellation and timeout reject promptly even if a transport ignores abort', async () => {
  const controller = new AbortController()
  const hung: typeof fetch = async () => new Promise<Response>(() => {})
  const pending = requestPublicResearch(market, [source], { signal: controller.signal, fetcher: hung })
  controller.abort()
  await assert.rejects(pending, hasCode('aborted'))
  await assert.rejects(requestPublicResearch(market, [source], { timeoutMs: 10, fetcher: hung }), hasCode('timeout'))
})

test('response-stream stalls and oversized responses cannot bypass the request budget', async () => {
  let cancelled = false
  const hangingBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel() { cancelled = true } })
  await assert.rejects(requestPublicResearch(market, [source], { timeoutMs: 10, fetcher: async () => new Response(hangingBody,
    { headers: { 'content-type': 'application/json' } }) }), hasCode('timeout'))
  assert.equal(cancelled, true)
  await assert.rejects(requestPublicResearch(market, [source], { fetcher: async () => new Response('too large',
    { headers: { 'content-type': 'application/json', 'content-length': '160001' } }) }), hasCode('invalid-response'))
  await assert.rejects(requestPublicResearch(market, [source], { fetcher: async () => new Response('<html>not research</html>',
    { headers: { 'content-type': 'text/html' } }) }), hasCode('invalid-response'))
})
