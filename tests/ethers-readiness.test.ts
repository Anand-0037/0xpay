import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JsonRpcProvider } from 'ethers'
import { APP_RPC_URL, PrivateRpc } from '../src/rpc.ts'
import { assertPrivateRouteReady, bindEthersToPrivateRoute, unbindEthersRoute } from '../src/rpc/ethers-transport.ts'
import { startSepoliaEngine } from '../src/railgun/engine.ts'

const account = `0x${'1'.repeat(40)}`
function fixture() {
  let workers = 0
  let accountReads = 0
  let release!: () => void
  const nextReady = new Promise<void>((resolve) => { release = resolve })
  const route = new PrivateRpc(() => {
    const worker = ++workers
    return { ready: worker === 1 ? Promise.resolve() : nextReady, close() {}, async fetch(url, init) {
      assert.equal(url, APP_RPC_URL)
      const requests = JSON.parse(await new Response(init.body).text())
      const reply = (request: { id: number; method: string }) => {
        if (request.method === 'eth_getBalance') accountReads++
        assert.ok(['eth_chainId', 'eth_blockNumber', 'eth_getBalance'].includes(request.method))
        return { jsonrpc: '2.0', id: request.id,
          result: request.method === 'eth_chainId' ? '0xaa36a7' : request.method === 'eth_getBalance' ? '0x5' : '0x64' }
      }
      return Response.json(Array.isArray(requests) ? requests.map(reply) : reply(requests))
    } }
  })
  const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true, cacheTimeout: -1 })
  return { route, provider, release, accountReads: () => accountReads }
}

test('ethers permits the final block probe but blocks account reads and signing readiness until validation', async () => {
  const { route, provider, accountReads } = fixture()
  await route.connect()
  bindEthersToPrivateRoute(route, { healthOnly: true })
  try {
    await assert.rejects(provider.getBalance(account), /connection check|unavailable/i)
    assert.equal(accountReads(), 0)
    assert.throws(assertPrivateRouteReady, /unavailable/)
    assert.equal(await provider.getBlockNumber(), 100)
    bindEthersToPrivateRoute(route)
    assert.doesNotThrow(assertPrivateRouteReady)
    assert.equal(await provider.getBalance(account), 5n)
    assert.equal(accountReads(), 1)
  } finally { provider.destroy(); unbindEthersRoute(route); route.close() }
})

test('an already bound SDK provider cannot send account reads while its worker reconnects', async () => {
  const { route, provider, release, accountReads } = fixture()
  await route.connect()
  bindEthersToPrivateRoute(route)
  const reconnecting = route.reconnect()
  try {
    assert.equal(route.status, 'connecting')
    await assert.rejects(provider.getBalance(account), /unavailable/)
    assert.equal(accountReads(), 0)
    release()
    await reconnecting
    assert.equal(await provider.getBalance(account), 5n)
    assert.equal(accountReads(), 1)
  } finally {
    release()
    await reconnecting.catch(() => {})
    provider.destroy(); unbindEthersRoute(route); route.close()
  }
})

test('late SDK startup cannot upgrade the health-only connection gate or start direct services', async () => {
  const { route, provider } = fixture()
  const original = globalThis.fetch
  let direct = 0
  globalThis.fetch = async () => { direct++; throw new Error('Unexpected direct request') }
  await route.connect()
  bindEthersToPrivateRoute(route, { healthOnly: true })
  try {
    await assert.rejects(startSepoliaEngine(route), /Private route is unavailable/)
    assert.equal(direct, 0)
    assert.throws(assertPrivateRouteReady, /unavailable/)
  } finally { provider.destroy(); unbindEthersRoute(route); route.close(); globalThis.fetch = original }
})
