import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openVault, sealMnemonic } from '../src/wallet/vault.ts'

const phrase = 'test-only encrypted content without wallet material'

test('encrypted mnemonic unlocks only with its password', async () => {
  const vault = await sealMnemonic(phrase, 'long-test-password', 5944700)
  assert.equal(JSON.stringify(vault).includes(phrase), false)
  const unlocked = await openVault(vault, 'long-test-password')
  assert.equal(unlocked.mnemonic, phrase)
  assert.match(unlocked.sdkKey, /^[0-9a-f]{64}$/)
  await assert.rejects(openVault(vault, 'wrong-test-password'), /Could not unlock/)
})

test('modified ciphertext cannot unlock', async () => {
  const vault = await sealMnemonic(phrase, 'long-test-password', 5944700)
  const edited = { ...vault, ciphertext: vault.ciphertext.slice(0, -4) + 'AAAA' }
  await assert.rejects(openVault(edited, 'long-test-password'), /Could not unlock/)
})

test('invalid creation block is rejected', async () => {
  await assert.rejects(sealMnemonic(phrase, 'long-test-password', -1), /Invalid creation block/)
})
