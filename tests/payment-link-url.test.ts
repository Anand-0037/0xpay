import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearImportedPaymentLink } from '../src/pay/payment-link-url.ts'

test('clears only the imported bearer fragment and preserves the app path and query', () => {
  const secret = '#claim=private-note-secret'
  const calls: unknown[][] = []
  const state = { view: 'wallet' }
  const history = { state, replaceState: (...args: unknown[]) => { calls.push(args) } }
  const location = { hash: secret, pathname: '/alt-mempool-wallet/', search: '?view=wallet' }

  assert.equal(clearImportedPaymentLink(secret, location, history as Pick<History, 'state' | 'replaceState'>), 'cleared')
  assert.deepEqual(calls, [[state, '', '/alt-mempool-wallet/?view=wallet']])
  assert.equal(JSON.stringify(calls).includes('private-note-secret'), false)
})

test('does not remove a new or unrelated fragment after a delayed import', () => {
  const calls: unknown[][] = []
  const history = { state: null, replaceState: (...args: unknown[]) => { calls.push(args) } }
  const location = { hash: '#claim=new-link', pathname: '/', search: '' }

  assert.equal(clearImportedPaymentLink('#claim=old-link', location, history as Pick<History, 'state' | 'replaceState'>), 'not-current')
  assert.equal(clearImportedPaymentLink('#other=not-a-note', location, history as Pick<History, 'state' | 'replaceState'>), 'not-current')
  assert.deepEqual(calls, [])
})

test('reports a denied history replacement without treating the import as failed', () => {
  const secret = '#claim=stored-note'
  const history = { state: null, replaceState: () => { throw new Error('history unavailable') } }
  const location = { hash: secret, pathname: '/', search: '' }

  assert.equal(clearImportedPaymentLink(secret, location, history), 'failed')
  assert.equal(location.hash, secret)
})
