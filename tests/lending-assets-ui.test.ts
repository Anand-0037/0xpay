import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { LendingAssets, formatAssetAmount } from '../src/lending/LendingAssets'
import type { LendingPosition } from '../src/lending/position'

test('asset amounts preserve exact bigint precision beyond safe integers', () => {
  assert.deepEqual(formatAssetAmount(9007199254740993123456789n, 18), { exact: '9007199.254740993123456789', compact: '9007199.25474' })
  assert.deepEqual(formatAssetAmount(123456789n, 8), { exact: '1.23456789', compact: '1.234567' })
  assert.deepEqual(formatAssetAmount(123n, 0), { exact: '123', compact: '123' })
})

test('nonzero balances below display precision remain visible', () => {
  assert.deepEqual(formatAssetAmount(1n, 18), { exact: '0.000000000000000001', compact: '<0.000001' })
  assert.deepEqual(formatAssetAmount(1n, 6), { exact: '0.000001', compact: '0.000001' })
  assert.deepEqual(formatAssetAmount(0n, 18), { exact: '0', compact: '0' })
  assert.throws(() => formatAssetAmount(-1n, 18), /Unsupported/)
  assert.throws(() => formatAssetAmount(1n, 37), /Unsupported/)
})

test('failed asset reads are not shown as empty balances and old-route failures are discarded', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  const previous = ['window', 'document'].map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  const root = createRoot(dom.window.document.getElementById('root')!)
  const position: LendingPosition = {
    account: `0x${'1'.repeat(40)}`, chainId: 11155111, blockNumber: 100, blockHash: `0x${'a'.repeat(64)}`,
    blockTimestamp: 1, collateralBase: 1n, debtBase: 1n, availableBorrowBase: 0n,
    liquidationThresholdBps: 8000n, ltvBps: 7500n, healthFactorWad: 1n, baseCurrencyUnit: 100000000n,
  }
  let rejectOld!: (cause: Error) => void
  let calls = 0
  const oldRoute = { status: 'ready' as 'ready' | 'degraded', async fetchRpc() {
    calls++
    return new Promise<Response>((_, reject) => { rejectOld = reject })
  } }
  const failedRoute = { status: 'ready' as const, async fetchRpc() { calls++; throw new Error('Asset route interrupted') } }
  const pause = () => new Promise(resolve => setTimeout(resolve, 30))
  try {
    flushSync(() => root.render(createElement(LendingAssets, { route: oldRoute, position })))
    assert.match(dom.window.document.body.textContent!, /Loading assets/)
    oldRoute.status = 'degraded'
    flushSync(() => root.render(createElement(LendingAssets, { route: oldRoute, position })))
    assert.match(dom.window.document.body.textContent!, /Asset reads paused/)
    rejectOld(new Error('Stale route failure'))
    await pause()
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null)
    assert.equal(calls, 1)
    flushSync(() => root.render(createElement(LendingAssets, { route: failedRoute, position })))
    await pause()
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Asset route interrupted/)
    assert.doesNotMatch(dom.window.document.body.textContent!, /No outstanding debt|No supplied assets/)
    assert.equal(dom.window.localStorage.length, 0)
  } finally {
    flushSync(() => root.unmount())
    await pause()
    dom.window.close()
    ;['window', 'document'].forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
})
