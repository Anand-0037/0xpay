import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOutgoingRequest, installNetworkGuard, setWorkerBundleResolvers, trafficSnapshot } from '../src/net/network-guard.ts'

const origin = 'https://wallet.example'
const rpc = 'https://ethereum-sepolia-rpc.publicnode.com'
const bootstrap = 'https://ethereum-rpc.publicnode.com'
const specifier = '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0'
const safeBootstrap = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: specifier, data: '0x1c67ff29' }, 'latest'] })

test('direct application RPC and unknown hosts are blocked', () => {
  assert.equal(classifyOutgoingRequest(rpc, 'POST', '{}', origin), 'blocked')
  assert.equal(classifyOutgoingRequest('https://wallet.example.evil.test/', 'GET', null, origin), 'blocked')
  assert.equal(classifyOutgoingRequest('https://unknown.example/', 'GET', null, origin), 'blocked')
})

test('bootstrap permits only the worker-specifier lookup', () => {
  assert.equal(classifyOutgoingRequest(bootstrap, 'POST', safeBootstrap, origin), 'bootstrap')
  assert.equal(classifyOutgoingRequest(bootstrap, 'POST', JSON.stringify({ method: 'eth_getBalance', params: [specifier, 'latest'] }), origin), 'blocked')
  assert.equal(classifyOutgoingRequest(bootstrap, 'GET', safeBootstrap, origin), 'blocked')
})

test('approved bundle URL must match exactly and use GET', () => {
  const url = 'https://worker.example/bundle.js'
  setWorkerBundleResolvers([url])
  assert.equal(classifyOutgoingRequest(url, 'GET', null, origin), 'worker-bundle')
  assert.equal(classifyOutgoingRequest(`${url}?address=0x123`, 'GET', null, origin), 'blocked')
  assert.equal(classifyOutgoingRequest(url, 'POST', null, origin), 'blocked')
  setWorkerBundleResolvers([])
})

test('lending blocks payment-only services; only the explicit wallet entry permits them', () => {
  const destinations = [
    ['https://ppoi.fdi.network/', 'POST', 'poi'],
    ['https://ipfs-lb.com/ipfs/public-proof-file', 'GET', 'artifacts'],
    ['https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql', 'POST', 'indexer'],
  ] as const
  for (const [url, method, kind] of destinations) {
    assert.equal(classifyOutgoingRequest(url, method, '{}', origin), 'blocked')
    assert.equal(classifyOutgoingRequest(url, method, '{}', origin, new Set(), true), kind)
  }
})

test('guard never sends a direct app RPC request', async () => {
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  const calls: Array<RequestInit | undefined> = []
  Object.assign(globalThis, { window: { location: new URL(origin) }, fetch: async (_input: RequestInfo | URL, init?: RequestInit) => { calls.push(init); return new Response('ok') } })
  try {
    installNetworkGuard()
    await assert.rejects(fetch(rpc, { method: 'POST', body: '{}' }), /blocked/)
    assert.equal(calls.length, 0)
    assert.equal(trafficSnapshot().recent[0].host, 'ethereum-sepolia-rpc.publicnode.com')
    assert.equal(trafficSnapshot().recent[0].kind, 'blocked')
    const bundle = 'https://worker.example/bundle.js'
    setWorkerBundleResolvers([bundle])
    await fetch(bundle)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.redirect, 'error')
  } finally {
    setWorkerBundleResolvers([])
    Object.assign(globalThis, { window: oldWindow, fetch: oldFetch })
  }
})
