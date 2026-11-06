import assert from 'node:assert/strict'
import { test } from 'node:test'
import { privateTransport } from '../src/pool/transport.ts'
import { MEMPOOL_RPC_URL } from '../src/rpc/networks.ts'
import type { PrivateRpc } from '../src/rpc.ts'
test('transport delegates JSON-RPC to the private worker and rejects unknown destinations', async () => {
  const bodies: string[] = []
  const targets: string[] = []
  const route = { chain: 'devnet', fetchRpc: async (body: string, target: string) => { bodies.push(body); targets.push(target); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })) } } as PrivateRpc
  const send = privateTransport(route)
  assert.deepEqual(await send(MEMPOOL_RPC_URL, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), { jsonrpc: '2.0', id: 1, result: '0x1' })
  assert.equal(JSON.parse(bodies[0]).method, 'eth_chainId')
  assert.equal(targets[0], MEMPOOL_RPC_URL)
  await assert.rejects(send('https://unapproved.example', {}), /Unsupported RPC destination/)
})
