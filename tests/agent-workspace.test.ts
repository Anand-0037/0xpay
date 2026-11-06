import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { AgentWorkspace } from '../src/agents/AgentWorkspace'
import type { PublicResearchResult } from '../src/agents/research-client'

// Synthetic venue parser input for UI state tests; not a live market or API proof.
const fixtureMarket = {
  id: '1001', version: 'v1', conditionId: `0x${'a'.repeat(64)}`, question: 'Synthetic test market?',
  slug: 'synthetic-test-market', endDate: null, outcomes: '["Yes","No"]', clobTokenIds: '["101","102"]',
  active: true, closed: false, acceptingOrders: true, enableOrderBook: true,
}
function fixtureRoute(venue: (url: string, signal?: AbortSignal) => Promise<Response>) {
  return { status: 'ready' as 'ready' | 'degraded' | 'failed' | 'closed' | 'connecting', fetchPublicMarket: venue,
    async fetchRpc(body: string | Uint8Array) {
      const calls = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)) as { id: number; method: string }[]
      return Response.json(calls.map(call => {
        assert.ok(call.method === 'eth_chainId' || call.method === 'eth_blockNumber', 'this UI fixture does not inspect any watched wallet')
        return { jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? '0x89' : '0x1000' }
      }))
    } }
}

test('market search appears only after actual data; failed and empty requests support a real retry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?view=agents' })
  const names = ['window', 'document'] as const
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  names.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }))
  const originalFetch = globalThis.fetch
  const root = createRoot(dom.window.document.getElementById('root')!)
  let attempts = 0
  let failFirst!: (cause: Error) => void
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/status') return Response.json({ status: 'ok', provider: '0g', configured: false, providerTrustMode: 'private', proxySeesPlaintext: true, jobsRemaining: 5, jobLimit: 5 })
    throw new Error('Direct public market fetch is forbidden')
  }
  const route = fixtureRoute(async input => {
    const url = new URL(input)
    assert.equal(url.hostname, 'gamma-api.polymarket.com')
    attempts++
    if (attempts === 1) return new Promise<Response>((_, reject) => { failFirst = reject })
    return Response.json(attempts === 2 ? [] : [fixtureMarket])
  })
  const pause = () => new Promise(resolve => setTimeout(resolve, 40))
  const document = dom.window.document
  try {
    flushSync(() => root.render(createElement(AgentWorkspace, { route: null, routeGeneration: -1, onReconnect() {} })))
    assert.equal(document.querySelector('#agent-search'), null)
    assert.match(document.body.textContent!, /Waiting for the private route before retrieving/)
    assert.equal(attempts, 0)
    flushSync(() => root.render(createElement(AgentWorkspace, { route, routeGeneration: 1, onReconnect() {} })))
    assert.match(document.body.textContent!, /Fetching the market catalogue/)
    assert.match(document.querySelector('#agent-runner-title')!.textContent!, /^Agent activity$/)
    assert.doesNotMatch(document.body.textContent!, /on a leash|Live venue data/)
    await pause()
    assert.match(document.querySelector('.agent-model-status')!.textContent!, /0G Private Computer is not configured/)
    assert.equal([...document.querySelectorAll('.agent-model-roles>div>span:last-child')].every(node => node.textContent === 'NOT RUN'), true)

    failFirst(new Error('Synthetic venue timeout'))
    await pause()
    assert.equal(document.querySelector('#agent-search'), null)
    assert.match(document.querySelector('.agent-market-error[role="alert"]')!.textContent!, /Market data is unavailable/)
    assert.match(document.querySelector('.agent-topline')!.textContent!, /Venue data unavailable through worker/)
    assert.doesNotMatch(document.querySelector('.agent-topline')!.textContent!, /markets loaded/)
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry market data')!
    flushSync(() => retry.click())
    await pause()
    assert.equal(attempts, 2)
    assert.equal(document.querySelector('#agent-search'), null)
    assert.match(document.querySelector('.agent-empty')!.textContent!, /venue returned no open markets/)

    const refresh = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh')!
    flushSync(() => refresh.click())
    await pause()
    assert.equal(attempts, 3)
    assert.ok(document.querySelector('#agent-search'))
    assert.equal(document.querySelector('.agent-market-error'), null)
    assert.match(document.querySelector('.agent-market-list')!.textContent!, /Synthetic test market/)
    assert.match(document.querySelector('.agent-topline')!.textContent!, /1 market loaded through worker/)
    assert.equal(dom.window.location.search, '?view=agents')
    assert.equal(document.querySelectorAll('.agent-record').length, 0)
  } finally {
    flushSync(() => root.unmount())
    await pause()
    globalThis.fetch = originalFetch
    dom.window.close()
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
})

function fixtureResearch(): PublicResearchResult {
  return { mode: '0g-private-research', model: '0gm-1.0-35b-a3b',
    researcher: { summary: 'Synthetic researcher summary', thesis: 'Synthetic evidence-based thesis', estimatedProbabilityMicros: 610000, citations: ['S1'] },
    skeptic: { counterpoints: ['Synthetic counterpoint'], resolutionAmbiguities: ['Synthetic ambiguity'], verdict: 'review', citations: ['S2'] },
    receipts: (['researcher', 'skeptic'] as const).map(role => ({ role, requestId: `fixture-${role}-request`, completionId: null, responseKey: null,
      routerTeeVerified: true, verification: 'router-reported', independentVerification: false })),
    privacy: { providerTrustMode: 'private', proxySeesPlaintext: true } }
}
async function researchEnvironment(reply: () => Promise<Response>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?view=agents' })
  const names = ['window', 'document'] as const
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)), originalFetch = globalThis.fetch
  names.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }))
  const root = createRoot(dom.window.document.getElementById('root')!)
  const payloads: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/status') return Response.json({ status: 'ok', provider: '0g', configured: true, providerTrustMode: 'private', proxySeesPlaintext: true, jobsRemaining: 5, jobLimit: 5 })
    if (url.pathname === '/api/research') { payloads.push(JSON.parse(String(init?.body))); return reply() }
    throw new Error(`Unexpected direct test endpoint: ${url.hostname}`)
  }
  const venueCalls: string[] = []
  const route = fixtureRoute(async input => {
    venueCalls.push(input)
    const url = new URL(input)
    if (url.hostname === 'gamma-api.polymarket.com') return Response.json([fixtureMarket])
    if (url.hostname === 'clob.polymarket.com') return Response.json({ asset_id: url.searchParams.get('token_id'), market: fixtureMarket.conditionId,
      timestamp: String(Date.now()), min_order_size: '1', asks: [{ price: '0.55', size: '100' }], bids: [{ price: '0.54', size: '100' }] })
    throw new Error(`Unexpected test endpoint: ${url.hostname}`)
  })
  const document = dom.window.document
  const pause = () => new Promise(resolve => setTimeout(resolve, 35))
  const until = async (condition: () => boolean) => {
    for (let count = 0; count < 60 && !condition(); count++) await pause()
    assert.equal(condition(), true, 'expected UI state did not arrive')
  }
  flushSync(() => root.render(createElement(AgentWorkspace, { route, routeGeneration: 1, onReconnect() {} })))
  await until(() => document.querySelector('.agent-market-list button') !== null)
  flushSync(() => document.querySelector<HTMLButtonElement>('.agent-market-list button')!.click())
  await until(() => document.querySelector('.agent-book-strip') !== null)
  return { dom, document, root, route, venueCalls, payloads, pause, until, async cleanup() {
    flushSync(() => root.unmount()); await pause(); globalThis.fetch = originalFetch; dom.window.close()
    names.forEach((name, index) => { if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!); else Reflect.deleteProperty(globalThis, name) })
  } }
}

test('public research runs without a watched wallet and adoption changes only thesis/probability after explicit review', async () => {
  const env = await researchEnvironment(async () => Response.json(fixtureResearch()))
  try {
    const { document, payloads, until } = env
    const limitsBefore = [...document.querySelectorAll<HTMLInputElement>('.agent-policy-details input')].map(input => input.value)
    const stakeBefore = document.querySelector<HTMLInputElement>('#agent-paper-stake')!.value
    const run = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Run 0G research')!
    assert.equal(run.disabled, false, 'public research does not need an account preflight')
    flushSync(() => run.click())
    await until(() => document.querySelector('.agent-research-output') !== null)
    const body = payloads[0] as { market: unknown; sources: { id: string }[] }
    assert.deepEqual(body.market, { marketId: '1001', question: fixtureMarket.question, outcomes: ['Yes', 'No'], selectedOutcome: 'Yes' })
    assert.deepEqual(Object.keys(body).sort(), ['market', 'sources'])
    assert.deepEqual(body.sources.map(source => source.id), ['S1', 'S2'])
    assert.doesNotMatch(JSON.stringify(body), /watchAddress|collateralBalance|outcomeBalance|sessionBudget|privateKey|riskLimits|maxExposure|maxOutcomeShares/)
    assert.match(document.querySelector('.agent-research-output')!.textContent!, /fixture-researcher-request/)
    assert.match(document.querySelector('.agent-research-output')!.textContent!, /proxy sees plaintext|proxy sees plaintext/i)
    assert.match(document.querySelector('.agent-research-output')!.textContent!, /not independently verified/)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.value, '', 'model output is not silently adopted')
    const adopt = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use this research for paper review')!
    flushSync(() => adopt.click())
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.value, '61')
    assert.equal(document.querySelector<HTMLTextAreaElement>('#agent-thesis')!.value, 'Synthetic evidence-based thesis')
    assert.equal(document.querySelector<HTMLInputElement>('#agent-paper-stake')!.value, stakeBefore)
    assert.deepEqual([...document.querySelectorAll<HTMLInputElement>('.agent-policy-details input')].map(input => input.value), limitsBefore)
    assert.equal(document.querySelectorAll('.agent-record').length, 0)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-watch-account')!.value, '')
    const originalSources = [...document.querySelectorAll<HTMLAnchorElement>('.agent-research-citations a')].map(link => link.href)
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh order book')!.click())
    await until(() => document.querySelector('.agent-book-strip') !== null)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.value, '61', 'repricing must not require a second paid research request')
    assert.deepEqual([...document.querySelectorAll<HTMLAnchorElement>('.agent-research-citations a')].map(link => link.href), originalSources, 'citations remain bound to their actual original source pack')
    assert.equal(payloads.length, 1)
  } finally { await env.cleanup() }
})

test('an abstaining skeptic cannot be adopted or become a model-driven paper proposal', async () => {
  const body = fixtureResearch(); body.skeptic.verdict = 'abstain'; body.researcher.estimatedProbabilityMicros = null; body.researcher.thesis = null
  const env = await researchEnvironment(async () => Response.json(body))
  try {
    const { document, until } = env
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Run 0G research')!.click())
    await until(() => document.querySelector('.agent-research-output') !== null)
    assert.match(document.querySelector('.agent-research-verdict')!.textContent!, /Abstain/)
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use this research for paper review')!.disabled, true)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.value, '')
    assert.equal(document.querySelectorAll('.agent-proposal').length, 0)
    assert.equal(document.querySelectorAll('.agent-record').length, 0)
    const manual = [...document.querySelectorAll<HTMLInputElement>('input[name="agent-proposal-mode"]')][1]
    flushSync(() => manual.click())
    assert.equal(manual.checked, true)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.readOnly, false)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.value, '', 'manual mode does not inherit an abstained estimate')
  } finally { await env.cleanup() }
})

test('a late research response cannot restore citations or estimates after the outcome changes', async () => {
  let release!: (value: Response) => void
  const env = await researchEnvironment(() => new Promise<Response>(resolve => { release = resolve }))
  try {
    const { document, payloads, until, pause } = env
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Run 0G research')!.click())
    await until(() => payloads.length === 1)
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('.agent-outcomes button')].find(button => button.textContent === 'No')!.click())
    const stale = fixtureResearch(); stale.researcher.summary = 'STALE_RESEARCH_MUST_NOT_APPEAR'
    release(Response.json(stale)); await pause()
    assert.equal(document.querySelector('.agent-research-output'), null)
    assert.equal(document.querySelector('.agent-research-citations'), null)
    assert.doesNotMatch(document.body.textContent!, /STALE_RESEARCH_MUST_NOT_APPEAR|fixture-researcher-request/)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.value, '')
  } finally { await env.cleanup() }
})

test('a configuration failure remains unavailable rather than fabricating research outputs', async () => {
  const env = await researchEnvironment(async () => Response.json({ error: { code: 'NOT_CONFIGURED', message: 'No server key' } }, { status: 503 }))
  try {
    const { document, until } = env
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Run 0G research')!.click())
    await until(() => document.querySelector('.agent-model-status [role="alert"]') !== null)
    assert.match(document.querySelector('.agent-model-status [role="alert"]')!.textContent!, /unavailable or not configured/)
    assert.equal(document.querySelector('.agent-research-output'), null)
    assert.equal([...document.querySelectorAll('.agent-model-roles>div>span:last-child')].every(node => node.textContent === 'NOT RUN'), true)
    assert.equal(document.querySelectorAll('.agent-record').length, 0)
  } finally { await env.cleanup() }
})

test('a private-route interruption preserves paid public research and its explicit adoption', async () => {
  const env = await researchEnvironment(async () => Response.json(fixtureResearch()))
  try {
    const { document, root, payloads, until, pause } = env
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Run 0G research')!.click())
    await until(() => document.querySelector('.agent-research-output') !== null)
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use this research for paper review')!.click())
    const paused = { ...env.route, status: 'degraded' as const }
    flushSync(() => root.render(createElement(AgentWorkspace, { route: paused, routeGeneration: -1, onReconnect() {} })))
    await pause()
    assert.match(document.querySelector('.agent-route')!.textContent!, /Private route interrupted/)
    assert.doesNotMatch(document.querySelector('.agent-route')!.textContent!, /Checking|Connecting|Validating/)
    assert.match(document.querySelector('.agent-research-output')!.textContent!, /fixture-researcher-request/)
    assert.equal(document.querySelector<HTMLInputElement>('#agent-probability')!.value, '61')
    assert.equal(document.querySelector<HTMLButtonElement>('.agent-market-list button')!.getAttribute('aria-pressed'), 'true')
    assert.equal(document.querySelector('.agent-proposal'), null)
    assert.equal(document.querySelector('.agent-account-result'), null)
    assert.equal(payloads.length, 1)
    flushSync(() => root.render(createElement(AgentWorkspace, { route: { ...paused, status: 'closed' }, routeGeneration: -1, onReconnect() {} })))
    assert.match(document.querySelector('.agent-route')!.textContent!, /Private route disconnected/)
    assert.ok(document.querySelector('.agent-research-output'))
    const callsBeforeReconnect = env.venueCalls.length
    flushSync(() => root.render(createElement(AgentWorkspace, { route: env.route, routeGeneration: 2, onReconnect() {} })))
    await pause()
    assert.equal(env.venueCalls.length, callsBeforeReconnect, 'reconnect preserves retrieved source objects instead of silently refetching them')
    assert.ok(document.querySelector('.agent-research-output'))
  } finally { await env.cleanup() }
})

test('public research already in flight can complete across an unrelated private-route lifecycle change', async () => {
  let release!: (response: Response) => void
  const env = await researchEnvironment(() => new Promise<Response>(resolve => { release = resolve }))
  try {
    const { document, root, payloads, until } = env
    flushSync(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Run 0G research')!.click())
    await until(() => payloads.length === 1)
    const failed = { ...env.route, status: 'failed' as const }
    flushSync(() => root.render(createElement(AgentWorkspace, { route: failed, routeGeneration: -1, onReconnect() {} })))
    release(Response.json(fixtureResearch()))
    await until(() => document.querySelector('.agent-research-output') !== null)
    assert.match(document.querySelector('.agent-research-output')!.textContent!, /fixture-skeptic-request/)
    assert.equal(payloads.length, 1)
    assert.match(document.querySelector('.agent-route')!.textContent!, /Private route interrupted/)
    assert.equal(document.querySelectorAll('.agent-record').length, 0)
  } finally { await env.cleanup() }
})
