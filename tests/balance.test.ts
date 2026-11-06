import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RailgunWalletBalanceBucket } from '@railgun-community/shared-models'
import { createFreshBalanceReader, type PrivateWethBalanceUpdate } from '../src/railgun/balance.ts'

test('fresh spendable callback resolves while later SDK background scan is pending', async () => {
  let listener: ((update: PrivateWethBalanceUpdate) => void) | undefined
  let stopped = false
  const read = createFreshBalanceReader(async (_id, callback) => {
    listener = callback
    return () => { stopped = true }
  }, async () => new Promise<void>(() => {}), 500)
  const pending = read('wallet-a')
  await Promise.resolve()
  listener?.({ walletId: 'wallet-b', bucket: RailgunWalletBalanceBucket.Spendable, amountWei: 99n, receivedAt: Date.now() })
  listener?.({ walletId: 'wallet-a', bucket: RailgunWalletBalanceBucket.ShieldPending, amountWei: 100n, receivedAt: Date.now() })
  listener?.({ walletId: 'wallet-a', bucket: RailgunWalletBalanceBucket.Spendable, amountWei: 3n, receivedAt: Date.now() })
  assert.equal(await pending, 3n)
  assert.equal(stopped, true)
})

test('missing fresh callback is unknown, never a substituted zero balance', async () => {
  let stopped = false
  const read = createFreshBalanceReader(async () => () => { stopped = true }, async () => {}, 10)
  await assert.rejects(read('wallet-a'), /amount is unknown/)
  assert.equal(stopped, true)
})

test('SDK scan rejection propagates and releases its balance subscription', async () => {
  let stopped = false
  const read = createFreshBalanceReader(async () => () => { stopped = true }, async () => { throw new Error('Route failed') }, 500)
  await assert.rejects(read('wallet-a'), /Route failed/)
  assert.equal(stopped, true)
})
