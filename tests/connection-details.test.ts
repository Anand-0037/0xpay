import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement, useState, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ConnectionDetails } from '../src/ui/ConnectionDetails.tsx'

const stats = { attempted: 4, completed: 3, failed: 1, bootstrapReads: 2,
  methodCounts: { eth_getBalance: { attempted: 2, completed: 2, failed: 0 },
    eth_sendRawTransaction: { attempted: 1, completed: 0, failed: 1 } } }
const base: Omit<ComponentProps<typeof ConnectionDetails>, 'open' | 'onClose'> = {
  route: { status: 'ready', stats }, engine: { status: 'ready', shieldFeeBasisPoints: 25n },
  traffic: { counts: { poi: 1, artifacts: 0, indexer: 0, bootstrap: 2, 'app-static': 0, 'worker-bundle': 1, blocked: 0 },
    recent: [{ kind: 'poi', host: 'private-diagnostic.example', outcome: 'sent' }] },
  onReconnect() {}, onDisconnect() {},
}

function environment() {
  const dom = new JSDOM('<button id="outside">Outside</button><div id="root"></div>', { url: 'http://localhost/' })
  const names = ['window', 'document'] as const
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  names.forEach((name) => Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] }))
  const root = createRoot(dom.window.document.getElementById('root')!)
  return { dom, root, async cleanup() {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 20))
    dom.window.close()
    names.forEach((name, index) => {
      const descriptor = previous[index]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
  } }
}

test('connection drawer keeps diagnostics collapsed and traps/restores keyboard focus', async () => {
  const { dom, root, cleanup } = environment()
  function Harness() {
    const [open, setOpen] = useState(false)
    return createElement('div', null,
      createElement('button', { id: 'opener', onClick: () => setOpen(true) }, 'Connection'),
      createElement(ConnectionDetails, { ...base, open, onClose: () => setOpen(false) }))
  }
  try {
    flushSync(() => root.render(createElement(Harness)))
    const document = dom.window.document
    const opener = document.getElementById('opener')!
    opener.focus()
    flushSync(() => opener.click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const close = dialog.querySelector<HTMLButtonElement>('button')!
    const technical = dialog.querySelector<HTMLDetailsElement>('details')!
    const summary = technical.querySelector<HTMLElement>('summary')!
    assert.equal(technical.open, false)
    assert.equal(document.body.style.overflow, 'hidden')
    assert.equal(summary.textContent, 'Technical details')
    assert.match(dialog.querySelector('#connection-explanation')!.textContent!, /If the connection fails, requests stop/)
    assert.match(dialog.textContent!, /Connected through Nym/)
    assert.match(technical.textContent!, /Nym via Anon-RPC/)
    assert.equal(dialog.querySelector('select'), null, 'network selection remains optional for legacy callers')
    assert.match(technical.textContent!, /private-diagnostic.example/)
    assert.match(technical.textContent!, /does not establish RPC success or transaction settlement/)
    assert.equal(document.activeElement, close)

    const key = (value: string, shiftKey = false) => document.activeElement!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }))
    key('Tab', true)
    assert.equal(document.activeElement, summary, 'closed diagnostics must not expose hidden controls to the trap')
    key('Tab')
    assert.equal(document.activeElement, close)
    technical.open = true
    const disconnect = [...dialog.querySelectorAll<HTMLButtonElement>('button')].at(-1)!
    close.focus(); key('Tab', true)
    assert.equal(document.activeElement, disconnect)
    key('Tab')
    assert.equal(document.activeElement, close)
    document.getElementById('outside')!.focus()
    assert.equal(document.activeElement, close, 'background controls cannot take focus while modal is open')
    flushSync(() => { key('Escape') })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(document.body.style.overflow, '')
    assert.equal(document.activeElement, opener)
  } finally { await cleanup() }
})

test('connection failure shows a simple reconnect action with raw errors inside technical details', async () => {
  const { dom, root, cleanup } = environment()
  let retries = 0
  try {
    flushSync(() => root.render(createElement(ConnectionDetails, { ...base, open: true, onClose() {},
      route: { status: 'failed', stats, message: 'raw worker timeout diagnostic' },
      onReconnect() { retries++ } })))
    const document = dom.window.document
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    assert.equal(dialog.querySelector('[role="alert"]')?.textContent, 'Reconnect to continue using your wallet.')
    const technical = dialog.querySelector<HTMLDetailsElement>('details')!
    assert.equal(technical.open, false)
    assert.match(technical.textContent!, /raw worker timeout diagnostic/)
    const reconnect = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!
    flushSync(() => reconnect.click())
    assert.equal(retries, 1)
    assert.equal([...dialog.querySelectorAll('button')].some((button) => button.textContent === 'Disconnect private route'), false)
  } finally { await cleanup() }
})

test('lending connection is independent of wallet services and exposes disconnect while engine is waiting', async () => {
  const { dom, root, cleanup } = environment()
  let disconnected = 0
  try {
    flushSync(() => root.render(createElement(ConnectionDetails, { ...base, open: true, context: 'lending',
      engine: { status: 'waiting' }, onClose() {}, onDisconnect() { disconnected++ } })))
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    assert.doesNotMatch(dialog.textContent!, /Preparing your wallet|Waiting for private route/)
    assert.match(dialog.textContent!, /Position queries use Nym/)
    assert.match(dialog.textContent!, /does not start RAILGUN/)
    const disconnect = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Disconnect private route')!
    assert.ok(disconnect)
    flushSync(() => disconnect.click())
    assert.equal(disconnected, 1)
  } finally { await cleanup() }
})

test('Nox connection labels reflect the selected network and controlled selector requests only private networks', async () => {
  const { dom, root, cleanup } = environment()
  const changes: string[] = []
  try {
    const props = { ...base, open: true, context: 'lending' as const, privacyNetwork: 'nox' as const,
      onClose() {}, onNetworkChange(network: 'nox' | 'nym') { changes.push(network) } }
    flushSync(() => root.render(createElement(ConnectionDetails, props)))
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    const select = dialog.querySelector<HTMLSelectElement>('#privacy-network')!
    assert.equal(dialog.querySelector('label[for="privacy-network"]')?.textContent, 'Privacy network')
    assert.equal(select.value, 'nox')
    assert.deepEqual([...select.options].map(option => option.value), ['nox', 'nym'])
    assert.match(dialog.textContent!, /Connected through Nox/)
    assert.match(dialog.textContent!, /Nox via Anon-RPC/)
    assert.match(dialog.querySelector('#connection-explanation')!.textContent!, /Position queries use Nox/)
    assert.match(dialog.querySelector('#connection-explanation')!.textContent!, /Your onchain position stays public/)
    assert.doesNotMatch(dialog.textContent!, /Connected through Nym|Nym via Anon-RPC|Position queries use Nym/)
    flushSync(() => { select.value = 'nym'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    assert.deepEqual(changes, ['nym'])
    assert.equal(select.value, 'nox', 'parent controls network selection until connection is reloaded')
    flushSync(() => root.render(createElement(ConnectionDetails, { ...props, route: { ...base.route, status: 'connecting' } })))
    assert.match(dialog.querySelector('[role="status"]')!.textContent!, /Connecting through Nox/)
    assert.match(dialog.textContent!, /A successful response alone is not proof of anonymity/)
  } finally { await cleanup() }
})
