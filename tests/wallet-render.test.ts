import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { WalletPanel } from '../src/wallet/WalletPanel.tsx'
import { PrivateRpc } from '../src/rpc.ts'
import { bindEthersToPrivateRoute, unbindEthersRoute } from '../src/rpc/ethers-transport.ts'

test('wallet rerenders never duplicate shield forms or show send before spendability', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  const names = ['window', 'document', 'localStorage'] as const
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {}, async fetch(_url, init) {
    const input = JSON.parse(await new Response(init.body).text())
    const reply = ({ id, method }: { id: number; method: string }) => ({ jsonrpc: '2.0', id,
      result: method === 'eth_chainId' ? '0xaa36a7' : method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0xabc123' })
    return Response.json(Array.isArray(input) ? input.map(reply) : reply(input))
  } }))
  const root = createRoot(dom.window.document.getElementById('root')!)
  try {
    await route.connect()
    bindEthersToPrivateRoute(route)
    const props = { blockNumber: 12_000_000, engineReady: true, shieldFeeBasisPoints: 25n,
      connectionFailed: false, onRetry() {}, onSession() {}, session: { id: 'render-test-wallet',
        publicAddress: '0x4C748dF523c602a3E58208414b55AA1C961Db3e9', railgunAddress: '0zk-render-fixture', backupConfirmed: true, generation: 1 } }
    flushSync(() => root.render(createElement(WalletPanel, props)))
    for (let attempt = 0; attempt < 100 && dom.window.document.querySelectorAll('.shield-panel').length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(dom.window.document.querySelectorAll('.shield-panel').length, 1)
    for (let count = 0; count < 60; count++) flushSync(() => root.render(createElement(WalletPanel, { ...props, blockNumber: props.blockNumber + count })))
    assert.equal(dom.window.document.querySelectorAll('#shield-heading').length, 1)
    assert.equal(dom.window.document.querySelectorAll('#shield-eth-amount').length, 1)
    assert.equal(dom.window.document.querySelectorAll('#send-heading').length, 0)
    assert.equal(dom.window.document.body.textContent?.includes('Use browser wallet'), false)
    flushSync(() => root.render(createElement(WalletPanel, { ...props, blockNumber: null, connectionFailed: true, routeVersion: -1 })))
    assert.equal(dom.window.document.querySelectorAll('#shield-heading').length, 0, 'a stopped route must hide the shield action')
    assert.equal(dom.window.document.querySelectorAll('#send-heading').length, 0)
    flushSync(() => root.render(createElement(WalletPanel, { ...props, routeVersion: 2 })))
    assert.equal(dom.window.document.querySelectorAll('#shield-heading').length, 1)
    flushSync(() => root.render(createElement(WalletPanel, { ...props, session: null })))
    assert.equal(dom.window.document.querySelectorAll('#shield-heading').length, 0, 'locked wallets cannot retain payment controls')
    flushSync(() => root.render(createElement(WalletPanel, { ...props, routeVersion: 2, session: { ...props.session, generation: 2 } })))
    for (let attempt = 0; attempt < 100 && dom.window.document.querySelectorAll('.shield-panel').length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(dom.window.document.querySelectorAll('#shield-heading').length, 1, 're-unlock must restore exactly one shield form')
    assert.equal(dom.window.document.querySelectorAll('#send-heading').length, 0, 'old session spendability must not unlock Send')
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 20))
    unbindEthersRoute(route); route.close(); dom.window.close()
    names.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) })
  }
})
