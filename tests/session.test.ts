import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionGate } from '../src/wallet/session.ts'

test('locking while unlock is pending cannot revive a wallet', async () => {
  const gate = new SessionGate()
  let resolveUnlock: (() => void) | undefined
  const pendingWork = new Promise<void>((resolve) => { resolveUnlock = resolve })
  let active = false
  const generation = gate.beginUnlock()
  const unlock = (async () => {
    try {
      await pendingWork
      gate.assertCurrent(generation)
      active = true
    } finally { gate.finishUnlock() }
  })()
  await gate.lock(() => { active = false })
  resolveUnlock?.()
  await assert.rejects(unlock, /locked during unlock/)
  assert.equal(active, false)
})

test('another unlock waits for pending unlock cleanup', async () => {
  const gate = new SessionGate()
  const first = gate.beginUnlock()
  await gate.lock(() => {})
  assert.throws(() => gate.beginUnlock(), /already running/)
  assert.throws(() => gate.assertCurrent(first), /locked during unlock/)
  gate.finishUnlock()
  const second = gate.beginUnlock()
  gate.assertCurrent(second)
  gate.finishUnlock()
})
