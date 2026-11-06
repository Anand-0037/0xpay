import { getAddress, ZeroAddress } from 'ethers'
import type { PrivateRpc } from '../rpc'

type Route = Pick<PrivateRpc, 'status' | 'fetchRpc'>
let nextId = 2_000_000
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid Polygon RPC quantity')
  return BigInt(value)
}

/** Read-only Polygon evidence through the passed worker; never direct fetch. */
export async function checkAgentPrivateRoute(route: Route, input?: string): Promise<{
  chainId: 137; blockNumber: number; account?: string; balanceWei?: bigint
}> {
  if (route.status !== 'ready') throw new Error('Reconnect the private route before running the agent')
  const account = input?.trim() ? getAddress(input.trim()) : undefined
  if (account === ZeroAddress) throw new Error('Enter a non-zero public Polygon address')
  const calls = [
    { jsonrpc: '2.0', id: ++nextId, method: 'eth_chainId', params: [] as unknown[] },
    { jsonrpc: '2.0', id: ++nextId, method: 'eth_blockNumber', params: [] as unknown[] },
  ]
  const read = async (requests: typeof calls) => {
    const response = await route.fetchRpc(JSON.stringify(requests))
    if (route.status !== 'ready' || !response.ok) throw new Error('Private Polygon read stopped')
    const values: unknown = await response.json()
    if (!Array.isArray(values) || values.length !== requests.length) throw new Error('Incomplete Polygon RPC response')
    const expected = new Set(requests.map(call => call.id))
    const answers = new Map<number, unknown>()
    for (const value of values) {
      if (!value || typeof value !== 'object' || !('jsonrpc' in value) || value.jsonrpc !== '2.0' ||
        !('id' in value) || typeof value.id !== 'number' || !expected.has(value.id) || answers.has(value.id) ||
        'error' in value || !('result' in value)) throw new Error('Invalid Polygon RPC response')
      answers.set(value.id, value.result)
    }
    if (route.status !== 'ready') throw new Error('Private Polygon read stopped')
    return requests.map(call => quantity(answers.get(call.id)))
  }
  const [chain, height] = await read(calls)
  if (chain !== 137n) throw new Error('The agent requires Polygon, chain 137')
  const blockNumber = Number(height)
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) throw new Error('Invalid Polygon block')
  if (!account) return { chainId: 137, blockNumber }
  const [balanceWei] = await read([{ jsonrpc: '2.0', id: ++nextId, method: 'eth_getBalance', params: [account, `0x${height.toString(16)}`] }])
  return { chainId: 137, blockNumber, account, balanceWei }
}
