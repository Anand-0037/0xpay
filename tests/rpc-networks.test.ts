import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOutgoingRequest } from '../src/net/network-guard.ts'
import { PRIVACY_NETWORKS, privacyNetworkFromSearch, workerBootstrapParams, type PrivacyNetwork } from '../src/rpc/networks.ts'
import { APP_RPC_URL, PrivateRpc } from '../src/rpc.ts'

const origin = 'https://wallet.example'
const lookup = (network: PrivacyNetwork, selector = '0x3898587d') => ({
  method: 'eth_call', params: [{ to: PRIVACY_NETWORKS[network].specifier, data: selector }, 'latest'],
})
const envelope = (network: PrivacyNetwork) => ({ jsonrpc: '2.0', id: 3, ...lookup(network) })
const classify = (url: string, body: unknown, network: PrivacyNetwork) =>
  classifyOutgoingRequest(url, 'POST', JSON.stringify(body), origin, new Set(), false, network)

test('the app network choice defaults to Nox; Nym requires explicit selection', () => {
  assert.equal(privacyNetworkFromSearch(''), 'nox')
  assert.equal(privacyNetworkFromSearch('?view=wallet'), 'nox')
  assert.equal(privacyNetworkFromSearch('?network=nym&view=wallet'), 'nym')
  assert.equal(privacyNetworkFromSearch('?network=nox'), 'nox')
  assert.equal(privacyNetworkFromSearch('?network=unknown'), 'nox')
})

for (const network of ['nym', 'nox'] as const) {
  test(`${network} direct bootstrap is pinned to one URL, one contract and two exact selectors`, () => {
    const config = PRIVACY_NETWORKS[network]
    const other = network === 'nym' ? 'nox' : 'nym'
    for (const selector of ['0x3898587d', '0x1c67ff29']) {
      const payload = { jsonrpc: '2.0', id: 3, ...lookup(network, selector) }
      assert.equal(classify(config.bootstrapRpc, payload, network), 'bootstrap')
      assert.equal(classify(PRIVACY_NETWORKS[other].bootstrapRpc, payload, network), 'blocked')
    }
    assert.equal(classify(config.bootstrapRpc, envelope(other), network), 'blocked')
    for (const method of ['eth_getBalance', 'eth_call', 'eth_sendRawTransaction']) {
      assert.equal(classify(APP_RPC_URL, { jsonrpc: '2.0', id: 1, method, params: ['0xuser-address'] }, network), 'blocked')
    }
    for (const suffix of ['?account=0xabc', '#account', '/extra']) {
      assert.equal(classify(`${config.bootstrapRpc}${suffix}`, envelope(network), network), 'blocked')
    }
    const credentialUrl = config.bootstrapRpc.replace('https://', 'https://user:password@')
    assert.equal(classify(credentialUrl, envelope(network), network), 'blocked')
  })

  test(`${network} rejects extra call, parameter and envelope fields without forwarding data`, () => {
    const body = envelope(network)
    const call = body.params[0] as { to: string; data: string }
    const url = PRIVACY_NETWORKS[network].bootstrapRpc
    for (const mutation of [
      { ...body, params: [{ ...call, from: '0xprivate-user' }, 'latest'] },
      { ...body, params: [{ ...call, value: '0x1' }, 'latest'] },
      { ...body, params: [{ ...call, data: `${call.data}00` }, 'latest'] },
      { ...body, params: [call, 'latest', { user: 'private' }] },
      { ...body, params: [call, 'pending'] },
      { ...body, id: 'private-id' },
      { ...body, id: 1.5 },
      { ...body, id: -1 },
      { ...body, id: undefined },
      { ...body, user: 'private' },
      { ...body, jsonrpc: '1.0' },
      [body],
    ]) assert.equal(classify(url, mutation, network), 'blocked')
    assert.equal(workerBootstrapParams({ ...lookup(network), id: 'private' }, network), null)
    assert.equal(workerBootstrapParams(lookup(network), network)?.[0].to, PRIVACY_NETWORKS[network].specifier)
  })
}

test('both explicit workers retain private fetch routing and generation safety without direct fallback', async () => {
  const oldFetch = globalThis.fetch
  let direct = 0
  globalThis.fetch = async () => { direct++; throw new Error('Direct request forbidden') }
  try {
    for (const network of ['nym', 'nox'] as const) {
      let workers = 0
      const route = new PrivateRpc(() => {
        workers++
        return { ready: Promise.resolve(), close() {}, async fetch(url, init) {
          assert.equal(url, APP_RPC_URL)
          const request = JSON.parse(String(init.body))
          return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0xaa36a7' : '0x123' })
        } }
      }, network)
      try {
        assert.equal(route.network, network)
        await route.connect()
        route.disconnect()
        await assert.rejects(route.fetchRpc('{"method":"eth_getBalance"}'), /reconnecting/)
        await route.reconnect()
        assert.equal(workers, 2)
        assert.equal(route.status, 'ready')
      } finally { route.close() }
    }
    assert.equal(direct, 0)
  } finally { globalThis.fetch = oldFetch }
})
