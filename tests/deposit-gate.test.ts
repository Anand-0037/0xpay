import assert from 'node:assert/strict'
import test from 'node:test'
import { depositGate } from '../src/pay/deposit-gate.ts'

const ready = { routeReady: true, routeConnecting: false, paymentWorkerReady: true, activityLoaded: true, activityFailed: false,
  pendingDeposit: false, balanceWei: 140_000_000_000_000_000n, balanceFailed: false,
  maximumDebitWei: 140_000_000_000_000_000n }

test('deposit is ready at the exact signed maximum debit', () => {
  assert.deepEqual(depositGate(ready), { ready: true, reason: null, shortfallWei: 0n })
})

test('deposit blocks before review when public balance is short', () => {
  const result = depositGate({ ...ready, balanceWei: 100_000_000_000_000_000n })
  assert.equal(result.ready, false)
  assert.equal(result.shortfallWei, 40_000_000_000_000_000n)
})

test('deposit blocks unknown balance and earlier payment state', () => {
  assert.equal(depositGate({ ...ready, balanceWei: null }).ready, false)
  assert.equal(depositGate({ ...ready, activityLoaded: false }).ready, false)
  assert.equal(depositGate({ ...ready, activityFailed: true }).ready, false)
})

test('deposit blocks pending outcome and private-route loss', () => {
  assert.match(depositGate({ ...ready, pendingDeposit: true }).reason ?? '', /existing deposit/)
  assert.equal(depositGate({ ...ready, routeReady: false }).ready, false)
  assert.match(depositGate({ ...ready, routeReady: false, routeConnecting: true }).reason ?? '', /Waiting/)
  assert.equal(depositGate({ ...ready, paymentWorkerReady: false }).ready, false)
})
