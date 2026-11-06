import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Dashboard, { type DashboardData, type DashboardErrors } from '../src/dashboard/Dashboard'

const data: DashboardData = { publicBalance: 0n, privateBalance: 100_000_000_000_000_000n, notes: 1, tokens: null, activity: [] }
function render(errors: DashboardErrors, canRetry = true, values = data) {
  return renderToStaticMarkup(createElement(Dashboard, { data: values, errors, canRetry, onNavigate: () => {}, onRetry: () => {} }))
}
test('failed optional portfolio does not hide successful balances or look like an empty portfolio', () => {
  const html = render({ tokens: true })
  assert.match(html, /Portfolio unavailable/)
  assert.match(html, /0\.1 <small>ETH/)
  assert.match(html, /0 <small>ETH/)
  assert.doesNotMatch(html, /Loading portfolio|No public tokens found/)
  assert.match(html, /Retry wallet reads/)
})
test('failed native balance is unavailable rather than a zero value or an endless loading skeleton', () => {
  const html = render({ publicBalance: true })
  assert.match(html, /aria-label="Balance unavailable"/)
  assert.match(html, /Public balance unavailable/)
  assert.doesNotMatch(html, /aria-label="Loading balance"/)
  assert.doesNotMatch(html, /0 <small>ETH/)
})
test('read retry is disabled when the private route is disconnected', () => {
  const html = render({ activity: true }, false)
  assert.match(html, /Reconnect your private route/)
  assert.match(html, /<button type="button" disabled="">Retry wallet reads/)
  assert.doesNotMatch(html, /Loading activity/)
})
test('unresolved reads stay loading instead of being reported as empty or failed', () => {
  const html = render({}, true, { publicBalance: null, privateBalance: null, notes: null, tokens: null, activity: null })
  assert.match(html, /Loading balance/)
  assert.match(html, /Loading portfolio/)
  assert.doesNotMatch(html, /unavailable|No public tokens found|0 unspent/)
})

test('private notes mode does not render cached funding or token balances', () => {
  const html = renderToStaticMarkup(createElement(Dashboard, {
    data: { ...data, publicBalance: 12_000_000_000_000_000_000n, tokens: [{ symbol: 'USDC', balance: 250n, decimals: 6 }] },
    errors: { publicBalance: true, tokens: true },
    privateNotesOnly: true,
    onPrivateNotesOnlyChange: () => {},
    onNavigate: () => {},
  }))
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /Funding-account and public-token balance reads are paused/)
  assert.match(html, /0\.1 <small>ETH/)
  assert.doesNotMatch(html, /12 <small>ETH|USDC|250|Public balance unavailable|Portfolio unavailable|Loading portfolio/)
})
