import test from 'node:test'
import assert from 'node:assert/strict'
import { WalletViewGate } from '../src/pay/view-gate.ts'

test('a pending payment prevents a second operation until that payment settles', async () => {
  const gate = new WalletViewGate()
  const first = gate.beginOperation()!
  assert.equal(gate.busy, true)
  assert.equal(gate.beginOperation(), null)
  await Promise.resolve()
  assert.equal(gate.isCurrent(first), true)
  assert.equal(gate.finish(first), true)
  const second = gate.beginOperation()!
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.finish(first), false)
  assert.equal(gate.isCurrent(second), true)
  assert.equal(gate.busy, true)
})
test('API/session replacement invalidates old completion without unlocking the new operation', () => {
  const gate = new WalletViewGate()
  const old = gate.beginOperation()!
  gate.invalidate()
  const current = gate.beginOperation()!
  assert.equal(gate.isCurrent(old), false)
  assert.equal(gate.finish(old), false)
  assert.equal(gate.isCurrent(current), true)
  assert.equal(gate.busy, true)
})
test('late refresh results cannot overwrite a newer refresh or another wallet', () => {
  const gate = new WalletViewGate()
  const old = gate.beginRead()
  const current = gate.beginRead()
  assert.equal(gate.isReadCurrent(old), false)
  assert.equal(gate.isReadCurrent(current), true)
  gate.invalidate()
  assert.equal(gate.isReadCurrent(current), false)
})
