import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement, useState, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ConnectionDetails } from '../src/ui/ConnectionDetails.tsx'
import { PrivateRpc } from '../src/rpc.ts'

const stats = { attempted: 4, completed: 3, failed: 1, bootstrapReads: 2,
  methodCounts: { eth_getBalance: { attempted: 2, completed: 2, failed: 0 },
    eth_sendRawTransaction: { attempted: 1, completed: 0, failed: 1 } } }
const base: Omit<ComponentProps<typeof ConnectionDetails>, 'open' | 'onClose'> = {
  route: { status: 'ready', stats }, engine: { status: 'ready', shieldFeeBasisPoints: 25n },
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

test('connection drawer keeps coverage concise and traps/restores keyboard focus', async () => {
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
    assert.equal(summary.textContent, 'Privacy coverage')
    assert.match(dialog.querySelector('#connection-explanation')!.textContent!, /If the connection fails, requests stop/)
    assert.match(dialog.textContent!, /Connected through Nym/)
    assert.match(dialog.textContent!, /Nym via Anon-RPC/)
    assert.equal(dialog.querySelector('select'), null, 'network selection remains optional for legacy callers')
    assert.doesNotMatch(dialog.textContent!, /RPC methods observed|Recent page destinations|Signed broadcasts|3\/4|2 direct specifier reads/)
    assert.match(technical.textContent!, /gas-paying address remains public/)
    assert.equal(document.activeElement, close)

    const key = (value: string, shiftKey = false) => document.activeElement!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }))
    key('Tab', true)
    assert.equal(document.activeElement, summary, 'closed diagnostics must not expose hidden controls to the trap')
    key('Tab')
    assert.equal(document.activeElement, close)
    technical.open = true
    close.focus(); key('Tab', true)
    assert.equal(document.activeElement, summary)
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

test('agent coverage retains simulation and separate inference boundaries without request logs', async () => {
  const { dom, root, cleanup } = environment()
  try {
    flushSync(() => root.render(createElement(ConnectionDetails, { ...base, open: true, context: 'agents',
      privacyNetwork: 'nox', onClose() {} })))
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    assert.match(dialog.textContent!, /Nox via Anon-RPC · Polygon/)
    assert.match(dialog.textContent!, /Orders here are simulated and do not move funds/)
    assert.match(dialog.textContent!, /app server and 0G separately/)
    assert.match(dialog.textContent!, /policy signing uses your browser wallet/)
    assert.doesNotMatch(dialog.textContent!, /bootstrapReads|eth_getBalance|RPC requests|Recent page destinations/)
    assert.ok([...dialog.querySelectorAll('button')].some(button => button.textContent === 'Disconnect private route'))
  } finally { await cleanup() }
})

test('connection failure exposes the actual reason and reconnect without opening technical details', async () => {
  const { dom, root, cleanup } = environment()
  let retries = 0
  try {
    flushSync(() => root.render(createElement(ConnectionDetails, { ...base, open: true, onClose() {},
      route: { status: 'failed', stats, message: 'raw worker timeout diagnostic' },
      onReconnect() { retries++ } })))
    const document = dom.window.document
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    assert.equal(dialog.querySelector('[role="alert"]')?.textContent, 'raw worker timeout diagnostic')
    assert.equal(dialog.querySelector('[role="alert"]')?.closest('details'), null)
    const technical = dialog.querySelector<HTMLDetailsElement>('details')!
    assert.equal(technical.open, false)
    assert.doesNotMatch(technical.textContent!, /raw worker timeout diagnostic/)
    const reconnect = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!
    flushSync(() => reconnect.click())
    assert.equal(retries, 1)
    assert.equal([...dialog.querySelectorAll('button')].some((button) => button.textContent === 'Disconnect private route'), false)
  } finally { await cleanup() }
})

test('connection progress reports elapsed time and observed stage without fabricated progress', async () => {
  const { dom, root, cleanup } = environment()
  try {
    const render = (stage: 'starting-worker' | 'validating-chain', elapsedMs: number) => flushSync(() =>
      root.render(createElement(ConnectionDetails, { ...base, open: true, privacyNetwork: 'nox', onClose() {},
        route: { status: 'connecting', stats, stage, elapsedMs } })))
    render('starting-worker', 12_450)
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    assert.match(dialog.textContent!, /Connecting through Nox · 12s/)
    assert.ok(dialog.querySelector('.connection-spinner[aria-hidden="true"]'))
    assert.doesNotMatch(dialog.textContent!, /% complete|Almost ready|Checking the network/)
    render('validating-chain', 31_050)
    assert.match(dialog.textContent!, /Checking the network · 31s/)
    assert.doesNotMatch(dialog.textContent!, /Connecting through Nox ·/)
    flushSync(() => root.render(createElement(ConnectionDetails, { ...base, open: true, onClose() {},
      route: { status: 'failed', stats, elapsedMs: 60_800, message: 'Private RPC read timed out' } })))
    assert.match(dialog.textContent!, /Connection attempt stopped after 60s/)
    assert.match(dialog.querySelector('[role="alert"]')!.textContent!, /Private RPC read timed out/)
  } finally { await cleanup() }
})

test('a manual disconnect is distinct from the following real worker timeout; reconnect does not auto-retry', async () => {
  const { dom, root, cleanup } = environment()
  const originalFetch = globalThis.fetch
  let workers = 0, directCalls = 0
  globalThis.fetch = async () => { directCalls++; throw new Error('Direct RPC forbidden') }
  const route = new PrivateRpc(() => {
    const index = ++workers
    return { ready: Promise.resolve(), close() {}, async fetch(_url, init) {
      if (index === 2) throw new Error('Private RPC read timed out')
      const request = JSON.parse(String(init.body))
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0xaa36a7' : '0x123' })
    } }
  })
  type UiRoute = ComponentProps<typeof ConnectionDetails>['route']
  function Harness() {
    const [state, setState] = useState<UiRoute>({ status: 'ready', stats: route.stats })
    return createElement(ConnectionDetails, { ...base, open: true, route: state, onClose() {},
      onDisconnect() {
        route.disconnect()
        setState({ status: 'failed', stats: route.stats, disconnectedByUser: true, message: 'You disconnected the private route.' })
      }, onReconnect() {
        setState({ status: 'connecting', stats: route.stats, stage: 'starting-worker', elapsedMs: 0 })
        void route.reconnect().then(() => setState({ status: 'ready', stats: route.stats })).catch((cause: unknown) =>
          setState({ status: 'failed', stats: route.stats, message: cause instanceof Error ? cause.message : 'Connection failed' }))
      } })
  }
  try {
    await route.connect()
    flushSync(() => root.render(createElement(Harness)))
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    const technical = dialog.querySelector<HTMLDetailsElement>('details')!
    technical.open = true
    const disconnect = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Disconnect private route')!
    flushSync(() => disconnect.click())
    assert.match(dialog.textContent!, /Disconnected by you/)
    assert.equal(dialog.querySelector('[role="alert"]'), null)
    assert.equal(route.status, 'degraded')
    const reconnect = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Reconnect')!
    flushSync(() => reconnect.click())
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.match(dialog.querySelector('[role="alert"]')!.textContent!, /Private RPC read timed out/)
    assert.doesNotMatch(dialog.querySelector('.connection-state')!.textContent!, /Disconnected by you/)
    assert.equal(dialog.querySelector('[role="alert"]')!.closest('details'), null)
    assert.equal(workers, 2, 'manual reconnect makes one worker, never an automatic retry')
    assert.equal(route.stats.failed, 1)
    assert.equal(directCalls, 0)
  } finally { route.close(); globalThis.fetch = originalFetch; await cleanup() }
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
    assert.match(dialog.textContent!, /does not hide public onchain activity/)
  } finally { await cleanup() }
})
