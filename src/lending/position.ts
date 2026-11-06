import { getAddress, Interface, ZeroAddress } from 'ethers'
import type { PrivateRpc } from '../rpc.ts'

// Aave's MIT-licensed address book; protocol/contract logic is reused, not ours.
// https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Sepolia.sol
export const AAVE_SEPOLIA = {
  chainId: 11155111,
  pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  addressesProvider: '0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A',
  oracle: '0x2da88497588bf89281816106C7259e31AF45a663',
} as const
const poolAbi = new Interface([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function ADDRESSES_PROVIDER() view returns (address)',
])
const providerAbi = new Interface([
  'function getPool() view returns (address)',
  'function getPriceOracle() view returns (address)',
])
const oracleAbi = new Interface([
  'function BASE_CURRENCY() view returns (address)',
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
])
const WAD = 10n ** 18n
const BPS = 10_000n
let requestId = 10_000
type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'>
type Call = { method: string; params: unknown[] }

export type LendingPosition = Readonly<{
  account: string
  chainId: 11155111
  blockNumber: number
  blockHash: string
  blockTimestamp: number
  collateralBase: bigint
  debtBase: bigint
  availableBorrowBase: bigint
  liquidationThresholdBps: bigint
  ltvBps: bigint
  healthFactorWad: bigint
  baseCurrencyUnit: bigint
}>

function ready(route: Route) {
  if (route.status !== 'ready') throw new Error('Private connection is unavailable. Reconnect to check this position.')
}

async function batch(route: Route, calls: Call[]): Promise<unknown[]> {
  ready(route)
  const requests = calls.map((call) => ({ jsonrpc: '2.0', id: ++requestId, ...call }))
  const response = await route.fetchRpc(JSON.stringify(requests))
  ready(route)
  if (!response.ok) throw new Error('The private RPC could not read the lending pool.')
  const values: unknown = await response.json()
  if (!Array.isArray(values) || values.length !== requests.length) throw new Error('Incomplete lending RPC response.')
  const byId = new Map<number, unknown>()
  const expected = new Set(requests.map(({ id }) => id))
  for (const entry of values) {
    if (!entry || typeof entry !== 'object' || !('jsonrpc' in entry) || entry.jsonrpc !== '2.0' ||
      !('id' in entry) || typeof entry.id !== 'number' || !expected.has(entry.id) || byId.has(entry.id)) {
      throw new Error('Invalid lending RPC response.')
    }
    if ('error' in entry || !('result' in entry)) throw new Error('A lending contract read failed. No direct RPC fallback was used.')
    byId.set(entry.id, entry.result)
  }
  ready(route)
  return requests.map(({ id }) => byId.get(id))
}

function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('Invalid contract data returned by RPC.')
  return value
}
function quantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid block information returned by RPC.')
  const result = Number(BigInt(value))
  if (!Number.isSafeInteger(result)) throw new Error('Block information is outside the supported range.')
  return result
}
function block(value: unknown) {
  if (!value || typeof value !== 'object' || !('number' in value) || !('timestamp' in value) ||
    !('hash' in value) || typeof value.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.hash)) {
    throw new Error('The RPC did not return a mined block.')
  }
  return { number: quantity(value.number), timestamp: quantity(value.timestamp), hash: value.hash.toLowerCase() }
}
function contractCall(to: string, data: string, blockTag: string): Call {
  return { method: 'eth_call', params: [{ to, data }, blockTag] }
}

/** All address-bearing reads use the existing worker, at one explicit block. */
export async function readLendingPosition(route: Route, input: string): Promise<LendingPosition> {
  const account = getAddress(input.trim())
  if (account === ZeroAddress) throw new Error('Enter a non-zero Ethereum address.')
  const [chain, header] = await batch(route, [
    { method: 'eth_chainId', params: [] },
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
  ])
  if (typeof chain !== 'string' || chain.toLowerCase() !== '0xaa36a7') throw new Error('This view supports Ethereum Sepolia only.')
  const snapshot = block(header)
  const blockTag = `0x${snapshot.number.toString(16)}`
  const [code, accountData, provider, pool, oracle, currency, unit] = await batch(route, [
    { method: 'eth_getCode', params: [AAVE_SEPOLIA.pool, blockTag] },
    contractCall(AAVE_SEPOLIA.pool, poolAbi.encodeFunctionData('getUserAccountData', [account]), blockTag),
    contractCall(AAVE_SEPOLIA.pool, poolAbi.encodeFunctionData('ADDRESSES_PROVIDER'), blockTag),
    contractCall(AAVE_SEPOLIA.addressesProvider, providerAbi.encodeFunctionData('getPool'), blockTag),
    contractCall(AAVE_SEPOLIA.addressesProvider, providerAbi.encodeFunctionData('getPriceOracle'), blockTag),
    contractCall(AAVE_SEPOLIA.oracle, oracleAbi.encodeFunctionData('BASE_CURRENCY'), blockTag),
    contractCall(AAVE_SEPOLIA.oracle, oracleAbi.encodeFunctionData('BASE_CURRENCY_UNIT'), blockTag),
  ])
  if (hex(code) === '0x') throw new Error('Aave is not deployed at the configured pool on this chain.')
  if (poolAbi.decodeFunctionResult('ADDRESSES_PROVIDER', hex(provider))[0] !== AAVE_SEPOLIA.addressesProvider ||
    providerAbi.decodeFunctionResult('getPool', hex(pool))[0] !== AAVE_SEPOLIA.pool ||
    providerAbi.decodeFunctionResult('getPriceOracle', hex(oracle))[0] !== AAVE_SEPOLIA.oracle) {
    throw new Error('Aave deployment configuration changed. Refresh the supported market before continuing.')
  }
  const baseCurrencyUnit = oracleAbi.decodeFunctionResult('BASE_CURRENCY_UNIT', hex(unit))[0] as bigint
  if (oracleAbi.decodeFunctionResult('BASE_CURRENCY', hex(currency))[0] !== ZeroAddress || baseCurrencyUnit !== 100_000_000n) {
    throw new Error('Unsupported Aave price currency. Dollar values were not calculated.')
  }
  const [collateralBase, debtBase, availableBorrowBase, liquidationThresholdBps, ltvBps, healthFactorWad] =
    poolAbi.decodeFunctionResult('getUserAccountData', hex(accountData)) as unknown as bigint[]
  if (liquidationThresholdBps > BPS || ltvBps > BPS) throw new Error('Unsupported lending risk parameters.')
  // A reorg during the read invalidates the snapshot instead of combining states.
  const [confirmedHeader] = await batch(route, [{ method: 'eth_getBlockByNumber', params: [blockTag, false] }])
  const confirmed = block(confirmedHeader)
  if (confirmed.hash !== snapshot.hash || confirmed.number !== snapshot.number || confirmed.timestamp !== snapshot.timestamp) {
    throw new Error('The chain changed while reading this position. Check it again.')
  }
  return { account, chainId: AAVE_SEPOLIA.chainId, blockNumber: snapshot.number, blockHash: snapshot.hash, blockTimestamp: snapshot.timestamp,
    collateralBase, debtBase, availableBorrowBase, liquidationThresholdBps, ltvBps, healthFactorWad, baseCurrencyUnit }
}

// Shared with optional reserve details so the same strict envelopes, private
// route gate and block parsing protect every address-bearing lending read.
export { batch as readLendingBatch, block as parseLendingBlock }

/** A local aggregate what-if, not a transaction, price prediction or liquidation quote. */
export function modelPosition(position: LendingPosition, { collateralDropBps, repayBase }: { collateralDropBps: bigint; repayBase: bigint }) {
  if (collateralDropBps < 0n || collateralDropBps > BPS || repayBase < 0n || repayBase > position.debtBase) {
    throw new Error('Scenario is outside this position’s supported range.')
  }
  const collateralBase = position.collateralBase * (BPS - collateralDropBps) / BPS
  const debtBase = position.debtBase - repayBase
  // Scale the protocol-reported HF, retaining eMode/weighted-threshold effects
  // in the original snapshot. Hold debt prices/interest and collateral mix fixed.
  const healthFactorWad = debtBase === 0n ? null
    : position.healthFactorWad * (BPS - collateralDropBps) * position.debtBase / (BPS * debtBase)
  return { collateralBase, debtBase, healthFactorWad }
}

export function formatBaseUsd(value: bigint, unit = 100_000_000n): string {
  if (value < 0n || unit <= 0n) throw new Error('Invalid amount.')
  const cents = value * 100n / unit
  return `$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`
}
export function formatHealthFactor(value: bigint | null): string {
  if (value === null || value === (1n << 256n) - 1n) return 'No debt'
  if (value < 0n) throw new Error('Invalid health factor.')
  const hundredths = value * 100n / WAD
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`
}
