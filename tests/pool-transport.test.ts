import assert from 'node:assert/strict'
import { test } from 'node:test'
import { privateTransport } from '../src/pool/transport.ts'
import { APP_RPC_URL, MEMPOOL_RPC_URL } from '../src/rpc/networks.ts'
import type { PrivateRpc } from '../src/rpc.ts'
test('transport delegates JSON-RPC to the private worker and rejects unknown destinations', async () => {
  const bodies: string[] = []
  const targets: string[] = []
  const route = { chain: 'devnet', network: 'nox', fetchRpc: async (body: string, target: string) => { bodies.push(body); targets.push(target); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })) } } as PrivateRpc
  const send = privateTransport(route)
  assert.deepEqual(await send(MEMPOOL_RPC_URL, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), { jsonrpc: '2.0', id: 1, result: '0x1' })
  assert.equal(JSON.parse(bodies[0]).method, 'eth_chainId')
  assert.equal(targets[0], MEMPOOL_RPC_URL)
  await assert.rejects(send('https://unapproved.example', {}), /Unsupported RPC destination/)
})

test('Nym routes only standard devnet reads to the root through the worker', async () => {
  const targets: string[] = []
  const route = { chain: 'devnet', network: 'nym', fetchRpc: async (_body: string, target: string) => {
    targets.push(target)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))
  } } as PrivateRpc
  const send = privateTransport(route)
  for (const method of ['eth_chainId', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_getLogs', 'eth_call']) {
    await send(MEMPOOL_RPC_URL, { jsonrpc: '2.0', id: 1, method, params: [] })
  }
  assert.deepEqual(targets, Array(5).fill(APP_RPC_URL))
  await send(MEMPOOL_RPC_URL, { jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [] })
  await send(MEMPOOL_RPC_URL, { jsonrpc: '2.0', id: 1, method: 'skandha_config', params: [] })
  await send(MEMPOOL_RPC_URL, [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }])
  assert.deepEqual(targets.slice(5), [MEMPOOL_RPC_URL, MEMPOOL_RPC_URL, MEMPOOL_RPC_URL])
})
