import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { AgentWorkspace } from '../src/agents/AgentWorkspace'

test('partial catalogue renders its skipped count and an independent order-cap field', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?view=agents' })
  const descriptors = ['window', 'document'].map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  const originalFetch = globalThis.fetch
  const root = createRoot(dom.window.document.getElementById('root')!)
  const row = { id: '101', version: 'v1', conditionId: `0x${'a'.repeat(64)}`, question: 'Synthetic UI fixture?',
    slug: 'fixture', outcomes: '["Yes","No"]', clobTokenIds: '["201","202"]', active: true, closed: false, acceptingOrders: true, enableOrderBook: true }
  globalThis.fetch = async () => Response.json({ status: 'ok', provider: '0g', configured: false, providerTrustMode: 'private', proxySeesPlaintext: true, jobsRemaining: 2, jobLimit: 2 })
  const route = {
    status: 'ready' as const,
    async fetchPublicMarket(url: string) {
      if (new URL(url).hostname === 'gamma-api.polymarket.com') return Response.json([null, row])
      return Response.json({ asset_id: '201', market: row.conditionId, timestamp: String(Date.now()), min_order_size: '1',
        asks: [{ price: '0.55', size: '100' }], bids: [{ price: '0.54', size: '100' }] })
    },
    async fetchRpc(body: string | Uint8Array) {
      const calls = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)) as { id: number; method: string }[]
      return Response.json(calls.map(call => ({ jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? '0x89' : '0x1000' })))
    },
  }
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(condition(), 'expected fixture state did not arrive')
  }
  try {
    flushSync(() => root.render(createElement(AgentWorkspace, { route, routeGeneration: 1, onReconnect() {} })))
    await until(() => dom.window.document.querySelector('.agent-market-list button') !== null)
    assert.match(dom.window.document.body.textContent!, /Skipped 1 invalid or unsupported market row/)
    flushSync(() => dom.window.document.querySelector<HTMLButtonElement>('.agent-market-list button')!.click())
    await until(() => dom.window.document.querySelector('.agent-book-strip') !== null)
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('#agent-max-per-order')!.value, '5')
    assert.match(dom.window.document.querySelector('#agent-max-per-order')!.parentElement!.textContent!, /Increasing the paper stake does not increase this limit/)
  } finally {
    flushSync(() => root.unmount())
    // Drain React's queued work before removing the browser globals.
    await new Promise(resolve => setTimeout(resolve, 35))
    globalThis.fetch = originalFetch
    dom.window.close()
    for (const [i, name] of ['window', 'document'].entries()) {
      if (descriptors[i]) Object.defineProperty(globalThis, name, descriptors[i]!)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
