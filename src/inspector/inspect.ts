export type RpcRead = (method: string, params: unknown[]) => Promise<unknown>

export type AccountInspection = {
  kind: 'account'
  address: `0x${string}`
  chainId: 1337
  observedBlock: bigint
  balanceWei: bigint
  nonce: bigint
}

export type TransactionInspection = {
  kind: 'transaction'
  hash: `0x${string}`
  chainId: 1337
  observedBlock: bigint
  outcome: 'included' | 'failed' | 'pending' | 'not-found'
  includedBlock: bigint | null
  nativeTransfers: { from: `0x${string}`; to: `0x${string}`; amountWei: bigint }[]
}

export type Inspection = AccountInspection | TransactionInspection

const addressPattern = /^0x[0-9a-fA-F]{40}$/
const hashPattern = /^0x[0-9a-fA-F]{64}$/

export function parseLookup(input: string): { kind: 'account' | 'transaction'; value: `0x${string}` } {
  const value = input.trim()
  if (addressPattern.test(value)) return { kind: 'account', value: value as `0x${string}` }
  if (hashPattern.test(value)) return { kind: 'transaction', value: value as `0x${string}` }
  throw new Error('Enter a 0x address (40 hex characters) or transaction hash (64 hex characters).')
}

function quantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`Invalid ${label} returned by the devnet RPC.`)
  return BigInt(value)
}

function record(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} returned by the devnet RPC.`)
  return value as Record<string, unknown>
}

const nativeTransferAddress = '0xfffffffffffffffffffffffffffffffffffffffe'
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function nativeTransfers(receipt: Record<string, unknown> | null): TransactionInspection['nativeTransfers'] {
  if (!receipt || !Array.isArray(receipt.logs)) return []
  const transfers: TransactionInspection['nativeTransfers'] = []
  for (const value of receipt.logs) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const log = value as Record<string, unknown>
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== nativeTransferAddress) continue
    const topics = log.topics
    if (!Array.isArray(topics) || topics[0]?.toLowerCase?.() !== transferTopic) continue
    if (topics.length !== 3 || typeof topics[1] !== 'string' || typeof topics[2] !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(topics[1]) || !/^0x[0-9a-fA-F]{64}$/.test(topics[2])
      || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.data))
      throw new Error('Invalid native transfer log returned by the devnet RPC.')
    transfers.push({
      from: `0x${topics[1].slice(-40)}`,
      to: `0x${topics[2].slice(-40)}`,
      amountWei: BigInt(log.data),
    })
  }
  return transfers
}

/** Reads one public devnet lookup through the caller's Anon-RPC transport. */
export async function inspectQuery(input: string, read: RpcRead): Promise<Inspection> {
  const query = parseLookup(input)
  const chain = quantity(await read('eth_chainId', []), 'chain ID')
  if (chain !== 1337n) throw new Error(`Wrong network: expected alt-mempool devnet (1337), received ${chain}.`)
  const observedBlock = quantity(await read('eth_blockNumber', []), 'block number')
  const blockTag = `0x${observedBlock.toString(16)}`
  if (query.kind === 'account') {
    const balanceWei = quantity(await read('eth_getBalance', [query.value, blockTag]), 'balance')
    const nonce = quantity(await read('eth_getTransactionCount', [query.value, blockTag]), 'nonce')
    return { kind: 'account', address: query.value, chainId: 1337, observedBlock, balanceWei, nonce }
  }
  // A receipt establishes inclusion; query the transaction only when there
  // is no receipt, to distinguish pending from absent with one fewer relay hop.
  const receipt = record(await read('eth_getTransactionReceipt', [query.value]), 'receipt')
  const transaction = receipt ? null : record(await read('eth_getTransactionByHash', [query.value]), 'transaction')
  if (transaction?.hash && typeof transaction.hash === 'string' &&
    transaction.hash.toLowerCase() !== query.value.toLowerCase()) throw new Error('The devnet returned another transaction.')
  if (receipt?.transactionHash && typeof receipt.transactionHash === 'string' &&
    receipt.transactionHash.toLowerCase() !== query.value.toLowerCase()) throw new Error('The devnet returned a receipt for another transaction.')
  const includedBlock = receipt && receipt.blockNumber !== null && receipt.blockNumber !== undefined
    ? quantity(receipt.blockNumber, 'receipt block') : null
  const status = receipt?.status === undefined || receipt.status === null ? null : quantity(receipt.status, 'receipt status')
  if (status !== null && status !== 0n && status !== 1n) throw new Error('The devnet returned an unsupported receipt status.')
  const outcome = receipt ? status === 1n ? 'included' : status === 0n ? 'failed' : 'pending' : transaction ? 'pending' : 'not-found'
  return { kind: 'transaction', hash: query.value, chainId: 1337, observedBlock, outcome, includedBlock, nativeTransfers: nativeTransfers(receipt) }
}
