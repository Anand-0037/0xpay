import { getAddress, Interface, ZeroAddress } from 'ethers'
import type { PrivateRpc } from '../rpc'
import { AAVE_SEPOLIA, parseLendingBlock, readLendingBatch, type LendingPosition } from './position'

// Pinned Aave Sepolia registry, MIT address book. Contract logic stays in Aave.
// https://github.com/aave-dao/aave-address-book/blob/4ee7b505d40760f48bcfdc4edd5fe3d532ec88d2/src/AaveV3Sepolia.sol
export const AAVE_SEPOLIA_DATA_PROVIDER = '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31'
const MAX_RESERVES = 32
const dataAbi = new Interface([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getAllReservesTokens() view returns (tuple(string symbol,address tokenAddress)[])',
  'function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)',
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)',
])
const oracleAbi = new Interface(['function getAssetPrice(address asset) view returns (uint256)'])
type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'>
export type LendingAssetRow = {
  asset: string; symbol: string; decimals: number; supplied: bigint; stableDebt: bigint
  variableDebt: bigint; priceBase: bigint; collateralEnabled: boolean
}

function hex(value: unknown) {
  if (typeof value !== 'string' || value.length > 65_538 || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new Error('Invalid lending asset data returned by RPC.')
  }
  return value
}

/** Reserve balances and oracle prices belong to the same validated position block. */
export async function readLendingAssets(route: Route, position: LendingPosition): Promise<LendingAssetRow[]> {
  if (position.chainId !== AAVE_SEPOLIA.chainId || !Number.isSafeInteger(position.blockNumber) || position.blockNumber < 0 ||
    !/^0x[0-9a-f]{64}$/i.test(position.blockHash)) throw new Error('Invalid lending snapshot.')
  const blockTag = `0x${position.blockNumber.toString(16)}`
  const call = (to: string, data: string) => ({ method: 'eth_call', params: [{ to, data }, blockTag] })
  const assertSnapshot = async () => {
    const [header] = await readLendingBatch(route, [{ method: 'eth_getBlockByNumber', params: [blockTag, false] }])
    const block = parseLendingBlock(header)
    if (block.number !== position.blockNumber || block.timestamp !== position.blockTimestamp ||
      block.hash !== position.blockHash.toLowerCase()) throw new Error('The chain changed while reading assets. Refresh the position.')
  }
  await assertSnapshot()
  const [providerResult, reserveResult] = await readLendingBatch(route, [
    call(AAVE_SEPOLIA_DATA_PROVIDER, dataAbi.encodeFunctionData('ADDRESSES_PROVIDER')),
    call(AAVE_SEPOLIA_DATA_PROVIDER, dataAbi.encodeFunctionData('getAllReservesTokens')),
  ])
  if (dataAbi.decodeFunctionResult('ADDRESSES_PROVIDER', hex(providerResult))[0] !== AAVE_SEPOLIA.addressesProvider) {
    throw new Error('The lending asset provider does not match this market.')
  }
  const decoded = dataAbi.decodeFunctionResult('getAllReservesTokens', hex(reserveResult))[0] as readonly (readonly [string, string])[]
  if (decoded.length > MAX_RESERVES) throw new Error('This market has more reserves than this view supports.')
  const seen = new Set<string>()
  const reserves = decoded.map(([symbol, rawAddress]) => {
    const asset = getAddress(rawAddress)
    if (asset === ZeroAddress || seen.has(asset.toLowerCase())) throw new Error('The lending market returned a duplicate or invalid asset.')
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(symbol)) throw new Error('The lending market returned an unsupported asset symbol.')
    seen.add(asset.toLowerCase())
    return { asset, symbol }
  })
  const balances = reserves.length ? await readLendingBatch(route, reserves.map(({ asset }) =>
    call(AAVE_SEPOLIA_DATA_PROVIDER, dataAbi.encodeFunctionData('getUserReserveData', [asset, position.account])))) : []
  const active = reserves.flatMap((reserve, index) => {
    const result = dataAbi.decodeFunctionResult('getUserReserveData', hex(balances[index]))
    const supplied = result[0] as bigint, stableDebt = result[1] as bigint, variableDebt = result[2] as bigint
    return supplied === 0n && stableDebt === 0n && variableDebt === 0n ? [] : [{ ...reserve, supplied, stableDebt,
      variableDebt, collateralEnabled: result[8] as boolean }]
  })
  const details = active.length ? await readLendingBatch(route, active.flatMap(({ asset }) => [
    call(AAVE_SEPOLIA_DATA_PROVIDER, dataAbi.encodeFunctionData('getReserveConfigurationData', [asset])),
    call(AAVE_SEPOLIA.oracle, oracleAbi.encodeFunctionData('getAssetPrice', [asset])),
  ])) : []
  const rows = active.map((reserve, index) => {
    const config = dataAbi.decodeFunctionResult('getReserveConfigurationData', hex(details[index * 2]))
    const decimals = config[0] as bigint
    const priceBase = oracleAbi.decodeFunctionResult('getAssetPrice', hex(details[index * 2 + 1]))[0] as bigint
    if (decimals > 36n || priceBase === 0n) throw new Error('The lending market returned unsupported asset units or price.')
    return { ...reserve, decimals: Number(decimals), priceBase }
  })
  await assertSnapshot()
  if (rows.length === 0 && (position.collateralBase > 0n || position.debtBase > 0n)) {
    throw new Error('Asset balances do not match this position. Refresh the position before continuing.')
  }
  if (position.debtBase > 0n && !rows.some(({ stableDebt, variableDebt }) => stableDebt > 0n || variableDebt > 0n)) {
    throw new Error('Asset debts do not match this position. Refresh the position before continuing.')
  }
  if (position.collateralBase > 0n && !rows.some(({ supplied, collateralEnabled }) => supplied > 0n && collateralEnabled)) {
    throw new Error('Asset collateral does not match this position. Refresh the position before continuing.')
  }
  return rows
}
