import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AbiCoder } from 'ethers'
import { APP_RPC_URL, PrivateRpc } from '../src/rpc.ts'

const rpcReply = (request: string) => {
  const { id, method } = JSON.parse(request) as { id: number; method: string }
  const result = method === 'eth_chainId' ? '0xaa36a7' : '0x5abdc0'
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 })
}

test('failed private read blocks more reads until explicit reconnect', async () => {
  let workerNumber = 0
  let directCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { directCalls += 1; throw new Error('Direct fetch forbidden') }
  try {
    const route = new PrivateRpc(() => {
      const number = ++workerNumber
      return {
        ready: Promise.resolve(), close() {},
        async fetch(url, init) {
          assert.equal(url, APP_RPC_URL)
          const body = String(init.body)
          if (number === 1 && body.includes('eth_getBalance')) throw new Error('worker failed once')
          return rpcReply(body)
        },
      }
    })
    await route.connect()
    await assert.rejects(route.fetchRpc('{"method":"eth_getBalance"}'), /worker failed once/)
    assert.equal(route.status, 'degraded')
    await assert.rejects(route.fetchRpc('{"method":"eth_getBalance"}'), /needs reconnecting/)
    await route.reconnect()
    assert.equal(route.status, 'ready')
    assert.equal((await route.fetchRpc('{"method":"eth_getBalance"}')).status, 200)
    assert.equal(workerNumber, 2)
    assert.equal(directCalls, 0)
    route.close()
  } finally { globalThis.fetch = originalFetch }
})

test('replaced workers cannot restore stale bundle resolver access', async () => {
  const callbacks: Array<(selector: string, result: unknown) => void> = []
  const route = new PrivateRpc((onBootstrap) => {
    callbacks.push(onBootstrap)
    return { ready: Promise.resolve(), close() {}, async fetch(_url, init) { return rpcReply(String(init.body)) } }
  })
  const encoded = (url: string) => AbiCoder.defaultAbiCoder().encode(['string[]'], [[url]])
  const selector = '0x1c67ff29'
  await route.connect()
  callbacks[0](selector, encoded('https://old.example/worker.js'))
  assert.deepEqual(route.approvedBundleResolvers, ['https://old.example/worker.js'])
  await route.reconnect()
  assert.deepEqual(route.approvedBundleResolvers, [])
  callbacks[0](selector, encoded('https://stale.example/worker.js'))
  assert.deepEqual(route.approvedBundleResolvers, [])
  callbacks[1](selector, encoded('https://new.example/worker.js'))
  assert.deepEqual(route.approvedBundleResolvers, ['https://new.example/worker.js'])
  route.close()
  assert.deepEqual(route.approvedBundleResolvers, [])
  callbacks[1](selector, encoded('https://late.example/worker.js'))
  assert.deepEqual(route.approvedBundleResolvers, [])
})
