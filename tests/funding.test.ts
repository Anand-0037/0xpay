import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HDNodeWallet, Transaction, keccak256, Interface, ZeroAddress, ZeroHash } from 'ethers'
import 'fake-indexeddb/auto'
import Level from 'level-js'
import { ArtifactStore, startRailgunEngine, stopRailgunEngine } from '@railgun-community/wallet'
import { ABIRailgunSmartWallet } from '@railgun-community/engine'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { PrivateRpc, APP_RPC_URL } from '../src/rpc.ts'
import { bindEthersToPrivateRoute, unbindEthersRoute } from '../src/rpc/ethers-transport.ts'
import { broadcastLocalTransaction, rebroadcastFundingTransaction } from '../src/wallet/funding.ts'
import { findTransaction, recordSignedTransaction, markTransaction } from '../src/domain/tx-journal.ts'
import { createLocalWallet, confirmWalletBackup, lockLocalWallet, unlockLocalWallet, unlockedFundingWallet, unlockedSessionVersion } from '../src/wallet/lifecycle.ts'

const sepolia = NETWORK_CONFIG[NetworkName.EthereumSepolia]
// ABI-valid transport fixture, not a valid ZK proof and never sent to a real node.
const privateSendData = new Interface(ABIRailgunSmartWallet).encodeFunctionData('transact', [[{
  proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
  merkleRoot: ZeroHash, nullifiers: [ZeroHash], commitments: [ZeroHash],
  boundParams: { treeNumber: 0, minGasPrice: 0, unshield: 0, chainID: 11155111,
    adaptContract: ZeroAddress, adaptParams: ZeroHash, commitmentCiphertext: [{
      ciphertext: [ZeroHash, ZeroHash, ZeroHash, ZeroHash], blindedSenderViewingKey: ZeroHash,
      blindedReceiverViewingKey: ZeroHash, annotationData: '0x', memo: '0x',
    }] },
  unshieldPreimage: { npk: ZeroHash, token: { tokenType: 0, tokenAddress: ZeroAddress, tokenSubID: 0 }, value: 0 },
}]])

test('built-in wallet broadcasts signed Sepolia bytes only through the private worker', async () => {
  const wallet = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk')
  const original = globalThis.fetch
  let direct = 0
  const broadcasts: string[] = []
  let loseBroadcastResponse = false
  const records = new Map<string, string>()
  const storage = { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) } }
  const persist = (_hash: string, signed: string) => { recordSignedTransaction('send', signed, wallet.address, storage) }
  globalThis.fetch = async () => { direct++; throw new Error('Direct fetch forbidden') }
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {}, async fetch(url, init) {
    assert.equal(url, APP_RPC_URL)
    const parsed = JSON.parse(await new Response(init.body).text())
    const reply = (request: { id: number; method: string; params: string[] }) => {
      let result: string
      if (request.method === 'eth_sendRawTransaction') {
        assert.equal(findTransaction(keccak256(request.params[0]), storage)?.status, 'submitted')
        broadcasts.push(request.params[0])
        if (loseBroadcastResponse) throw new Error('Reply lost after node accepted transaction')
        result = keccak256(request.params[0])
      } else if (request.method === 'eth_chainId') result = '0xaa36a7'
      else if (request.method === 'eth_blockNumber') result = '0xabc123'
      else throw new Error(`Unexpected method ${request.method}`)
      return { jsonrpc: '2.0', id: request.id, result }
    }
    return Response.json(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed))
  } }))
  try {
    await route.connect()
    bindEthersToPrivateRoute(route)
    const transaction = { to: sepolia.proxyContract, data: privateSendData, value: 0n, nonce: 0, gasLimit: 1_000_000n, type: 2,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, chainId: 11155111 }
    const response = await broadcastLocalTransaction(wallet, transaction, () => {}, persist)
    assert.equal(response.hash, keccak256(broadcasts[0]))
    assert.equal(Transaction.from(broadcasts[0]).from, wallet.address)
    assert.equal(Transaction.from(broadcasts[0]).chainId, 11155111n)
    assert.equal(direct, 0)
    let checks = 0
    await assert.rejects(broadcastLocalTransaction(wallet, transaction, () => {
      if (++checks === 2) throw new Error('Wallet locked during preparation')
    }, persist), /Wallet locked/)
    assert.equal(broadcasts.length, 1)
    await assert.rejects(broadcastLocalTransaction(wallet, transaction, () => {}, () => {
      throw new Error('Storage denied')
    }), /Storage denied/)
    assert.equal(broadcasts.length, 1)
    const active = broadcastLocalTransaction(wallet, transaction, () => {}, persist)
    await assert.rejects(broadcastLocalTransaction(wallet, transaction, () => {}, persist), /already being prepared/)
    await active
    assert.equal(broadcasts.length, 2)
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
        request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) => callback(null),
      } } })
      await assert.rejects(broadcastLocalTransaction(wallet, transaction, () => {}, persist), /busy in another tab/)
      assert.equal(broadcasts.length, 2)
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
    loseBroadcastResponse = true
    const uncertain = await broadcastLocalTransaction(wallet, transaction, () => {}, persist)
    assert.equal(uncertain.broadcastUnknown, true)
    assert.equal(uncertain.hash, keccak256(broadcasts[2]))
    assert.equal(broadcasts.length, 3)
    route.close()
    await assert.rejects(broadcastLocalTransaction(wallet, transaction, () => {}, persist), /Private route is unavailable/)
    assert.equal(broadcasts.length, 3)
  } finally { unbindEthersRoute(route); route.close(); globalThis.fetch = original }
})

test('reload recovery rebroadcasts identical saved bytes and checks receipts before retrying', { timeout: 60_000 }, async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const records = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value) },
    removeItem: (key: string) => { records.delete(key) },
  } })
  const artifacts = new ArtifactStore(async () => null, async () => { throw new Error('No artifacts required') }, async () => false)
  const start = () => startRailgunEngine('0xpayfundingtest', new Level('0xpay-funding-reload'), false, artifacts, false, false, [])
  const broadcasts: string[] = []
  let receiptStatus: null | 0 | 1 = null
  let activeHash = ''
  let receiptHashOverride: string | undefined
  let address = ''
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {}, async fetch(_url, init) {
    const parsed = JSON.parse(await new Response(init.body).text())
    const reply = (request: { id: number; method: string; params: string[] }) => {
      let result: unknown
      if (request.method === 'eth_chainId') result = '0xaa36a7'
      else if (request.method === 'eth_blockNumber') result = '0xabc123'
      else if (request.method === 'eth_getTransactionReceipt') result = receiptStatus === null ? null : {
        transactionHash: receiptHashOverride ?? activeHash, transactionIndex: '0x0', blockHash: `0x${'12'.repeat(32)}`, blockNumber: '0xabc123',
        from: address, to: sepolia.proxyContract, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
        logsBloom: `0x${'00'.repeat(256)}`, logs: [], status: `0x${receiptStatus}`, type: '0x2', effectiveGasPrice: '0x1',
      }
      else if (request.method === 'eth_sendRawTransaction') { broadcasts.push(request.params[0]); result = keccak256(request.params[0]) }
      else throw new Error(`Unexpected method ${request.method}`)
      return { jsonrpc: '2.0', id: request.id, result }
    }
    return Response.json(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed))
  } }))
  try {
    await start()
    const created = await createLocalWallet('disposable-test-password', 12_000_000)
    confirmWalletBackup(created.session.id)
    address = created.session.publicAddress
    const tx = { to: sepolia.proxyContract, data: privateSendData, value: 0n, nonce: 3, gasLimit: 1_000_000n, type: 2,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, chainId: 11155111 }
    const raw = await unlockedFundingWallet().signTransaction(tx)
    const saved = recordSignedTransaction('send', raw, address)
    activeHash = saved.hash
    // Model reload after write-ahead persistence but before the first network broadcast.
    await lockLocalWallet()
    await stopRailgunEngine()
    await start()
    const restored = await unlockLocalWallet('disposable-test-password')
    await route.connect()
    bindEthersToPrivateRoute(route)
    const version = unlockedSessionVersion()
    const outcome = await rebroadcastFundingTransaction(saved.hash, restored.id, version)
    assert.equal(outcome.broadcastUnknown, false)
    assert.deepEqual(broadcasts, [raw])
    markTransaction(saved.hash, 'confirmed')
    await assert.rejects(rebroadcastFundingTransaction(saved.hash, restored.id, version), /Completed/)
    assert.equal(broadcasts.length, 1)
    for (const status of [1, 0] as const) {
      const nextRaw = await unlockedFundingWallet().signTransaction({ ...tx, nonce: 4 + status })
      const next = recordSignedTransaction('send', nextRaw, address)
      activeHash = next.hash
      receiptStatus = status
      receiptHashOverride = `0x${'56'.repeat(32)}`
      await assert.rejects(rebroadcastFundingTransaction(next.hash, restored.id, version), /Receipt does not match/)
      assert.equal(findTransaction(next.hash)?.status, 'submitted')
      assert.equal(broadcasts.length, 1)
      receiptHashOverride = undefined
      const alreadyIncluded = await rebroadcastFundingTransaction(next.hash, restored.id, version)
      assert.equal(alreadyIncluded.receiptStatus, status === 1 ? 'confirmed' : 'reverted')
      assert.equal(findTransaction(next.hash)?.status, status === 1 ? 'confirmed' : 'reverted')
      assert.equal(broadcasts.length, 1)
      await assert.rejects(rebroadcastFundingTransaction(next.hash, restored.id, version), /Completed/)
    }
  } finally {
    unbindEthersRoute(route); route.close()
    await lockLocalWallet(); await stopRailgunEngine()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
