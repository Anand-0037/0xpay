import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Interface, ZeroAddress, ZeroHash } from 'ethers'
import type { RouteStatus } from '../src/rpc.ts'
import type { MarketSummary } from '../src/agents/market.ts'
import { PREDICTION_CONTRACTS, readPredictionPreflight } from '../src/agents/preflight.ts'

// Synthetic contract-shaped fixtures only, never evidence of live holdings.
const account = '0x0000000000000000000000000000000000001234'
const conditionId = `0x${'c'.repeat(64)}`, hash = `0x${'a'.repeat(64)}`
const market: MarketSummary = { id: 'fixture', version: 'v1', conditionId, question: 'Fixture question?', slug: 'fixture', endDate: null,
  outcomes: [{ tokenId: '101', name: 'Yes' }, { tokenId: '102', name: 'No' }], active: true, acceptingOrders: true }
const ctf = new Interface([
  'function balanceOf(address,uint256) view returns(uint256)',
  'function getOutcomeSlotCount(bytes32) view returns(uint256)',
  'function getCollectionId(bytes32,bytes32,uint256) view returns(bytes32)',
  'function getPositionId(address,bytes32) view returns(uint256)',
])
const erc20 = new Interface(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)'])
const adapterAbi = new Interface(['function ctf() view returns(address)', 'function col() view returns(address)', 'function wcol() view returns(address)'])
const observedWrappedCollateral = '0x3A3BD7bb9528E159577F7C2e685CC81A765002E2'
// Public identity observed at Polygon block96829489, not an account or holdings claim.
const observedMarket: MarketSummary = { ...market, id: '3215008',
  conditionId: '0x8a4196617dcb703e49d9bb36d3847bf6a75fd364dbd19f8d408ac944bf1a03d8',
  outcomes: [
    { tokenId: '111662129652828266889360374468657435151479595863413519836161861837506140152890', name: 'Yes' },
    { tokenId: '94483965432909797688470702512207472940215538148754820061518518664128018848687', name: 'No' },
  ] }
const observedCollection = '0x016cea3fae70d235fe4222ed94ee5e46352bc79ebfc349123d9969136a70e334'
type Options = { wrongChain?: boolean; reorg?: boolean; timestampChanged?: boolean; duplicate?: boolean; malformed?: boolean;
  failRoute?: boolean; missingCode?: boolean; slots?: number; unsupportedBacking?: boolean; ambiguousBacking?: boolean;
  legacy?: boolean; zero?: boolean; decimals?: number; symbol?: string; rpcError?: boolean; incomplete?: boolean;
  negativeRisk?: boolean; wrongAdapterCtf?: boolean; wrongAdapterCollateral?: boolean; zeroWrapped?: boolean; missingAdapter?: boolean }
function fixture(options: Options = {}, selectedMarket = market) {
  const requests: { method: string; params: unknown[] }[] = []
  let headerReads = 0
  const route = { status: 'ready' as RouteStatus, async fetchRpc(body: string | Uint8Array) {
    const batch = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)) as { id: number; method: string; params: unknown[] }[]
    const replies = batch.map(request => {
      requests.push(request)
      let result: unknown
      if (request.method === 'eth_chainId') result = options.wrongChain ? '0x1' : '0x89'
      else if (request.method === 'eth_getBlockByNumber') {
        headerReads++
        if (headerReads > 1) assert.deepEqual(request.params, ['0x12345', false])
        result = { number: '0x12345', timestamp: options.timestampChanged && headerReads > 1 ? '0x69000001' : '0x69000000',
          hash: options.reorg && headerReads > 1 ? `0x${'b'.repeat(64)}` : hash }
      } else if (request.method === 'eth_getCode') {
        assert.equal(request.params[1], '0x12345')
        result = options.missingCode || options.missingAdapter && request.params[0] === PREDICTION_CONTRACTS.negativeRiskAdapter ? '0x' : '0x60006000'
      } else {
        assert.equal(request.method, 'eth_call')
        assert.equal(request.params[1], '0x12345')
        const call = request.params[0] as { to: string; data: string }
        const abi = call.to === PREDICTION_CONTRACTS.ctf ? ctf : call.to === PREDICTION_CONTRACTS.negativeRiskAdapter ? adapterAbi : erc20
        const parsed = abi.parseTransaction({ data: call.data })!
        if (call.to === PREDICTION_CONTRACTS.ctf) {
          if (parsed.name === 'getOutcomeSlotCount') {
            assert.equal(parsed.args[0], selectedMarket.conditionId)
            result = ctf.encodeFunctionResult(parsed.name, [options.slots ?? 2])
          } else if (parsed.name === 'getCollectionId') {
            assert.equal(parsed.args[0], ZeroHash); assert.equal(parsed.args[1], selectedMarket.conditionId)
            assert.ok(parsed.args[2] === 1n || parsed.args[2] === 2n)
            result = ctf.encodeFunctionResult(parsed.name, [selectedMarket === observedMarket && parsed.args[2] === 1n ? observedCollection : `0x${(parsed.args[2] === 1n ? '1' : '2').repeat(64)}`])
          } else if (parsed.name === 'getPositionId') {
            const correctCollateral = options.negativeRisk ? observedWrappedCollateral : options.legacy ? PREDICTION_CONTRACTS.legacyCollateral : PREDICTION_CONTRACTS.collateral
            const matching = parsed.args[0] === correctCollateral || options.ambiguousBacking
            const firstOutcome = parsed.args[1] === (selectedMarket === observedMarket ? observedCollection : `0x${'1'.repeat(64)}`)
            const outcomeId = BigInt(selectedMarket.outcomes[firstOutcome ? 0 : 1].tokenId)
            result = ctf.encodeFunctionResult(parsed.name, [!options.unsupportedBacking && matching ? outcomeId : 999n])
          } else {
            assert.equal(parsed.name, 'balanceOf'); assert.equal(parsed.args[0].toLowerCase(), account)
            assert.ok(selectedMarket.outcomes.some(outcome => BigInt(outcome.tokenId) === parsed.args[1]))
            result = ctf.encodeFunctionResult(parsed.name, [options.zero ? 0n : 12345678901234567890n])
          }
        } else if (call.to === PREDICTION_CONTRACTS.negativeRiskAdapter) {
          const value = parsed.name === 'ctf' ? options.wrongAdapterCtf ? ZeroAddress : PREDICTION_CONTRACTS.ctf
            : parsed.name === 'col' ? options.wrongAdapterCollateral ? ZeroAddress : PREDICTION_CONTRACTS.legacyCollateral
              : options.zeroWrapped ? ZeroAddress : observedWrappedCollateral
          result = adapterAbi.encodeFunctionResult(parsed.name, [value])
        } else {
          assert.ok(call.to === PREDICTION_CONTRACTS.collateral || call.to === PREDICTION_CONTRACTS.legacyCollateral || call.to === observedWrappedCollateral)
          if (parsed.name === 'balanceOf') { assert.equal(parsed.args[0].toLowerCase(), account); result = erc20.encodeFunctionResult(parsed.name, [options.zero ? 0n : 25000000n]) }
          else if (parsed.name === 'decimals') result = erc20.encodeFunctionResult(parsed.name, [options.decimals ?? (call.to === PREDICTION_CONTRACTS.legacyCollateral ? 8 : 6)])
          else result = erc20.encodeFunctionResult(parsed.name, [options.symbol ?? 'pUSD'])
        }
      }
      return options.rpcError ? { jsonrpc: '2.0', id: request.id, error: { code: -32000 } } : { jsonrpc: '2.0', id: request.id, result }
    })
    if (options.failRoute) route.status = 'degraded'
    if (options.malformed) return new Response('not-json')
    if (options.duplicate && replies.length > 1) replies[1] = replies[0]
    if (options.incomplete) replies.pop()
    return Response.json(replies.reverse())
  } }
  return { route, requests }
}

test('account outcome and current collateral are exact same-block worker-only contract reads', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Direct requests forbidden') }
  try {
    const { route, requests } = fixture()
    const result = await readPredictionPreflight(route, ` ${account} `, market, 0)
    assert.equal(result.account.toLowerCase(), account)
    assert.equal(result.chainId, 137); assert.equal(result.blockNumber, 0x12345); assert.equal(result.blockHash, hash)
    assert.equal(result.blockTimestamp, 0x69000000)
    assert.equal(result.tokenId, '101'); assert.equal(result.outcome, 'Yes')
    assert.equal(result.outcomeBalance, 12345678901234567890n)
    assert.equal(result.collateralBalance, 25000000n)
    assert.equal(result.collateralDecimals, 6); assert.equal(result.collateralSymbol, 'pUSD')
    assert.equal(result.outcomeDecimals, 6)
    assert.equal(result.collateralAddress, PREDICTION_CONTRACTS.collateral)
    assert.equal(result.outcomeCollateralAddress, PREDICTION_CONTRACTS.collateral)
    assert.ok(requests.every(request => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(request.method)))
  } finally { globalThis.fetch = previous }
})

test('actual zero contract responses remain valid zero balances', async () => {
  const { route } = fixture({ zero: true })
  const result = await readPredictionPreflight(route, account, market, 0)
  assert.equal(result.outcomeBalance, 0n); assert.equal(result.collateralBalance, 0n)
})

test('legacy CTF backing is derived separately from the current pUSD account balance', async () => {
  const { route } = fixture({ legacy: true })
  const result = await readPredictionPreflight(route, account, market, 1)
  assert.equal(result.tokenId, '102'); assert.equal(result.outcome, 'No')
  assert.equal(result.collateralAddress, PREDICTION_CONTRACTS.collateral)
  assert.equal(result.outcomeCollateralAddress, PREDICTION_CONTRACTS.legacyCollateral)
  assert.equal(result.collateralDecimals, 6); assert.equal(result.outcomeDecimals, 8)
})

test('observed negative-risk market identity requires exact wrapped-collateral derivation; fixture holdings are synthetic', async () => {
  const { route, requests } = fixture({ negativeRisk: true, zero: true }, observedMarket)
  const result = await readPredictionPreflight(route, account, observedMarket, 0)
  assert.equal(result.tokenId, observedMarket.outcomes[0].tokenId)
  assert.equal(result.outcomeCollateralAddress, observedWrappedCollateral)
  assert.equal(result.outcomeDecimals, 6)
  assert.equal(result.collateralAddress, PREDICTION_CONTRACTS.collateral)
  assert.equal(result.outcomeBalance, 0n)
  assert.ok(requests.some(request => request.method === 'eth_call' && (request.params[0] as { to: string }).to === PREDICTION_CONTRACTS.negativeRiskAdapter))
})

for (const options of [{ wrongAdapterCtf: true }, { wrongAdapterCollateral: true }, { zeroWrapped: true }, { missingAdapter: true }, { unsupportedBacking: true }]) {
  test(`negative-risk discovery fails closed on ${Object.keys(options)[0]}`, async () => {
    const { route } = fixture({ negativeRisk: true, ...options }, observedMarket)
    await assert.rejects(readPredictionPreflight(route, account, observedMarket, 0))
  })
}

for (const [label, options] of [
  ['wrong chain', { wrongChain: true }], ['reorg', { reorg: true }], ['changed timestamp', { timestampChanged: true }],
  ['duplicate RPC IDs', { duplicate: true }], ['malformed RPC', { malformed: true }], ['lost route', { failRoute: true }],
  ['missing contract', { missingCode: true }], ['mismatched condition slots', { slots: 3 }],
  ['unknown collateral mapping', { unsupportedBacking: true }], ['ambiguous mapping', { ambiguousBacking: true }],
  ['invalid decimals', { decimals: 37 }], ['unsafe symbol', { symbol: '<pUSD>' }], ['RPC errors', { rpcError: true }],
  ['partial response', { incomplete: true }],
] as const) {
  test(`preflight rejects ${label} instead of making up holdings`, async () => {
    const { route } = fixture(options)
    await assert.rejects(readPredictionPreflight(route, account, market, 0))
  })
}

for (const input of ['', 'bad address', ZeroAddress, '0x1234']) {
  test(`invalid account is rejected before RPC: ${input || 'empty'}`, async () => {
    const { route, requests } = fixture()
    await assert.rejects(readPredictionPreflight(route, input, market, 0))
    assert.equal(requests.length, 0)
  })
}

for (const [label, changed, index] of [
  ['missing version', { ...market, version: undefined }, 0], ['v2', { ...market, version: 'v2' }, 0],
  ['not binary', { ...market, outcomes: [...market.outcomes, { tokenId: '103', name: 'Other' }] }, 0],
  ['duplicate tokens', { ...market, outcomes: [market.outcomes[0], market.outcomes[0]] }, 0],
  ['invalid condition', { ...market, conditionId: ZeroHash }, 0], ['negative outcome', market, -1],
  ['fractional outcome', market, 0.5], ['unknown outcome', market, 2],
] as const) {
  test(`unsupported market input is rejected before RPC: ${label}`, async () => {
    const { route, requests } = fixture()
    await assert.rejects(readPredictionPreflight(route, account, changed as MarketSummary, index))
    assert.equal(requests.length, 0)
  })
}

test('an unavailable route never performs account reads', async () => {
  const { route, requests } = fixture()
  route.status = 'degraded'
  await assert.rejects(readPredictionPreflight(route, account, market, 0), /Reconnect/)
  assert.equal(requests.length, 0)
})
