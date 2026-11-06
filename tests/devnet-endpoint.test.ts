import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { MEMPOOL_RPC_URL, APP_RPC_URL, chainNetworkFromSearch } from '../src/rpc/networks.ts'

test('wallet routing and protocol metadata use the same normal mining sidecar and pool', () => {
  const wallet = JSON.parse(readFileSync(new URL('../src/pool/deployments.devnet.json', import.meta.url), 'utf8'))
  const protocol = JSON.parse(readFileSync(new URL('../protocol/deployments/devnet.json', import.meta.url), 'utf8'))
  assert.equal(wallet.mempoolRpc, MEMPOOL_RPC_URL)
  assert.equal(protocol.mempoolRpc, MEMPOOL_RPC_URL)
  assert.equal(wallet.ethrexRpc, APP_RPC_URL)
  assert.equal(protocol.pool, wallet.pool)
  assert.equal(new URL(MEMPOOL_RPC_URL).origin, new URL(APP_RPC_URL).origin)
  assert.equal(new URL(MEMPOOL_RPC_URL).pathname, '/rpc')
  assert.equal(wallet.chainId, 1337)
})

test('browser URLs cannot route a remote worker to the user loopback sidecar', () => {
  assert.equal(chainNetworkFromSearch('?chain=local'), 'devnet')
  assert.equal(chainNetworkFromSearch(''), 'devnet')
})
