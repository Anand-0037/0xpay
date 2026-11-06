import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSepoliaPoi } from '../src/railgun/poi.ts'

test('POI preflight rejects errors and mismatched envelopes even with a valid-looking result', async () => {
  const original = globalThis.fetch
  const result = { validatedTxidIndex: 100, validatedTxidMerkleroot: 'a'.repeat(64) }
  let payload: unknown = { jsonrpc: '2.0', id: 1, result }
  globalThis.fetch = async () => Response.json(payload)
  try {
    assert.equal(await checkSepoliaPoi(), 100)
    for (const invalid of [
      { jsonrpc: '2.0', id: 1, result, error: { code: -32000, message: 'Unavailable' } },
      { jsonrpc: '2.0', id: 2, result },
      { id: 1, result },
      { jsonrpc: '2.0', id: 1, result: { ...result, validatedTxidIndex: -1 } },
    ]) {
      payload = invalid
      await assert.rejects(checkSepoliaPoi(), /POI did not return/)
    }
  } finally { globalThis.fetch = original }
})
