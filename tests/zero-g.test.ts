import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runZeroGResearch, validatePublicResearchInput, ZERO_G_ENDPOINT, ZERO_G_MODEL, ZeroGError } from '../server/zero-g.ts'

const apiKey = 'sk-synthetic-server-only-fixture'
const input = () => ({ market: { marketId: '123', question: 'Will the public fixture resolve Yes?', outcomes: ['Yes', 'No'], selectedOutcome: 'Yes' }, sources: [{ id: 'S1', url: 'https://gamma-api.polymarket.com/markets/123', retrievedAt: Date.now(), text: 'Synthetic market rules, not independent reporting. The outcome resolves from the official published result.' }] })
const research = () => ({ summary: 'Only market rules are available.', thesis: null, estimatedProbabilityMicros: null, citations: ['S1'] })
const critique = () => ({ counterpoints: ['No independent reporting was supplied.'], resolutionAmbiguities: ['The publication time is uncertain.'], verdict: 'abstain', citations: ['S1'] })
function response(content: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return Response.json({ id: 'completion-fixture', choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], x_0g_trace: { request_id: 'request-fixture', tee_verified: true }, ...extra }, { headers })
}
function sequential(values: Response[]): typeof fetch {
  return async () => { const result = values.shift(); assert.ok(result, 'No unexpected third call'); return result }
}
function errorCode(code: string) { return (error: unknown) => error instanceof ZeroGError && error.code === code }

test('two genuine-shaped role calls pin private tier and return only observed identifiers', async () => {
  let calls = 0
  const mock: typeof fetch = async (url, init) => {
    calls++
    assert.equal(String(url), ZERO_G_ENDPOINT)
    assert.deepEqual(init?.headers, { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
      'X-0G-Provider-Trust-Mode': 'private', 'X-0G-Provider-Allow-Fallbacks': 'false' })
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, ZERO_G_MODEL); assert.equal(body.verify_tee, true); assert.equal(body.max_tokens, 700); assert.equal(body.stream, false)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    assert.deepEqual(Object.keys(body).sort(), ['model', 'messages', 'stream', 'max_tokens', 'verify_tee', 'response_format', 'chat_template_kwargs'].sort())
    assert.equal(body.messages.length, 2)
    const data = JSON.parse(body.messages[1].content)
    assert.equal(data.evidence.market.marketId, '123')
    assert.equal(data.researcher === undefined, calls === 1)
    return response(calls === 1 ? research() : critique(), { id: `completion-${calls}`, x_0g_trace: { request_id: `request-${calls}`, tee_verified: true } }, { 'zg-res-key': `response-${calls}` })
  }
  const result = await runZeroGResearch(input(), { apiKey }, mock)
  assert.equal(calls, 2)
  assert.deepEqual(result.privacy, { providerTrustMode: 'private', proxySeesPlaintext: true })
  assert.deepEqual(result.receipts.map(value => [value.role, value.requestId, value.responseKey, value.completionId, value.verification, value.independentVerification]), [['researcher', 'request-1', 'response-1', 'completion-1', 'router-reported', false], ['skeptic', 'request-2', 'response-2', 'completion-2', 'router-reported', false]])
  assert.equal(JSON.stringify(result).includes(apiKey), false)
})

test('missing configuration and empty sources never call the network', async () => {
  const never: typeof fetch = async () => { assert.fail('Network must not run') }
  await assert.rejects(runZeroGResearch(input(), {}, never), errorCode('NOT_CONFIGURED'))
  await assert.rejects(runZeroGResearch({ ...input(), sources: [] }, { apiKey }, never), errorCode('NO_SOURCES'))
  await assert.rejects(runZeroGResearch(input(), { apiKey, model: 'other' }, never), errorCode('NOT_CONFIGURED'))
  await assert.rejects(runZeroGResearch(input(), { apiKey, timeoutMs: 120001 }, never), errorCode('NOT_CONFIGURED'))
})

test('JSON request settings never make malformed content or tool actions acceptable', async () => {
  const messages = [
    { role: 'assistant', content: `\`\`\`json\n${JSON.stringify(research())}\n\`\`\`` },
    { role: 'assistant', content: `<think>synthetic reasoning</think>${JSON.stringify(research())}` },
    { role: 'assistant', content: JSON.stringify(research()), tool_calls: [{ id: 'fixture-tool', type: 'function', function: { name: 'place_order', arguments: '{}' } }] },
  ]
  for (const message of messages) {
    let calls = 0
    await assert.rejects(runZeroGResearch(input(), { apiKey }, async (_url, init) => {
      calls++
      const request = JSON.parse(String(init?.body))
      assert.deepEqual(request.response_format, { type: 'json_object' })
      assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false })
      return response(research(), { choices: [{ message, finish_reason: 'stop' }] })
    }), errorCode('INVALID_RESPONSE'))
    assert.equal(calls, 1, 'invalid researcher output must not start the skeptic')
  }
})

test('strict public input rejects account fields, addresses, private keys and actual mnemonic phrases', () => {
  const samples: unknown[] = [
    { ...input(), wallet: 'unrequested field' },
    { ...input(), market: { ...input().market, holdings: 5 } },
    { ...input(), sources: [{ ...input().sources[0], title: 'extra field' }] },
    ...[`0x${'a'.repeat(40)}`, `0x${'b'.repeat(64)}`, 'Bearer confidential-fixture', 'my wallet contains money', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'].map(text => ({ ...input(), sources: [{ ...input().sources[0], text }] }))
  ]
  for (const sample of samples) assert.throws(() => validatePublicResearchInput(sample), errorCode('INVALID_INPUT'))
})

test('source boundaries reject unsafe URLs, duplicates, too much input and future retrieval timestamps', () => {
  for (const url of ['http://news.example.org/story', 'https://127.0.0.1/story', 'https://[::1]/', 'https://localhost/', 'https://secret:password@news.example.org/', 'https://news.internal/story', 'https://127.0.0.1.nip.io/']) {
    assert.throws(() => validatePublicResearchInput({ ...input(), sources: [{ ...input().sources[0], url }] }), errorCode('INVALID_INPUT'))
  }
  assert.throws(() => validatePublicResearchInput({ ...input(), sources: [input().sources[0], input().sources[0]] }), errorCode('INVALID_INPUT'))
  assert.throws(() => validatePublicResearchInput({ ...input(), sources: [{ ...input().sources[0], retrievedAt: Date.now() + 60000 }] }), errorCode('INVALID_INPUT'))
  assert.throws(() => validatePublicResearchInput({ ...input(), sources: [{ ...input().sources[0], text: 'a'.repeat(6001) }] }), errorCode('INVALID_INPUT'))
  assert.throws(() => validatePublicResearchInput({ ...input(), sources: [1, 2, 3, 4].map(id => ({ ...input().sources[0], id: `S${id}`, text: 'a'.repeat(5000) })) }), errorCode('INVALID_INPUT'))
})

test('invented citations, action fields and malformed probability stop before skeptical inference', async () => {
  for (const bad of [{ ...research(), citations: ['S999'] }, { ...research(), order: { side: 'BUY' } }, { ...research(), estimatedProbabilityMicros: 0.5 }, { ...research(), summary: apiKey }]) {
    let calls = 0
    await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => { calls++; return response(bad) }), errorCode('INVALID_RESPONSE'))
    assert.equal(calls, 1)
  }
})

test('invalid skeptic output never becomes a deterministic trading instruction', async () => {
  await assert.rejects(runZeroGResearch(input(), { apiKey }, sequential([response(research()), response({ ...critique(), verdict: 'trade' })])), errorCode('INVALID_RESPONSE'))
})

test('explicit failed TEE verification rejects, absent verification stays unreported', async () => {
  await assert.rejects(runZeroGResearch(input(), { apiKey }, sequential([response(research(), { x_0g_trace: { tee_verified: false } })])), errorCode('INVALID_RESPONSE'))
  const result = await runZeroGResearch(input(), { apiKey }, sequential([response(research(), { x_0g_trace: undefined }), response(critique(), { x_0g_trace: undefined })]))
  assert.equal(result.receipts[0].routerTeeVerified, null)
  assert.equal(result.receipts[0].verification, 'not-reported')
  assert.equal(result.receipts[0].requestId, null)
  assert.equal(result.receipts[0].completionId, 'completion-fixture')
  await assert.rejects(runZeroGResearch(input(), { apiKey }, sequential([response(research(), { id: undefined, x_0g_trace: undefined })])), errorCode('INVALID_RESPONSE'))
})

test('private-tier provider failures do not downgrade, retry or echo error bodies', async () => {
  let calls = 0
  const mock: typeof fetch = async () => { calls++; return Response.json({ error: `no_provider_for_trust_mode ${apiKey}` }, { status: 503 }) }
  await assert.rejects(runZeroGResearch(input(), { apiKey }, mock), (error: unknown) => {
    assert.ok(error instanceof ZeroGError); assert.equal(error.code, 'PROVIDER_CAPACITY'); assert.equal(error.status, 503)
    assert.deepEqual(error.diagnostics, { providerStatus: 503, requestId: null })
    assert.equal(error.message.includes(apiKey), false); return true
  })
  assert.equal(calls, 1)
  await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => { throw new Error(`fetch ${apiKey}`) }), (error: unknown) => error instanceof ZeroGError && !error.message.includes(apiKey))
})

test('provider HTTP diagnostics distinguish finite failures without reading or echoing raw bodies', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [402, 'PROVIDER_CREDIT'],
    [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_CAPACITY'], [503, 'PROVIDER_CAPACITY'], [400, 'PROVIDER_REQUEST']] as const) {
    let calls = 0
    await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => {
      calls++
      return Response.json({ error: `${apiKey} PRIVATE_PROMPT_SENTINEL` }, { status, headers: { 'x-request-id': `request-${status}` } })
    }), error => {
      assert.ok(error instanceof ZeroGError)
      assert.equal(error.code, code)
      assert.deepEqual(error.diagnostics, { providerStatus: status, requestId: `request-${status}` })
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROMPT_SENTINEL|sk-synthetic/)
      assert.equal(error.message.includes(apiKey), false)
      return true
    })
    assert.equal(calls, 1, 'no retry, downgrade or skeptic call after failure')
  }
})

test('network and invalid-response diagnostics retain only observed status and safe request identifiers', async () => {
  await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => { throw new TypeError(`PRIVATE_PROMPT_SENTINEL ${apiKey}`) }), error => {
    assert.ok(error instanceof ZeroGError); assert.equal(error.code, 'PROVIDER_NETWORK')
    assert.deepEqual(error.diagnostics, { providerStatus: null, requestId: null })
    assert.doesNotMatch(error.message, /PRIVATE_PROMPT_SENTINEL|sk-synthetic/)
    return true
  })
  await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => response({ ...research(), citations: ['invented'] }, {}, { 'x-request-id': 'request-schema' })), error => {
    assert.ok(error instanceof ZeroGError); assert.equal(error.code, 'INVALID_RESPONSE')
    assert.deepEqual(error.diagnostics, { providerStatus: 200, requestId: 'request-schema' })
    return true
  })
  for (const unsafe of [apiKey, 'request@example.org', 'x'.repeat(129), `0x${'11'.repeat(20)}`]) {
    await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => Response.json({ error: apiKey }, { status: 401, headers: { 'x-request-id': unsafe } })), error => {
      assert.ok(error instanceof ZeroGError); assert.deepEqual(error.diagnostics, { providerStatus: 401, requestId: null })
      return true
    })
  }
})

test('bounded timeout works even when injected fetch ignores abort and no second request runs', async () => {
  let calls = 0; let observedSignal: AbortSignal | null | undefined
  const mock: typeof fetch = async (_url, init) => { calls++; observedSignal = init?.signal; return await new Promise<Response>(() => {}) }
  await assert.rejects(runZeroGResearch(input(), { apiKey, timeoutMs: 10 }, mock), errorCode('TIMEOUT'))
  assert.equal(calls, 1); assert.equal(observedSignal?.aborted, true)
})

test('external cancellation aborts before calls or during inference', async () => {
  const pre = new AbortController(); pre.abort()
  await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => { assert.fail('No call after abort') }, pre.signal), errorCode('ABORTED'))
  const running = new AbortController()
  const task = runZeroGResearch(input(), { apiKey }, async () => { running.abort(); return await new Promise<Response>(() => {}) }, running.signal)
  await assert.rejects(task, errorCode('ABORTED'))
})

test('oversized and truncated outputs are rejected, never treated as successful research', async () => {
  await assert.rejects(runZeroGResearch(input(), { apiKey }, sequential([response(research(), { choices: [{ message: { role: 'assistant', content: JSON.stringify(research()) }, finish_reason: 'length' }] })])), errorCode('INVALID_RESPONSE'))
  await assert.rejects(runZeroGResearch(input(), { apiKey }, async () => new Response('x'.repeat(70000))), errorCode('INVALID_RESPONSE'))
})

test('caller mutation cannot swap evidence or citation allowlist between role calls', async () => {
  const original = input(); let calls = 0
  const result = await runZeroGResearch(original, { apiKey }, async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body)); const evidence = JSON.parse(body.messages[1].content).evidence
    assert.equal(evidence.sources[0].id, 'S1')
    if (calls === 1) { original.sources[0].id = 'S999'; original.market.question = 'Changed after validation' }
    else assert.notEqual(evidence.market.question, original.market.question)
    return response(calls === 1 ? research() : critique())
  })
  assert.equal(result.skeptic.verdict, 'abstain')
})
