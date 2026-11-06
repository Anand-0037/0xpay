import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { WalletStatus } from '../src/wallet/WalletPanel.tsx'

const address = '0x1234567890abcdef1234567890abcdef12345678'

test('public wallet status keeps the full address and accessible controls', () => {
  const html = renderToStaticMarkup(createElement(WalletStatus, { address, onLock: () => {} }))
  assert.match(html, new RegExp(address))
  assert.match(html, /aria-label="Copy public wallet address"/)
  assert.match(html, /aria-label="Lock wallet"/)
  assert.doesNotMatch(html, /Address copied/)
})

test('copy requires a click, reports the result, and lock remains explicit', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' })
  const original = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

  const copied: string[] = []
  let locks = 0
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const click = async (label: string) => {
    const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    assert.ok(target)
    await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  }

  try {
    await act(async () => { root.render(createElement(WalletStatus, { address, onLock: () => { locks += 1 } })) })
    assert.deepEqual(copied, [])
    await click('Copy public wallet address')
    assert.deepEqual(copied, [address])
    assert.equal(container.querySelector('[role="status"]')?.textContent, 'Address copied')
    Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied') } } })
    await click('Copy public wallet address')
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Copy failed/)
    await click('Lock wallet')
    assert.equal(locks, 1)
  } finally {
    await act(async () => { root.unmount() })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: original.window })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: original.document })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original.navigator })
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})
