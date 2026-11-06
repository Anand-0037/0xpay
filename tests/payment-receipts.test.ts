import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { PrivateRpc } from '../src/rpc.ts'
import { bindEthersToPrivateRoute, unbindEthersRoute } from '../src/rpc/ethers-transport.ts'
import { confirmEthShield } from '../src/railgun/shield.ts'
import { confirmPrivateWethSend } from '../src/railgun/send.ts'
import { findTransaction, recordSubmitted, unresolvedFundingTransaction } from '../src/domain/tx-journal.ts'

test('wrong-hash receipts with matching sender and contract cannot release either payment gate', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const records = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) },
  } })
  const from = `0x${'34'.repeat(20)}`
  const wrongHash = `0x${'56'.repeat(32)}`
  let target = NETWORK_CONFIG[NetworkName.EthereumSepolia].relayAdaptContract
  let returnedHash = wrongHash
  let status: string | null = '0x1'
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {}, async fetch(_url, init) {
    const parsed = JSON.parse(await new Response(init.body).text())
    const reply = (request: { id: number; method: string }) => {
      const result = request.method === 'eth_chainId' ? '0xaa36a7' : request.method === 'eth_blockNumber' ? '0xabc123' : {
        transactionHash: returnedHash, transactionIndex: '0x0', blockHash: `0x${'78'.repeat(32)}`, blockNumber: '0xabc123',
        from, to: target, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
        logsBloom: `0x${'00'.repeat(256)}`, logs: [], status, type: '0x2', effectiveGasPrice: '0x1',
      }
      return { jsonrpc: '2.0', id: request.id, result }
    }
    return Response.json(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed))
  } }))
  try {
    await route.connect()
    bindEthersToPrivateRoute(route)
    for (const kind of ['shield', 'send'] as const) {
      records.clear()
      const hash = `0x${kind === 'shield' ? '12'.repeat(32) : '90'.repeat(32)}`
      target = kind === 'shield' ? NETWORK_CONFIG[NetworkName.EthereumSepolia].relayAdaptContract : NETWORK_CONFIG[NetworkName.EthereumSepolia].proxyContract
      recordSubmitted(kind, hash, from)
      const confirm = kind === 'shield' ? confirmEthShield : confirmPrivateWethSend
      returnedHash = wrongHash
      status = '0x1'
      assert.equal((await confirm(hash)).status, 'unknown')
      assert.equal(findTransaction(hash)?.status, 'submitted')
      assert.equal(unresolvedFundingTransaction(from)?.hash, hash)
      returnedHash = hash
      status = null
      assert.equal((await confirm(hash)).status, 'unknown')
      assert.equal(unresolvedFundingTransaction(from)?.hash, hash)
      status = '0x1'
      assert.equal((await confirm(hash)).status, 'confirmed')
      assert.equal(unresolvedFundingTransaction(from), undefined)
    }
  } finally {
    unbindEthersRoute(route); route.close()
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
