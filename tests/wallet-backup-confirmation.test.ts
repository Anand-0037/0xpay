import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { confirmWalletBackup, createLocalWallet, lockLocalWallet, storedVault, unlockLocalWallet } from '../src/wallet/lifecycle.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
const values = new Map<string, string>()
let denyConfirmation = false
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (denyConfirmation && value.includes('"backupConfirmed":true')) throw new Error('Storage full')
    values.set(key, value)
  },
}, configurable: true })

test('backup confirmation persists across lock and unlock, and failed writes remain unconfirmed', async () => {
  const password = 'a secure test password'
  const { session } = await createLocalWallet(password, 0)
  assert.equal(storedVault()?.backupConfirmed, false)
  denyConfirmation = true
  assert.throws(() => confirmWalletBackup(session.id), /Storage full/)
  assert.equal(storedVault()?.backupConfirmed, false)
  denyConfirmation = false
  confirmWalletBackup(session.id)
  assert.equal(storedVault()?.backupConfirmed, true)
  await lockLocalWallet()
  assert.equal((await unlockLocalWallet(password)).backupConfirmed, true)
})
