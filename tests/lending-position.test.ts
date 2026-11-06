import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Interface, ZeroAddress } from 'ethers'
import { PrivateRpc, APP_RPC_URL } from '../src/rpc.ts'
import { AAVE_SEPOLIA, readLendingPosition, modelPosition, formatBaseUsd, formatHealthFactor } from '../src/lending/position.ts'

const account = '0x7a3db09ccf7cfb619cdbff6ade911498d5a022c6'
const pool = new Interface([
  'function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)',
  'function ADDRESSES_PROVIDER() view returns(address)',
])
const provider = new Interface(['function getPool() view returns(address)', 'function getPriceOracle() view returns(address)'])
const oracle = new Interface(['function BASE_CURRENCY() view returns(address)', 'function BASE_CURRENCY_UNIT() view returns(uint256)'])
const blockTag = '0xb83c35'
const hash = `0x${'a'.repeat(64)}`
const values = [1302005922358n, 552747904700n, 478570986400n, 8191n, 7921n, 1929402249985589136n]

function fixture(options: { wrongChain?: boolean; reorg?: boolean; unit?: bigint; error?: boolean; duplicate?: boolean } = {}) {
  let blockReads = 0
  const seen: string[] = []
  const route = new PrivateRpc(() => ({ ready: Promise.resolve(), close() {}, async fetch(url, init) {
    assert.equal(url, APP_RPC_URL)
    const body = JSON.parse(await new Response(init.body).text())
    const reply = (call: { id: number; method: string; params: unknown[] }) => {
      seen.push(call.method)
      let result: unknown
      if (call.method === 'eth_chainId') result = options.wrongChain ? '0x1' : '0xaa36a7'
      else if (call.method === 'eth_blockNumber') result = blockTag
      else if (call.method === 'eth_getBlockByNumber') {
        blockReads++
        result = { number: blockTag, timestamp: '0x69000000', hash: options.reorg && blockReads > 1 ? `0x${'b'.repeat(64)}` : hash }
      } else if (call.method === 'eth_getCode') {
        assert.deepEqual(call.params, [AAVE_SEPOLIA.pool, blockTag]); result = '0x1234'
      } else if (call.method === 'eth_call') {
        assert.equal(call.params[1], blockTag)
        const { to, data } = call.params[0] as { to: string; data: string }
        if (data.startsWith('0xbf92857c')) {
          assert.equal(to, AAVE_SEPOLIA.pool)
          assert.equal(pool.decodeFunctionData('getUserAccountData', data)[0].toLowerCase(), account)
          result = pool.encodeFunctionResult('getUserAccountData', values)
        } else if (to === AAVE_SEPOLIA.pool) result = pool.encodeFunctionResult('ADDRESSES_PROVIDER', [AAVE_SEPOLIA.addressesProvider])
        else if (to === AAVE_SEPOLIA.addressesProvider) {
          const name = provider.parseTransaction({ data })!.name
          result = provider.encodeFunctionResult(name, [name === 'getPool' ? AAVE_SEPOLIA.pool : AAVE_SEPOLIA.oracle])
        } else {
          assert.equal(to, AAVE_SEPOLIA.oracle)
          const name = oracle.parseTransaction({ data })!.name
          result = oracle.encodeFunctionResult(name, [name === 'BASE_CURRENCY' ? ZeroAddress : options.unit ?? 100_000_000n])
        }
      } else throw new Error(`Unexpected RPC method ${call.method}`)
      return { jsonrpc: '2.0', id: call.id, result }
    }
    if (!Array.isArray(body)) return Response.json(reply(body))
    const answers = body.map(reply)
    if (options.error && body.some((call) => call.method === 'eth_call')) answers[0] = { jsonrpc: '2.0', id: body[0].id, error: { code: -32000 } }
    if (options.duplicate && answers.length > 1) answers[1] = answers[0]
    return Response.json(answers.reverse())
  } }))
  return { route, seen }
}

test('real lending ABI reads one consistent snapshot only through the worker, never direct fetch', async () => {
  const original = globalThis.fetch
  let direct = 0
  globalThis.fetch = async () => { direct++; throw new Error('Direct HTTP forbidden') }
  const { route, seen } = fixture()
  try {
    await route.connect()
    const result = await readLendingPosition(route, `  ${account}  `)
    assert.equal(result.collateralBase, values[0])
    assert.equal(result.debtBase, values[1])
    assert.equal(result.healthFactorWad, values[5])
    assert.equal(result.blockNumber, 12074037)
    assert.equal(result.baseCurrencyUnit, 100_000_000n)
    assert.equal(route.stats.methodCounts?.eth_getCode?.completed, 1, 'deployed-code checks count as RPC reads')
    assert.equal(seen.filter((method) => method === 'eth_call').length, 6)
    assert.equal(direct, 0)
    route.disconnect()
    const count = seen.length
    await assert.rejects(readLendingPosition(route, account), /Private connection is unavailable/)
    assert.equal(seen.length, count)
  } finally { route.close(); globalThis.fetch = original }
})

test('wrong networks, RPC errors, duplicate batch IDs, unsupported currency and reorgs fail explicitly', async () => {
  for (const [options, message] of [
    [{ wrongChain: true }, /Unexpected chain/],
    [{ error: true }, /contract read failed/],
    [{ duplicate: true }, /Invalid lending RPC/],
    [{ unit: 10n ** 18n }, /Unsupported Aave price currency/],
    [{ reorg: true }, /chain changed/],
  ] as const) {
    const { route } = fixture(options)
    try {
      if ('wrongChain' in options) await assert.rejects(route.connect(), message)
      else { await route.connect(); await assert.rejects(readLendingPosition(route, account), message) }
    } finally { route.close() }
  }
})

test('invalid or zero account is rejected before any RPC query', async () => {
  const { route, seen } = fixture()
  await route.connect()
  const count = seen.length
  try {
    await assert.rejects(readLendingPosition(route, ZeroAddress), /non-zero/)
    await assert.rejects(readLendingPosition(route, 'not-an-address'))
    assert.equal(seen.length, count)
  } finally { route.close() }
})

test('aggregate stress model preserves precision, handles no debt and rejects invalid scenarios', async () => {
  const { route } = fixture()
  await route.connect()
  try {
    const position = await readLendingPosition(route, account)
    assert.equal(modelPosition(position, { collateralDropBps: 0n, repayBase: 0n }).healthFactorWad, position.healthFactorWad)
    assert.equal(modelPosition(position, { collateralDropBps: 5000n, repayBase: 0n }).healthFactorWad, position.healthFactorWad / 2n)
    assert.equal(modelPosition(position, { collateralDropBps: 0n, repayBase: position.debtBase }).healthFactorWad, null)
    assert.equal(modelPosition({ ...position, debtBase: 0n }, { collateralDropBps: 1000n, repayBase: 0n }).healthFactorWad, null)
    assert.throws(() => modelPosition(position, { collateralDropBps: 10_001n, repayBase: 0n }), /outside/)
    assert.throws(() => modelPosition(position, { collateralDropBps: 0n, repayBase: position.debtBase + 1n }), /outside/)
    assert.equal(formatBaseUsd(1302005922358n), '$13,020.05')
    assert.equal(formatBaseUsd(1n), '$0.00')
    assert.equal(formatHealthFactor(position.healthFactorWad), '1.92')
    assert.equal(formatHealthFactor(null), 'No debt')
    assert.equal(formatHealthFactor((1n << 256n) - 1n), 'No debt')
  } finally { route.close() }
})
