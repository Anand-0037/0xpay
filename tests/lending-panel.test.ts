import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { LendingPanel } from '../src/lending/LendingPanel.tsx'

test('route loss preserves the draft only in page memory while blocking reads and discarding the old response', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  const previous = ['window', 'document'].map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  const root = createRoot(dom.window.document.getElementById('root')!)
  let reads = 0
  let release!: (response: Response) => void
  const route = { status: 'ready' as 'ready' | 'degraded', async fetchRpc() {
    reads++
    return new Promise<Response>((resolve) => { release = resolve })
  } }
  const render = (generation: number) => flushSync(() => root.render(createElement(LendingPanel, { route, routeGeneration: generation, onReconnect() {} })))
  try {
    render(1)
    const example = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Try a public example'))!
    flushSync(() => example.click())
    const address = (dom.window.document.getElementById('lending-account') as HTMLInputElement).value
    assert.match(address, /^0x[0-9a-f]{40}$/)
    assert.equal(reads, 1)
    route.status = 'degraded'
    render(-1)
    assert.equal((dom.window.document.getElementById('lending-account') as HTMLInputElement).value, address)
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true)
    assert.equal(dom.window.document.querySelector('.lending-results'), null)
    assert.equal(dom.window.document.querySelector('.lending-scenario'), null)
    release(Response.json([{ jsonrpc: '2.0', id: 1, result: 'old response' }]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null)
    assert.equal(reads, 1)
    assert.equal(dom.window.location.search, '')
    assert.equal(dom.window.localStorage.length, 0)
    route.status = 'ready'
    render(2)
    assert.equal((dom.window.document.getElementById('lending-account') as HTMLInputElement).value, address)
    assert.equal(dom.window.document.querySelector('.lending-results'), null)
    assert.equal(reads, 1, 'reconnect requires an explicit fresh position request')
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 30))
    dom.window.close()
    ;['window', 'document'].forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
})

test('worker readiness alone cannot authorize a query before the app connection check finishes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  const names = ['window', 'document'] as const
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  names.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }))
  const root = createRoot(dom.window.document.getElementById('root')!)
  let reads = 0
  const route = { status: 'ready' as const, async fetchRpc() { reads++; throw new Error('Unverified query reached the network') } }
  try {
    flushSync(() => root.render(createElement(LendingPanel, { route, routeGeneration: -1, onReconnect() {} })))
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true)
    assert.equal([...dom.window.document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Try a public example'))!.disabled, true)
    flushSync(() => dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
    assert.equal(reads, 0)
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Reconnect the private route/)
    assert.equal(dom.window.document.querySelector('.lending-results'), null)
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 30))
    dom.window.close()
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
})
