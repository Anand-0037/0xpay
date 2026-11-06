import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { createLocalWallet, lockLocalWallet } from '../src/wallet/lifecycle.ts'
import { claimedNullifiers, listStoredNotes, saveStoredNotes } from '../src/pool/notes.ts'
import { createNote, config } from '../src/pool/index.ts'
import { keccak256, toHex } from 'viem'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
const values = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }, configurable: true })
test('note secrets are encrypted at rest and recover after unlock', async () => {
  const { session } = await createLocalWallet('a secure test password', 0)
  const note = createNote(config.pool, config.chainId)
  await saveStoredNotes([{ note, status: 'pending-deposit' }])
  const saved = [...values.values()].at(-1)!
  assert.equal(saved.includes(note.secret.toString()), false)
  assert.equal((await listStoredNotes())[0].note.secret, note.secret)
  await lockLocalWallet()
  await assert.rejects(listStoredNotes(), /Wallet is locked/)
  assert.ok(session.publicAddress)
})
test('claim reconciliation reads the full event set without exposing a note nullifier', async () => {
  const topic = keccak256(toHex('Claim(address,bytes32,uint256)'))
  const nullifierHash = `0x${'ab'.repeat(32)}` as const
  const claimHash = `0x${'cd'.repeat(32)}` as const
  const requests: unknown[] = []
  const claimed = await claimedNullifiers(async (_url, body) => {
    requests.push(body)
    return { jsonrpc: '2.0', id: 1, result: [{ topics: [topic, `0x${'00'.repeat(32)}`, nullifierHash], transactionHash: claimHash }] }
  })
  assert.deepEqual([...claimed], [[nullifierHash, claimHash]])
  const request = requests[0] as { method: string; params: [{ topics: string[]; address: string }] }
  assert.equal(request.method, 'eth_getLogs')
  assert.equal(request.params[0].address, config.pool)
  assert.deepEqual(request.params[0].topics, [topic])
  assert.equal(JSON.stringify(request).includes(nullifierHash), false)
})
