import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateRpc } from '../src/rpc.ts'
import { AGENT_RPC_URL } from '../src/rpc/networks.ts'
import { checkAgentPrivateRoute } from '../src/agents/route-check.ts'

test('Polygon agent reads are pinned to the worker and cannot broadcast', async () => {
  const original = globalThis.fetch
  let direct = 0, calls = 0
  globalThis.fetch = async () => { direct++; throw new Error('Direct forbidden') }
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {}, async fetch(url, init) {
    assert.equal(url, AGENT_RPC_URL); calls++
    const requests = JSON.parse(await new Response(init.body).text())
    const reply = (request: {id:number;method:string;params:unknown[]}) => {
      if (request.method === 'eth_getBalance') assert.deepEqual(request.params, ['0x1111111111111111111111111111111111111111', '0x123'])
      return {jsonrpc:'2.0',id:request.id,result:request.method === 'eth_chainId' ? '0x89' : request.method === 'eth_getBalance' ? '0x5' : '0x123'}
    }
    return Response.json(Array.isArray(requests) ? requests.map(reply).reverse() : reply(requests))
  } }), 'nox', 'polygon-readonly')
  try {
    await route.connect()
    assert.deepEqual(await checkAgentPrivateRoute(route, '0x1111111111111111111111111111111111111111'),
      {chainId:137,blockNumber:291,account:'0x1111111111111111111111111111111111111111',balanceWei:5n})
    const before = calls
    await assert.rejects(route.fetchRpc(JSON.stringify({method:'eth_sendRawTransaction',params:['0xf00']})), /read-only/)
    assert.equal(calls, before)
    route.disconnect()
    await assert.rejects(checkAgentPrivateRoute(route), /Reconnect/)
    assert.equal(direct, 0)
  } finally { route.close(); globalThis.fetch = original }
})

test('agent route checks reject wrong chain, duplicate replies and route loss without showing a balance', async () => {
  for (const mode of ['chain','duplicate','lost'] as const) {
    const route = {status:'ready' as 'ready'|'degraded',async fetchRpc(body:string|Uint8Array) {
      const calls = JSON.parse(String(body))
      if (mode === 'lost') route.status = 'degraded'
      return Response.json(calls.map((call:{id:number},i:number)=>({jsonrpc:'2.0',id:mode === 'duplicate' ? calls[0].id : call.id,result:i === 0 ? mode === 'chain' ? '0x1' : '0x89' : '0x123'})))
    }}
    await assert.rejects(checkAgentPrivateRoute(route))
  }
})
