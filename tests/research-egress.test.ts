import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOutgoingRequest } from '../src/net/network-guard.ts'
import { isPublicResearchBody } from '../src/net/research-egress.ts'

const origin = 'https://wallet.example'
const payload = () => ({
  market: { marketId: 'test-market', question: 'Public fixture question?', outcomes: ['Yes', 'No'], selectedOutcome: 'Yes' },
  sources: [{ id: 'S1', url: 'https://example.org/report', retrievedAt: Date.now(), text: 'Public fixture source text.' }],
})
const classify = (path: string, method: string, body?: unknown, enabled = true) =>
  classifyOutgoingRequest(path, method, body, origin, new Set(), false, 'nox', enabled)

test('research service paths are opt-in and do not become an unrestricted same-origin API exception', () => {
  const body = JSON.stringify(payload())
  assert.equal(classify('/api/research', 'POST', body), 'research-api')
  assert.equal(classify('/api/status', 'GET'), 'research-api')
  assert.equal(classify('/api/research', 'POST', body, false), 'blocked')
  assert.equal(classify('/api/status', 'GET', undefined, false), 'blocked')
  for (const [path, method, content] of [
    ['/api/research', 'GET', undefined], ['/api/status', 'POST', body], ['/api/status', 'GET', body],
    ['/api/research?address=anything', 'POST', body], ['/api/status#private', 'GET', undefined],
    ['/api/rpc', 'POST', '{}'], ['/api/orders', 'GET', undefined], ['/api/research/', 'POST', body],
  ] as const) assert.equal(classify(path, method, content), 'blocked', `${method} ${path}`)
})

test('nested account data, extra fields and mistyped public fields fail before sending', () => {
  for (const mutate of [
    (value: ReturnType<typeof payload>) => Object.assign(value, { wallet: 'hidden' }),
    (value: ReturnType<typeof payload>) => Object.assign(value.market, { holdings: 'hidden' }),
    (value: ReturnType<typeof payload>) => Object.assign(value.sources[0], { account: 'hidden' }),
    (value: ReturnType<typeof payload>) => Object.assign(value.market, { question: { account: 'hidden' } }),
    (value: ReturnType<typeof payload>) => Object.assign(value.market, { outcomes: [{ account: 'hidden' }, 'No'] }),
    (value: ReturnType<typeof payload>) => Object.assign(value.sources[0], { text: { account: 'hidden' } }),
  ]) {
    const value = payload(); mutate(value)
    assert.equal(isPublicResearchBody(JSON.stringify(value)), false)
  }
})

test('decoded wallet addresses and credential-shaped text are rejected, including JSON escapes', () => {
  for (const sensitive of [
    `0x${'1'.repeat(40)}`, `0x${'1'.repeat(64)}`, '0zkPrivateFixtureAddress', 'Bearer PRIVATE_FIXTURE',
    'sk-private-fixture-secret', 'eyJfixture.part.signature',
  ]) {
    const value = payload(); value.sources[0].text = sensitive
    assert.equal(isPublicResearchBody(JSON.stringify(value)), false)
  }
  const encoded = JSON.stringify(payload()).replace('Public fixture source text.', `\\u0030x${'1'.repeat(40)}`)
  assert.equal(isPublicResearchBody(encoded), false)
  const encodedUrl = payload()
  encodedUrl.sources[0].url = `https://example.org/report?account=${Array.from(`0x${'1'.repeat(40)}`, char => `%${char.charCodeAt(0).toString(16)}`).join('')}`
  assert.equal(isPublicResearchBody(JSON.stringify(encodedUrl)), false)
})

test('public source bounds, unique IDs, outcome membership and HTTPS attribution are enforced', () => {
  assert.equal(isPublicResearchBody(JSON.stringify(payload())), true)
  const duplicate = payload(); duplicate.sources.push(duplicate.sources[0])
  assert.equal(isPublicResearchBody(JSON.stringify(duplicate)), false)
  const wrongOutcome = payload(); wrongOutcome.market.selectedOutcome = 'Other'
  assert.equal(isPublicResearchBody(JSON.stringify(wrongOutcome)), false)
  for (const url of ['http://example.org/report', 'https://user:secret@example.org/report', 'https://127.0.0.1/report', 'https://example.org/report#private']) {
    const value = payload(); value.sources[0].url = url
    assert.equal(isPublicResearchBody(JSON.stringify(value)), false)
  }
  const long = payload(); long.sources[0].text = 'x'.repeat(6001)
  assert.equal(isPublicResearchBody(JSON.stringify(long)), false)
  assert.equal(isPublicResearchBody('['), false)
  assert.equal(isPublicResearchBody({}), false)
})
