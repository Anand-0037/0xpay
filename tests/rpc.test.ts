import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AbiCoder } from 'ethers'
import { APP_RPC_URL, PrivateRpc } from '../src/rpc.ts'
import { assertPrivateRouteReady, bindEthersToPrivateRoute, unbindEthersRoute } from '../src/rpc/ethers-transport.ts'

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

test('transaction preparation requires a live private worker route', async () => {
  const route = new PrivateRpc(() => ({
    ready: Promise.resolve(), close() {},
    async fetch(_url, init) { return rpcReply(String(init.body)) },
  }))
  assert.throws(() => assertPrivateRouteReady(), /unavailable/)
  await route.connect()
  bindEthersToPrivateRoute(route)
  assert.doesNotThrow(() => assertPrivateRouteReady())
  route.close()
  assert.throws(() => assertPrivateRouteReady(), /unavailable/)
  unbindEthersRoute(route)
})

test('explicit disconnect stops requests and permits a fresh worker reconnect', async () => {
  let workers = 0
  let closed = 0
  const route = new PrivateRpc(() => {
    workers++
    return { ready: Promise.resolve(), close() { closed++ },
      async fetch(_url, init) { return rpcReply(String(init.body)) } }
  })
  try {
    await route.connect()
    bindEthersToPrivateRoute(route)
    route.disconnect()
    assert.equal(route.status, 'degraded')
    assert.throws(assertPrivateRouteReady, /unavailable/)
    const attempted = route.stats.attempted
    await assert.rejects(route.fetchRpc('{}'), /reconnecting/)
    assert.equal(route.stats.attempted, attempted)
    await route.reconnect()
    assert.equal(workers, 2)
    assert.ok(closed >= 1)
    assert.equal(route.status, 'ready')
    assert.doesNotThrow(assertPrivateRouteReady)
  } finally { unbindEthersRoute(route); route.close() }
})

test('method telemetry separates batch reads and signed broadcasts without retaining request contents', async () => {
  let fail = false
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {},
    async fetch(_url, init) {
      if (fail) throw new Error('worker unavailable')
      return rpcReply(typeof init.body === 'string' ? init.body : '{"id":1,"method":"eth_call"}')
    },
  }))
  try {
    await route.connect()
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 3, method: 'eth_getBalance', params: ['0xprivate-address'] },
      { jsonrpc: '2.0', id: 4, method: 'eth_getBalance', params: ['0xanother-address'] },
      { jsonrpc: '2.0', id: 5, method: 'eth_sendRawTransaction', params: ['0xsigned-bytes'] },
      { jsonrpc: '2.0', id: 6, method: 'arbitrary-private-string', params: [] },
    ])
    await route.fetchRpc(new TextEncoder().encode(batch))
    assert.deepEqual(route.stats.methodCounts?.eth_getBalance, { attempted: 2, completed: 2, failed: 0 })
    assert.deepEqual(route.stats.methodCounts?.eth_sendRawTransaction, { attempted: 1, completed: 1, failed: 0 })
    assert.deepEqual(route.stats.methodCounts?.other, { attempted: 1, completed: 1, failed: 0 })
    const snapshot = route.stats
    fail = true
    await assert.rejects(route.fetchRpc('{"method":"eth_sendRawTransaction","params":["0xsecret-bytes"]}'), /worker unavailable/)
    assert.deepEqual(route.stats.methodCounts?.eth_sendRawTransaction, { attempted: 2, completed: 1, failed: 1 })
    assert.deepEqual(snapshot.methodCounts?.eth_sendRawTransaction, { attempted: 1, completed: 1, failed: 0 })
    const telemetry = JSON.stringify(route.stats)
    for (const secret of ['private-address', 'another-address', 'signed-bytes', 'arbitrary-private-string', 'secret-bytes']) {
      assert.equal(telemetry.includes(secret), false)
    }
  } finally { route.close() }
})

test('late startup from a replaced worker cannot read through its replacement', async () => {
  let releaseOldWorker: () => void = () => {}
  let workers = 0
  let requests = 0
  const oldReady = new Promise<void>((resolve) => { releaseOldWorker = resolve })
  const route = new PrivateRpc(() => ({
    ready: ++workers === 1 ? oldReady : Promise.resolve(), close() {},
    async fetch(_url, init) { requests++; return rpcReply(String(init.body)) },
  }))
  const oldStartup = route.connect().then(() => null, (error: unknown) => error)
  try {
    await route.reconnect()
    assert.equal(requests, 2)
    releaseOldWorker()
    assert.match(String(await oldStartup), /connection was replaced/)
    assert.equal(requests, 2)
    assert.equal(route.status, 'ready')
  } finally { releaseOldWorker(); await oldStartup; route.close() }
})

test('late reply cannot update wallet reads after a concurrent request stops the route', async () => {
  let releaseReply: () => void = () => {}
  const delayed = new Promise<void>((resolve) => { releaseReply = resolve })
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {},
    async fetch(_url, init) {
      const body = String(init.body)
      const { method } = JSON.parse(body)
      if (method === 'eth_getBalance') await delayed
      if (method === 'eth_call') throw new Error('worker disconnected')
      return rpcReply(body)
    },
  }))
  try {
    await route.connect()
    const pending = route.fetchRpc('{"id":3,"method":"eth_getBalance"}').then(() => null, (error: unknown) => error)
    await assert.rejects(route.fetchRpc('{"id":4,"method":"eth_call"}'), /worker disconnected/)
    releaseReply()
    assert.match(String(await pending), /route stopped before the response/)
    assert.equal(route.status, 'degraded')
    assert.equal(route.stats.completed, 2)
  } finally { releaseReply(); route.close() }
})
