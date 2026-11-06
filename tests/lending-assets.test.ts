import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Interface, ZeroAddress } from 'ethers'
import type { RouteStatus } from '../src/rpc.ts'
import { AAVE_SEPOLIA, type LendingPosition } from '../src/lending/position.ts'
import { AAVE_SEPOLIA_DATA_PROVIDER, readLendingAssets } from '../src/lending/assets.ts'

const data = new Interface([
  'function ADDRESSES_PROVIDER() view returns(address)',
  'function getAllReservesTokens() view returns(tuple(string symbol,address tokenAddress)[])',
  'function getUserReserveData(address,address) view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)',
  'function getReserveConfigurationData(address) view returns(uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)',
])
const oracle = new Interface(['function getAssetPrice(address) view returns(uint256)'])
const asset = (i: number) => `0x${i.toString(16).padStart(40, '0')}`
const position: LendingPosition = {
  account: asset(999), chainId: 11155111, blockNumber: 12074037, blockTimestamp: 1761607680,
  blockHash: `0x${'a'.repeat(64)}`, collateralBase: 1302005922358n, debtBase: 552747904700n,
  availableBorrowBase: 478570986400n, liquidationThresholdBps: 8191n, ltvBps: 7921n,
  healthFactorWad: 1929402249985589136n, baseCurrencyUnit: 100000000n,
}
const blockTag = `0x${position.blockNumber.toString(16)}`
type Options = { empty?: boolean; allZero?: boolean; duplicate?: boolean; zeroAsset?: boolean; malformed?: boolean;
  count?: number; symbol?: string; decimals?: number; price?: bigint; wrongProvider?: boolean;
  reorgBefore?: boolean; reorgAfter?: boolean; timestampChange?: boolean; failRoute?: boolean; noDebt?: boolean; noCollateral?: boolean }
function fixture(options: Options = {}) {
  let headers = 0
  const calls: string[] = []
  const route = {
    status: 'ready' as RouteStatus,
    async fetchRpc(body: string | Uint8Array) {
      const requests = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)) as { id: number; method: string; params: unknown[] }[]
      assert.ok(Array.isArray(requests))
      const replies = requests.map((request) => {
        let result: unknown
        if (request.method === 'eth_getBlockByNumber') {
          assert.deepEqual(request.params, [blockTag, false])
          headers++
          result = { number: blockTag, timestamp: `0x${(position.blockTimestamp + (options.timestampChange && headers > 1 ? 1 : 0)).toString(16)}`,
            hash: options.reorgBefore || (options.reorgAfter && headers > 1) ? `0x${'b'.repeat(64)}` : position.blockHash }
        } else {
          assert.equal(request.method, 'eth_call')
          assert.equal(request.params[1], blockTag)
          const call = request.params[0] as { to: string; data: string }
          const abi = call.to === AAVE_SEPOLIA.oracle ? oracle : data
          assert.ok(call.to === AAVE_SEPOLIA.oracle || call.to === AAVE_SEPOLIA_DATA_PROVIDER)
          const decoded = abi.parseTransaction({ data: call.data })!
          calls.push(decoded.name)
          if (decoded.name === 'ADDRESSES_PROVIDER') result = data.encodeFunctionResult(decoded.name, [options.wrongProvider ? asset(555) : AAVE_SEPOLIA.addressesProvider])
          else if (decoded.name === 'getAllReservesTokens') {
            if (options.malformed) result = '0x1234'
            else {
              const rows = options.empty ? [] : Array.from({ length: options.count ?? 4 }, (_, i) => [i === 0 ? options.symbol ?? 'USDT' : `TOKEN${i}`, options.zeroAsset ? ZeroAddress : asset(options.duplicate ? 1 : i + 1)])
              result = data.encodeFunctionResult(decoded.name, [rows])
            }
          } else if (decoded.name === 'getUserReserveData') {
            assert.equal(decoded.args[1].toLowerCase(), position.account.toLowerCase())
            const i = Number(BigInt(decoded.args[0]))
            const supplied = options.allZero || i === 4 ? 0n : 10n ** BigInt(i === 1 ? 6 : i === 2 ? 8 : 18)
            result = data.encodeFunctionResult(decoded.name, [supplied, i === 2 && !options.allZero && !options.noDebt ? 2n : 0n, i === 3 && !options.allZero && !options.noDebt ? 3n : 0n, 0, 0, 0, 0, 0, !options.noCollateral && i !== 3])
          } else if (decoded.name === 'getReserveConfigurationData') {
            const i = Number(BigInt(decoded.args[0]))
            result = data.encodeFunctionResult(decoded.name, [options.decimals ?? (i === 1 ? 6 : i === 2 ? 8 : 18), 7500, 8000, 10500, 1000, true, true, false, true, false])
          } else if (decoded.name === 'getAssetPrice') result = oracle.encodeFunctionResult(decoded.name, [options.price ?? 100000000n])
          else throw new Error('Unexpected read')
        }
        return { jsonrpc: '2.0', id: request.id, result }
      })
      if (options.failRoute) route.status = 'degraded'
      return Response.json(replies.reverse())
    },
  }
  return { route, calls, headers: () => headers }
}

test('reserve rows preserve six/eight/eighteen decimal bigint amounts at one block using only the supplied route', async () => {
  const previous = globalThis.fetch
  let direct = 0
  globalThis.fetch = async () => { direct++; throw new Error('Direct fetch forbidden') }
  try {
    const { route, calls, headers } = fixture()
    const rows = await readLendingAssets(route, position)
    assert.deepEqual(rows.map(({ decimals }) => decimals), [6, 8, 18])
    assert.deepEqual(rows.map(({ supplied }) => supplied), [1000000n, 100000000n, 1000000000000000000n])
    assert.equal(rows[1].stableDebt, 2n)
    assert.equal(rows[2].variableDebt, 3n)
    assert.equal(rows[2].collateralEnabled, false)
    assert.equal(rows[0].priceBase, 100000000n)
    assert.equal(calls.filter((name) => name === 'getReserveConfigurationData').length, 3)
    assert.equal(calls.filter((name) => name === 'getAssetPrice').length, 3)
    assert.equal(headers(), 2)
    assert.equal(direct, 0)
  } finally { globalThis.fetch = previous }
})

for (const options of [{ empty: true }, { allZero: true }]) {
  test(`empty or zero balances avoid unnecessary price/config reads ${JSON.stringify(options)}`, async () => {
    const { route, calls, headers } = fixture(options)
    assert.deepEqual(await readLendingAssets(route, { ...position, collateralBase: 0n, debtBase: 0n }), [])
    assert.ok(!calls.includes('getAssetPrice'))
    assert.ok(!calls.includes('getReserveConfigurationData'))
    assert.equal(headers(), 2)
  })
}

test('nonempty supplied assets cannot hide aggregate borrow debt', async () => {
  const { route } = fixture({ noDebt: true })
  await assert.rejects(readLendingAssets(route, position), /Asset debts do not match/)
})

test('nonempty supplied assets without collateral flags cannot explain aggregate collateral', async () => {
  const { route } = fixture({ noCollateral: true })
  await assert.rejects(readLendingAssets(route, position), /Asset collateral does not match/)
})

test('a supplied position without debt is allowed when aggregate debt is zero', async () => {
  const { route } = fixture({ noDebt: true })
  assert.equal((await readLendingAssets(route, { ...position, debtBase: 0n })).length, 3)
})

test('noncollateral supplied assets are allowed when aggregate collateral is zero', async () => {
  const { route } = fixture({ noCollateral: true })
  assert.equal((await readLendingAssets(route, { ...position, collateralBase: 0n })).length, 3)
})

for (const totals of [{ collateralBase: 1n, debtBase: 0n }, { collateralBase: 0n, debtBase: 1n }]) {
  for (const options of [{ empty: true }, { allZero: true }]) {
    test(`empty assets cannot contradict nonzero aggregate ${Object.keys(totals).find((key) => totals[key as keyof typeof totals] > 0n)} ${JSON.stringify(options)}`, async () => {
      const { route } = fixture(options)
      await assert.rejects(readLendingAssets(route, { ...position, ...totals }), /Asset balances do not match/)
    })
  }
}

for (const options of [{ duplicate: true }, { zeroAsset: true }, { malformed: true }, { count: 33 },
  { symbol: 'x'.repeat(33) }, { symbol: '<script>' }, { decimals: 37 }, { price: 0n }, { wrongProvider: true },
  { reorgBefore: true }, { reorgAfter: true }, { timestampChange: true }, { failRoute: true }]) {
  test(`invalid assets/snapshot or route state is rejected: ${Object.keys(options)[0]}`, async () => {
    const { route } = fixture(options)
    await assert.rejects(readLendingAssets(route, position))
  })
}

test('a stopped route does not make any reserve requests', async () => {
  const { route, calls } = fixture()
  route.status = 'degraded'
  await assert.rejects(readLendingAssets(route, position), /Private connection/)
  assert.deepEqual(calls, [])
})
