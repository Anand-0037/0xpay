import { AnonRpcWorker } from '@anon-rpc/browser-harness'

const BOOTSTRAP_RPC_URL = 'https://ethereum-rpc.publicnode.com'
const APP_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
const NYM_SPECIFIER = '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0'
const BOOTSTRAP_SELECTORS = new Set(['0x3898587d', '0x1c67ff29'])
const READ_TIMEOUT_MS = 20_000
let nextId = 1

export type RouteStats = Readonly<{ attempted: number; completed: number; failed: number; bootstrapReads: number }>

async function bootstrapRequest({ method, params }: { method: string; params?: unknown[] }) {
  const call = params?.[0]
  if (method !== 'eth_call' || typeof call !== 'object' || call === null || !('to' in call) || !('data' in call) ||
    typeof call.to !== 'string' || typeof call.data !== 'string' ||
    call.to.toLowerCase() !== NYM_SPECIFIER.toLowerCase() || !BOOTSTRAP_SELECTORS.has(call.data) || params?.[1] !== 'latest') {
    throw new Error('Direct RPC is reserved for worker bootstrap')
  }
  const response = await fetch(BOOTSTRAP_RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  if (!response.ok) throw new Error(`Bootstrap RPC returned HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (typeof payload !== 'object' || payload === null || !('result' in payload)) throw new Error('Bootstrap RPC did not return a result')
  return payload.result
}

export class PrivateRpc {
  private worker: AnonRpcWorker
  private attempted = 0
  private completed = 0
  private failed = 0
  private bootstrapReads = 0
  constructor() {
    this.worker = new AnonRpcWorker({ address: NYM_SPECIFIER, preExisting: { rpcProvider: { request: async (payload: { method: string; params?: unknown[] }) => {
      const result = await bootstrapRequest(payload)
      this.bootstrapReads += 1
      return result
    } } } })
  }
  async connect() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.worker.ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Nym connection timed out')), 30_000) }),
      ])
    } finally { if (timer) clearTimeout(timer) }
    const chainId = await this.readHex('eth_chainId')
    if (chainId.toLowerCase() !== '0xaa36a7') throw new Error(`Unexpected chain ${chainId}`)
    return { chainId, blockNumber: Number.parseInt(await this.readHex('eth_blockNumber'), 16) }
  }
  get stats(): RouteStats {
    return { attempted: this.attempted, completed: this.completed, failed: this.failed,
      bootstrapReads: this.bootstrapReads }
  }
  private async readHex(method: string): Promise<string> {
    this.attempted += 1
    const id = nextId++
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        this.worker.fetch(APP_RPC_URL, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error(`Private RPC ${method} timed out`)) }, READ_TIMEOUT_MS)
        }),
      ])
      if (!response.ok) throw new Error(`Private RPC returned HTTP ${response.status}`)
      const payload: unknown = await response.json()
      if (typeof payload !== 'object' || payload === null || !('result' in payload) ||
        !('id' in payload) || payload.id !== id || !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' ||
        typeof payload.result !== 'string' || !/^0x[0-9a-f]+$/i.test(payload.result)) throw new Error(`Private RPC did not return a valid ${method} response`)
      this.completed += 1
      return payload.result
    } catch (error) {
      this.failed += 1
      this.worker.close()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  close() { this.worker.close() }
}
