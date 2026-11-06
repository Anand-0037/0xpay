import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectQuery, parseLookup, type RpcRead } from '../src/inspector/inspect.ts'

const address = '0x' + 'a'.repeat(40)
const hash = '0x' + 'b'.repeat(64)

test('accepts only exact address or transaction hash', () => {
  assert.equal(parseLookup('  ' + address + ' ').kind, 'account')
  assert.equal(parseLookup(hash).kind, 'transaction')
  for (const value of ['', '0x1234', 'https://explorer.example/' + hash, address + 'x']) assert.throws(() => parseLookup(value))
})

test('account lookup checks chain and uses one block tag', async () => {
  const calls: { method: string; params: unknown[] }[] = []
  const read: RpcRead = async (method, params) => {
    calls.push({ method, params })
    return ({ eth_chainId: '0x539', eth_blockNumber: '0x10', eth_getBalance: '0x64', eth_getTransactionCount: '0x2' } as Record<string, string>)[method]
  }
  assert.deepEqual(await inspectQuery(address, read), { kind: 'account', address, chainId: 1337, observedBlock: 16n, balanceWei: 100n, nonce: 2n })
  assert.deepEqual(calls, [
    { method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] },
    { method: 'eth_getBalance', params: [address, '0x10'] }, { method: 'eth_getTransactionCount', params: [address, '0x10'] },
  ])
})

test('wrong chain stops before querying an address', async () => {
  const calls: string[] = []
  const read: RpcRead = async method => { calls.push(method); return '0x1' }
  await assert.rejects(inspectQuery(address, read), /Wrong network/)
  assert.deepEqual(calls, ['eth_chainId'])
})

test('receipt distinguishes included, failed, pending and unknown', async () => {
  for (const [transaction, receipt, outcome] of [
    [{ hash }, { transactionHash: hash, blockNumber: '0x12', status: '0x1' }, 'included'],
    [{ hash }, { transactionHash: hash, blockNumber: '0x12', status: '0x0' }, 'failed'],
    [{ hash }, null, 'pending'],
    [null, null, 'not-found'],
  ] as const) {
    const read: RpcRead = async method => ({ eth_chainId: '0x539', eth_blockNumber: '0x13', eth_getTransactionByHash: transaction, eth_getTransactionReceipt: receipt } as Record<string, unknown>)[method]
    const answer = await inspectQuery(hash, read)
    assert.equal(answer.kind, 'transaction')
    if (answer.kind === 'transaction') assert.equal(answer.outcome, outcome)
  }
})

test('rejects a mismatched receipt and malformed RPC quantity', async () => {
  const mismatched: RpcRead = async method => ({ eth_chainId: '0x539', eth_blockNumber: '0x13', eth_getTransactionByHash: null, eth_getTransactionReceipt: { transactionHash: address, status: '0x1', blockNumber: '0x12' } } as Record<string, unknown>)[method]
  await assert.rejects(inspectQuery(hash, mismatched), /another transaction/)
  const wrongTransaction: RpcRead = async method => ({ eth_chainId: '0x539', eth_blockNumber: '0x13', eth_getTransactionByHash: { hash: address }, eth_getTransactionReceipt: null } as Record<string, unknown>)[method]
  await assert.rejects(inspectQuery(hash, wrongTransaction), /another transaction/)
  const malformed: RpcRead = async method => ({ eth_chainId: '0x539', eth_blockNumber: '13' } as Record<string, unknown>)[method]
  await assert.rejects(inspectQuery(address, malformed), /Invalid block number/)
})


test('shows native ETH transfers only when the devnet receipt reports the system event', async () => {
  const pool = '0xf409d9a52cd9b8c61a44cc8c9cdef0d85b58259c'
  const recipient = '0x7e7df472ce15a4d847b20d085e89b708c9f4133d'
  const event = {
    address: '0xfffffffffffffffffffffffffffffffffffffffe',
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + pool.slice(2).padStart(64, '0'),
      '0x' + recipient.slice(2).padStart(64, '0'),
    ],
    data: '0x00000000000000000000000000000000000000000000000001558ed214b4c000',
  }
  const read: RpcRead = async method => ({
    eth_chainId: '0x539', eth_blockNumber: '0x1200',
    eth_getTransactionByHash: { hash },
    eth_getTransactionReceipt: { transactionHash: hash, blockNumber: '0x1122', status: '0x1', logs: [event] },
  } as Record<string, unknown>)[method]
  const answer = await inspectQuery(hash, read)
  assert.equal(answer.kind, 'transaction')
  if (answer.kind === 'transaction') assert.deepEqual(answer.nativeTransfers, [{ from: pool, to: recipient, amountWei: 96_140_000_000_000_000n }])
})
