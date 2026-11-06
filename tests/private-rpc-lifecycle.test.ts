import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { PrivateRpc, PrivateRpcLifecycleError } from '../src/rpc.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type Call = { method: string; id: number; signal?: AbortSignal | null }
function stub(ready: Promise<unknown> = Promise.resolve(), reply?: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const value = {
    ready, calls, closes: 0,
    async fetch(_url: string, init: RequestInit) {
      assert.equal(typeof init.body, 'string')
      const request = JSON.parse(init.body as string) as { method: string; id: number }
      const call = { ...request, signal: init.signal }; calls.push(call)
      return reply ? reply(call) : response(call)
    },
    close() { value.closes++ },
  }
  return value
}
function response(call: Call) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? '0x539' : '0x123' }))
}
function setup(t: TestContext, workers: ReturnType<typeof stub>[]) {
  const direct = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No direct RPC is allowed') })
  let created = 0
  const route = new PrivateRpc(() => {
    const worker = workers[created++]
    if (!worker) throw new Error('Unexpected additional worker')
    return worker
  }, 'nox', 'devnet')
  t.after(() => { route.close(); assert.equal(direct.mock.calls.length, 0) })
  return { route, created: () => created }
}
const body = JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'eth_getBalance', params: [] })
const lifecycle = (reason: PrivateRpcLifecycleError['reason']) => (error: unknown) => error instanceof PrivateRpcLifecycleError && error.reason === reason
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('concurrent connect callers share one readiness and chain-health attempt', async t => {
  const ready = deferred<void>(), worker = stub(ready.promise)
  const { route, created } = setup(t, [worker])
  const first = route.connect(), second = route.connect()
  assert.equal(first, second)
  ready.resolve()
  assert.deepEqual(await first, { chainId: '0x539', blockNumber: 0x123 })
  assert.deepEqual(await second, await first)
  assert.equal(created(), 1)
  assert.deepEqual(worker.calls.map(call => call.method), ['eth_chainId', 'eth_blockNumber'])
})

test('double reconnect shares its replacement rather than closing the new worker', async t => {
  const ready = deferred<void>(), original = stub(), replacement = stub(ready.promise)
  const { route, created } = setup(t, [original, replacement])
  await route.connect()
  const first = route.reconnect(), second = route.reconnect()
  assert.equal(first, second)
  assert.equal(created(), 2)
  assert.equal(original.closes, 1)
  assert.equal(replacement.closes, 0)
  ready.resolve(); await first
  assert.equal(route.status, 'ready')
})

test('replacing a worker cancels its unresolved startup and ignores late readiness', async t => {
  const oldReady = deferred<void>(), original = stub(oldReady.promise), replacement = stub()
  const { route } = setup(t, [original, replacement])
  const first = route.connect()
  const rejected = assert.rejects(first, lifecycle('replaced'))
  await route.reconnect(); await rejected
  oldReady.resolve(); await flush()
  assert.equal(original.calls.length, 0)
  assert.equal(original.closes, 1)
  assert.equal(route.status, 'ready')
  assert.equal(route.failure, null)
})

test('disconnect settles an unresolved startup without waiting for its timeout', async t => {
  const worker = stub(deferred<void>().promise)
  const { route } = setup(t, [worker])
  const connecting = route.connect()
  const rejected = assert.rejects(connecting, lifecycle('disconnected'))
  route.disconnect(); await rejected
  assert.equal(route.status, 'degraded')
  assert.equal(route.failure, null)
  assert.equal(worker.closes, 1)
  assert.equal(worker.calls.length, 0)
  await assert.rejects(route.connect(), /needs reconnecting/)
})

test('disconnect aborts in-flight requests even when the worker ignores the signal', async t => {
  const pending = deferred<Response>()
  const worker = stub(Promise.resolve(), call => call.method === 'eth_getBalance' ? pending.promise : response(call))
  const { route } = setup(t, [worker])
  await route.connect()
  const request = route.fetchRpc(body)
  const rejected = assert.rejects(request, lifecycle('disconnected'))
  route.disconnect(); await rejected
  assert.equal(worker.calls.at(-1)?.signal?.aborted, true)
  pending.resolve(new Response('late response')); await flush()
  assert.equal(route.status, 'degraded')
  assert.equal(route.stats.completed, 2)
  assert.equal(route.stats.failed, 1)
  assert.equal(route.failure, null)
})

test('late failures from a replaced worker cannot degrade the healthy replacement', async t => {
  const late = deferred<Response>()
  const original = stub(Promise.resolve(), call => call.method === 'eth_getBalance' ? late.promise : response(call))
  const replacement = stub()
  const { route } = setup(t, [original, replacement])
  await route.connect()
  const request = route.fetchRpc(body)
  const rejected = assert.rejects(request, lifecycle('replaced'))
  await route.reconnect(); await rejected
  late.resolve(new Response('stale server failure', { status: 503 })); await flush()
  assert.equal(route.status, 'ready')
  assert.equal(route.failure, null)
  assert.equal(route.stats.completed, 4)
})

test('remote HTTP failure stops the entire generation, then explicit reconnect recovers', async t => {
  const pending = deferred<Response>()
  const original = stub(Promise.resolve(), call => call.method === 'eth_getBalance' ? pending.promise : call.method === 'eth_getCode' ? new Response('upstream failure', { status: 503 }) : response(call))
  const replacement = stub()
  const { route } = setup(t, [original, replacement])
  await route.connect()
  const earlier = route.fetchRpc(body)
  const earlierRejected = assert.rejects(earlier, /HTTP 503/)
  await assert.rejects(route.fetchRpc(JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'eth_getCode', params: [] })), /HTTP 503/)
  await earlierRejected
  assert.equal(route.status, 'degraded')
  assert.deepEqual(route.failure, { kind: 'http', message: 'Private RPC returned HTTP 503', httpStatus: 503 })
  assert.equal(original.calls.at(-2)?.signal?.aborted, true)
  const before = original.calls.length
  await assert.rejects(route.fetchRpc(body), /needs reconnecting/)
  assert.equal(original.calls.length, before)
  await route.reconnect()
  assert.equal(route.status, 'ready')
  assert.equal(route.failure, null)
})

test('ordinary JSON-RPC application errors do not destroy a working private transport', async t => {
  const worker = stub(Promise.resolve(), call => call.method === 'eth_getBalance'
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'controlled application rejection' } })) : response(call))
  const { route } = setup(t, [worker])
  await route.connect()
  const result = await route.fetchRpc(body)
  assert.equal((await result.json()).error.code, -32000)
  assert.equal(route.status, 'ready')
  assert.equal(route.failure, null)
  assert.equal(route.stats.failed, 0)
})

test('an unapproved destination is rejected before any I/O without poisoning the worker', async t => {
  const worker = stub(), { route } = setup(t, [worker])
  await route.connect()
  await assert.rejects(route.fetchRpc(body, 'https://unapproved.example'), /Unapproved worker RPC target/)
  assert.equal(worker.calls.length, 2)
  assert.equal(route.status, 'ready')
  await route.fetchRpc(body)
  assert.equal(worker.calls.length, 3)
})

test('a read timeout aborts its signal and blocks additional I/O until explicit reconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const worker = stub(Promise.resolve(), call => call.method === 'eth_getBalance' ? deferred<Response>().promise : response(call))
  const { route } = setup(t, [worker])
  await route.connect()
  const request = route.fetchRpc(body)
  const rejected = assert.rejects(request, /timed out/)
  t.mock.timers.tick(60_000); await rejected
  assert.equal(worker.calls.at(-1)?.signal?.aborted, true)
  assert.equal(route.status, 'degraded')
  assert.equal(route.failure?.kind, 'request-timeout')
  const before = worker.calls.length
  await assert.rejects(route.fetchRpc(body), /needs reconnecting/)
  assert.equal(worker.calls.length, before)
})

test('the connection deadline includes chain-health reads after slow worker readiness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ready = deferred<void>(), chainRead = deferred<Response>()
  const worker = stub(ready.promise, () => chainRead.promise)
  const { route } = setup(t, [worker])
  const connecting = route.connect()
  const rejected = assert.rejects(connecting, /connection timed out/)
  t.mock.timers.tick(80_000); ready.resolve(); await flush()
  assert.equal(worker.calls.length, 1)
  t.mock.timers.tick(10_000); await rejected
  assert.equal(route.status, 'failed')
  assert.equal(route.failure?.kind, 'connect-timeout')
  assert.equal(worker.calls[0].signal?.aborted, true)
  assert.equal(worker.closes, 1)
})

test('close cancels in-flight work and cannot be reopened', async t => {
  const worker = stub(deferred<void>().promise)
  const { route } = setup(t, [worker])
  const connecting = route.connect()
  const rejected = assert.rejects(connecting, lifecycle('closed'))
  route.close(); await rejected
  assert.equal(route.status, 'closed')
  await assert.rejects(route.connect(), lifecycle('closed'))
  await assert.rejects(route.reconnect(), lifecycle('closed'))
  assert.equal(worker.closes, 1)
})

test('a replacement factory failure is reported and a later explicit reconnect can recover', async t => {
  const original = stub(), replacement = stub()
  let created = 0
  const direct = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Direct RPC forbidden') })
  const route = new PrivateRpc(() => {
    created++
    if (created === 2) throw new Error('controlled worker factory failure')
    return created === 1 ? original : replacement
  }, 'nox', 'devnet')
  t.after(() => { route.close(); assert.equal(direct.mock.calls.length, 0) })
  await route.connect()
  await assert.rejects(route.reconnect(), /factory failure/)
  assert.equal(route.status, 'failed')
  assert.equal(route.failure?.kind, 'worker')
  await route.reconnect()
  assert.equal(route.status, 'ready')
  assert.equal(created, 3)
})

test('an unsafe block quantity fails connection validation rather than rounding wallet state', async t => {
  const worker = stub(Promise.resolve(), call => call.method === 'eth_blockNumber'
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: '0x20000000000000' })) : response(call))
  const { route } = setup(t, [worker])
  await assert.rejects(route.connect(), /unsafe block number/)
  assert.equal(route.status, 'failed')
  assert.equal(route.failure?.kind, 'protocol')
  assert.equal(worker.closes, 1)
  await assert.rejects(route.fetchRpc(body), /needs reconnecting/)
})

test('failed cleanup does not spawn another worker and can be retried explicitly', async t => {
  const original = stub(), replacement = stub()
  original.close = () => {
    original.closes++
    if (original.closes === 1) throw new Error('controlled cleanup failure')
  }
  const { route, created } = setup(t, [original, replacement])
  await route.connect()
  await assert.rejects(route.reconnect(), /cleanup failed/)
  assert.equal(route.status, 'failed')
  assert.equal(created(), 1)
  await route.reconnect()
  assert.equal(created(), 2)
  assert.equal(original.closes, 2)
  assert.equal(route.status, 'ready')
})
