import { getAddress, Interface, ZeroAddress, ZeroHash } from 'ethers'
import type { PrivateRpc } from '../rpc'
import type { MarketSummary } from './market'

// Official Polygon deployments and CTF identifier derivation; reads only.
// https://docs.polymarket.com/resources/contracts
// https://docs.polymarket.com/resources/onchain-position-data
// https://docs.polymarket.com/concepts/pusd
// Wrapped negative-risk collateral: immutable ctf/col/wcol getters and token derivation:
// https://github.com/Polymarket/neg-risk-ctf-adapter/blob/main/src/NegRiskAdapter.sol
export const PREDICTION_CONTRACTS = {
  ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  collateral: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  legacyCollateral: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  negativeRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
} as const
const ctfAbi = new Interface([
  'function balanceOf(address account,uint256 id) view returns(uint256)',
  'function getOutcomeSlotCount(bytes32 conditionId) view returns(uint256)',
  'function getCollectionId(bytes32 parentCollectionId,bytes32 conditionId,uint256 indexSet) view returns(bytes32)',
  'function getPositionId(address collateralToken,bytes32 collectionId) view returns(uint256)',
])
const tokenAbi = new Interface([
  'function balanceOf(address account) view returns(uint256)',
  'function decimals() view returns(uint8)',
  'function symbol() view returns(string)',
])
const negativeRiskAbi = new Interface([
  'function ctf() view returns(address)',
  'function col() view returns(address)',
  'function wcol() view returns(address)',
])
type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'>
type Call = { method: string; params: unknown[] }
let nextId = 3_000_000
const MAX_UINT256 = (1n << 256n) - 1n
export type PredictionPreflight = {
  account: string; chainId: 137; blockNumber: number; blockHash: string; blockTimestamp: number
  marketId: string; conditionId: string; tokenId: string; outcome: string; outcomeBalance: bigint
  outcomeDecimals: number; outcomeCollateralAddress: string
  collateralBalance: bigint; collateralDecimals: number; collateralSymbol: string
  ctfAddress: string; collateralAddress: string
}
function ready(route: Route) {
  if (route.status !== 'ready') throw new Error('Reconnect the private Polygon route before checking this account.')
}
function hex(value: unknown) {
  if (typeof value !== 'string' || value.length > 131_074 || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('Invalid prediction contract response.')
  return value
}
function quantity(value: unknown) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid prediction snapshot quantity.')
  const result = Number(BigInt(value))
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Prediction snapshot quantity is unsupported.')
  return result
}
function block(value: unknown) {
  if (!value || typeof value !== 'object' || !('number' in value) || !('timestamp' in value) || !('hash' in value) ||
    typeof value.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.hash)) throw new Error('A mined Polygon snapshot is required.')
  const result = { number: quantity(value.number), timestamp: quantity(value.timestamp), hash: value.hash.toLowerCase() }
  if (!result.number || !result.timestamp) throw new Error('A mined Polygon snapshot is required.')
  return result
}
async function read(route: Route, calls: Call[]): Promise<unknown[]> {
  ready(route)
  const requests = calls.map(call => ({ jsonrpc: '2.0', id: ++nextId, ...call }))
  const response = await route.fetchRpc(JSON.stringify(requests))
  ready(route)
  if (!response.ok) throw new Error('Private Polygon contract read failed. No direct fallback was used.')
  const body = await response.text()
  ready(route)
  if (body.length > 1_000_000) throw new Error('Prediction response is too large.')
  const entries: unknown = JSON.parse(body)
  if (!Array.isArray(entries) || entries.length !== requests.length) throw new Error('Incomplete prediction RPC response.')
  const expected = new Set(requests.map(call => call.id)), values = new Map<number, unknown>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !('jsonrpc' in entry) || entry.jsonrpc !== '2.0' ||
      !('id' in entry) || typeof entry.id !== 'number' || !expected.has(entry.id) || values.has(entry.id) ||
      'error' in entry || !('result' in entry)) throw new Error('Invalid prediction RPC response.')
    values.set(entry.id, entry.result)
  }
  ready(route)
  return requests.map(call => values.get(call.id))
}
function tokenId(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) > MAX_UINT256) throw new Error('Invalid CTF outcome token ID.')
  return value
}

/** Account-bearing reads go only through the supplied ready route, never venue APIs. */
export async function readPredictionPreflight(route: Route, input: string, market: MarketSummary, outcomeIndex: number): Promise<PredictionPreflight> {
  // Validate everything local before the first account-bearing request.
  const account = getAddress(input.trim())
  if (account === ZeroAddress) throw new Error('Enter a non-zero public Polygon account.')
  if (!market || !('version' in market) || market.version !== 'v1') throw new Error('Account preflight supports explicitly identified v1 CTF markets only.')
  if (typeof market.id !== 'string' || !market.id || market.id.length > 128 ||
    !/^0x[0-9a-f]{64}$/i.test(market.conditionId) || market.conditionId.toLowerCase() === ZeroHash ||
    !Array.isArray(market.outcomes) || market.outcomes.length !== 2 ||
    !Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= market.outcomes.length) throw new Error('Choose a valid CTF market and outcome.')
  const seen = new Set<string>()
  for (const outcome of market.outcomes) {
    const id = tokenId(outcome?.tokenId)
    if (seen.has(id) || typeof outcome.name !== 'string' || !outcome.name.trim() || outcome.name.length > 80) throw new Error('Invalid or duplicate CTF outcomes.')
    seen.add(id)
  }
  const chosen = market.outcomes[outcomeIndex], selectedTokenId = tokenId(chosen.tokenId)
  const [chain, header] = await read(route, [
    { method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['latest', false] },
  ])
  if (chain !== '0x89') throw new Error('Prediction account preflight requires Polygon chain 137.')
  const snapshot = block(header), tag = `0x${snapshot.number.toString(16)}`
  const call = (to: string, data: string): Call => ({ method: 'eth_call', params: [{ to, data }, tag] })
  const [ctfCode, collateralCode, slots, collectionResult] = await read(route, [
    { method: 'eth_getCode', params: [PREDICTION_CONTRACTS.ctf, tag] },
    { method: 'eth_getCode', params: [PREDICTION_CONTRACTS.collateral, tag] },
    call(PREDICTION_CONTRACTS.ctf, ctfAbi.encodeFunctionData('getOutcomeSlotCount', [market.conditionId])),
    call(PREDICTION_CONTRACTS.ctf, ctfAbi.encodeFunctionData('getCollectionId', [ZeroHash, market.conditionId, 1n << BigInt(outcomeIndex)])),
  ])
  if (hex(ctfCode) === '0x' || hex(collateralCode) === '0x') throw new Error('The documented CTF or pUSD contract is not deployed at this Polygon snapshot.')
  if (ctfAbi.decodeFunctionResult('getOutcomeSlotCount', hex(slots))[0] !== BigInt(market.outcomes.length)) throw new Error('The onchain condition does not match this market.')
  const collection = ctfAbi.decodeFunctionResult('getCollectionId', hex(collectionResult))[0] as string
  const backingCandidates = [PREDICTION_CONTRACTS.collateral, PREDICTION_CONTRACTS.legacyCollateral]
  const derived = await read(route, backingCandidates.map(address => call(PREDICTION_CONTRACTS.ctf,
    ctfAbi.encodeFunctionData('getPositionId', [address, collection]))))
  const matches = backingCandidates.filter((_address, index) =>
    ctfAbi.decodeFunctionResult('getPositionId', hex(derived[index]))[0] === BigInt(selectedTokenId))
  if (matches.length > 1) throw new Error('Ambiguous CTF collateral mapping.')
  let outcomeCollateralAddress: string | undefined = matches[0]
  if (!outcomeCollateralAddress) {
    // Negative-risk CTF positions use the pinned adapter's wrapped collateral,
    // not pUSD/USDC.e directly. Discover it from the deployed contract, then
    // still require an exact token-ID derivation; Gamma's flag is not proof.
    const [adapterCode, adapterCtfRaw, adapterCollateralRaw, wrappedRaw] = await read(route, [
      { method: 'eth_getCode', params: [PREDICTION_CONTRACTS.negativeRiskAdapter, tag] },
      call(PREDICTION_CONTRACTS.negativeRiskAdapter, negativeRiskAbi.encodeFunctionData('ctf')),
      call(PREDICTION_CONTRACTS.negativeRiskAdapter, negativeRiskAbi.encodeFunctionData('col')),
      call(PREDICTION_CONTRACTS.negativeRiskAdapter, negativeRiskAbi.encodeFunctionData('wcol')),
    ])
    const adapterCtf = negativeRiskAbi.decodeFunctionResult('ctf', hex(adapterCtfRaw))[0] as string
    const adapterCollateral = negativeRiskAbi.decodeFunctionResult('col', hex(adapterCollateralRaw))[0] as string
    const wrapped = negativeRiskAbi.decodeFunctionResult('wcol', hex(wrappedRaw))[0] as string
    if (hex(adapterCode) === '0x' || adapterCtf !== PREDICTION_CONTRACTS.ctf ||
      !backingCandidates.some(address => address === adapterCollateral) || wrapped === ZeroAddress) {
      throw new Error('Unsupported negative-risk collateral configuration.')
    }
    const [wrappedPositionRaw] = await read(route, [call(PREDICTION_CONTRACTS.ctf,
      ctfAbi.encodeFunctionData('getPositionId', [wrapped, collection]))])
    if (ctfAbi.decodeFunctionResult('getPositionId', hex(wrappedPositionRaw))[0] !== BigInt(selectedTokenId)) {
      throw new Error('Unsupported CTF collateral mapping. This outcome was not inferred from its name or assigned a zero balance.')
    }
    outcomeCollateralAddress = wrapped
  }
  const [outcomeRaw, balanceRaw, decimalsRaw, symbolRaw, backingCode, outcomeDecimalsRaw] = await read(route, [
    call(PREDICTION_CONTRACTS.ctf, ctfAbi.encodeFunctionData('balanceOf', [account, selectedTokenId])),
    call(PREDICTION_CONTRACTS.collateral, tokenAbi.encodeFunctionData('balanceOf', [account])),
    call(PREDICTION_CONTRACTS.collateral, tokenAbi.encodeFunctionData('decimals')),
    call(PREDICTION_CONTRACTS.collateral, tokenAbi.encodeFunctionData('symbol')),
    { method: 'eth_getCode', params: [outcomeCollateralAddress, tag] },
    call(outcomeCollateralAddress, tokenAbi.encodeFunctionData('decimals')),
  ])
  if (hex(backingCode) === '0x') throw new Error('The outcome collateral contract is missing.')
  const collateralDecimals = Number(tokenAbi.decodeFunctionResult('decimals', hex(decimalsRaw))[0])
  const outcomeDecimals = Number(tokenAbi.decodeFunctionResult('decimals', hex(outcomeDecimalsRaw))[0])
  const collateralSymbol = tokenAbi.decodeFunctionResult('symbol', hex(symbolRaw))[0] as string
  if (collateralDecimals > 36 || outcomeDecimals > 36 || !/^[A-Za-z0-9 ._-]{1,32}$/.test(collateralSymbol)) throw new Error('Unsupported collateral metadata.')
  const outcomeBalance = ctfAbi.decodeFunctionResult('balanceOf', hex(outcomeRaw))[0] as bigint
  const collateralBalance = tokenAbi.decodeFunctionResult('balanceOf', hex(balanceRaw))[0] as bigint
  const [lastHeader] = await read(route, [{ method: 'eth_getBlockByNumber', params: [tag, false] }])
  const confirmed = block(lastHeader)
  if (confirmed.number !== snapshot.number || confirmed.hash !== snapshot.hash || confirmed.timestamp !== snapshot.timestamp) throw new Error('Polygon changed during this account check. Read a fresh snapshot.')
  return { account, chainId: 137, blockNumber: snapshot.number, blockHash: snapshot.hash, blockTimestamp: snapshot.timestamp,
    marketId: market.id, conditionId: market.conditionId.toLowerCase(), tokenId: selectedTokenId, outcome: chosen.name,
    outcomeBalance, outcomeDecimals, outcomeCollateralAddress, collateralBalance, collateralDecimals, collateralSymbol,
    ctfAddress: PREDICTION_CONTRACTS.ctf, collateralAddress: PREDICTION_CONTRACTS.collateral }
}
