import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { AbiCoder } from 'ethers'
import { setWorkerBundleResolvers } from './net/network-guard.ts'

const BOOTSTRAP_RPC_URL = 'https://ethereum-rpc.publicnode.com'
export const APP_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
// Published Nym specifier in the official Anon-RPC network catalogue:
// https://ethereum.github.io/anon-rpc/adopters/
const NYM_SPECIFIER = '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0'
const BOOTSTRAP_SELECTORS = new Set(['0x3898587d', '0x1c67ff29'])
const WORKER_RESOLVERS_SELECTOR = '0x1c67ff29'
const READ_TIMEOUT_MS = 60_000
// A cold mixnet worker can need substantially longer than a warm RPC request.
const CONNECT_TIMEOUT_MS = 90_000
let nextId = 1

export type MethodCount = Readonly<{ attempted: number; completed: number; failed: number }>
export type RouteStats = Readonly<{
  attempted: number; completed: number; failed: number; bootstrapReads: number
  methodCounts?: Readonly<Record<string, MethodCount>>
}>
export type RouteStatus = 'connecting' | 'ready' | 'degraded' | 'failed' | 'closed'
type Worker = { ready: Promise<unknown>; fetch: (url: string, init: RequestInit) => Promise<Response>; close: () => void }
type WorkerFactory = (onBootstrap: (selector: string, result: unknown) => void) => Worker

// Keep telemetry bounded to known method names. Never retain params, IDs, raw
// transaction bytes, or arbitrary strings supplied as a JSON-RPC method.
const COUNTED_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_call', 'eth_getLogs',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash',
  'eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas',
  'net_version', 'web3_clientVersion', 'eth_sendRawTransaction',
])

function countedMethods(body: string | Uint8Array): string[] {
  try {
    const value: unknown = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
    const calls = Array.isArray(value) ? value : [value]
    if (!calls.length) return ['other']
    return calls.map((call: unknown) => {
      if (typeof call !== 'object' || call === null || !('method' in call) ||
        typeof call.method !== 'string' || !COUNTED_METHODS.has(call.method)) return 'other'
      return call.method
    })
  } catch { return ['other'] }
}

async function bootstrapRequest({ method, params }: { method: string; params?: unknown[] }) {
  const call = params?.[0]
  if (method !== 'eth_call' || typeof call !== 'object' || call === null || !('to' in call) || !('data' in call) ||
    typeof call.to !== 'string' || typeof call.data !== 'string' ||
    call.to.toLowerCase() !== NYM_SPECIFIER.toLowerCase() || !BOOTSTRAP_SELECTORS.has(call.data) || params?.[1] !== 'latest') {
    throw new Error('Direct RPC is reserved for worker bootstrap')
  }
  const id = nextId++
  const response = await fetch(BOOTSTRAP_RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  if (!response.ok) throw new Error(`Bootstrap RPC returned HTTP ${response.status}`)
  const payload: unknown = await response.json()
  if (typeof payload !== 'object' || payload === null || !('result' in payload) ||
    !('id' in payload) || payload.id !== id || !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' ||
    'error' in payload || typeof payload.result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(payload.result)) {
    throw new Error('Bootstrap RPC did not return a valid worker record')
  }
  return payload.result
}

export class PrivateRpc {
  private readonly workerFactory: WorkerFactory
  private worker: Worker
  private workerClosed = false
  private generation = 0
  private statusValue: RouteStatus = 'connecting'
  private attempted = 0
  private completed = 0
  private failed = 0
  private bootstrapReads = 0
  private methodCounts = new Map<string, { attempted: number; completed: number; failed: number }>()
  private resolverUrls = new Set<string>()
  constructor(workerFactory: WorkerFactory = (onBootstrap) => new AnonRpcWorker({
    address: NYM_SPECIFIER, preExisting: { rpcProvider: { request: async (payload: { method: string; params?: unknown[] }) => {
      const result = await bootstrapRequest(payload)
      onBootstrap(payload.params?.[0] && typeof payload.params[0] === 'object' && 'data' in payload.params[0] && typeof payload.params[0].data === 'string' ? payload.params[0].data : '', result)
      return result
    } } },
  }) as Worker) {
    this.workerFactory = workerFactory
    this.worker = this.makeWorker()
  }
  private makeWorker() {
    const generation = this.generation
    return this.workerFactory((selector, result) => {
      if (generation === this.generation && this.statusValue !== 'closed') this.recordBootstrap(selector, result)
    })
  }
  private closeWorker() {
    if (this.workerClosed) return
    this.workerClosed = true
    this.worker.close()
  }
  private recordBootstrap(selector: string, result: unknown) {
    this.bootstrapReads += 1
    if (selector !== WORKER_RESOLVERS_SELECTOR || typeof result !== 'string') return
    const [urls] = AbiCoder.defaultAbiCoder().decode(['string[]'], result) as unknown as [string[]]
    this.resolverUrls = new Set(urls.filter((url) => url.startsWith('https://')))
    setWorkerBundleResolvers([...this.resolverUrls])
  }
  get approvedBundleResolvers() { return [...this.resolverUrls] }
  get status(): RouteStatus { return this.statusValue }
  async connect() {
    if (this.statusValue === 'closed') throw new Error('Private RPC route is closed')
    if (this.statusValue === 'degraded' || this.statusValue === 'failed') throw new Error('Private RPC route needs reconnecting')
    const generation = this.generation
    this.statusValue = 'connecting'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.worker.ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Nym connection timed out')), CONNECT_TIMEOUT_MS) }),
      ])
      // A replaced worker may finish starting after Reconnect has installed a
      // new one. Its old startup must never issue requests on the new route.
      if (generation !== this.generation) throw new Error('Private RPC connection was replaced')
      const chainId = await this.readHex('eth_chainId')
      if (generation !== this.generation) throw new Error('Private RPC connection was replaced')
      if (chainId.toLowerCase() !== '0xaa36a7') throw new Error(`Unexpected chain ${chainId}`)
      const blockNumber = Number.parseInt(await this.readHex('eth_blockNumber'), 16)
      if (generation !== this.generation) throw new Error('Private RPC connection was replaced')
      this.statusValue = 'ready'
      return { chainId, blockNumber }
    } catch (error) {
      if (generation === this.generation) {
        this.statusValue = 'failed'
        this.closeWorker()
        this.resolverUrls.clear()
        setWorkerBundleResolvers([])
      }
      throw error
    } finally { if (timer) clearTimeout(timer) }
  }
  async reconnect() {
    if (this.statusValue === 'closed') throw new Error('Private RPC route is closed')
    this.generation += 1
    this.closeWorker()
    this.resolverUrls.clear()
    setWorkerBundleResolvers([])
    this.worker = this.makeWorker()
    this.workerClosed = false
    this.statusValue = 'connecting'
    return this.connect()
  }
  disconnect() {
    if (this.statusValue === 'closed') return
    this.generation += 1
    this.statusValue = 'degraded'
    this.closeWorker()
    this.resolverUrls.clear()
    setWorkerBundleResolvers([])
  }
  get stats(): RouteStats {
    return { attempted: this.attempted, completed: this.completed, failed: this.failed,
      bootstrapReads: this.bootstrapReads,
      methodCounts: Object.fromEntries([...this.methodCounts].map(([method, counts]) => [method, { ...counts }])) }
  }
  private countMethods(methods: readonly string[], outcome: keyof MethodCount) {
    for (const method of methods) {
      let counts = this.methodCounts.get(method)
      if (!counts) { counts = { attempted: 0, completed: 0, failed: 0 }; this.methodCounts.set(method, counts) }
      counts[outcome]++
    }
  }
  async fetchRpc(body: string | Uint8Array): Promise<Response> {
    if (this.statusValue !== 'ready' && this.statusValue !== 'connecting') throw new Error('Private RPC route needs reconnecting')
    const generation = this.generation
    const worker = this.worker
    const methods = countedMethods(body)
    this.attempted += 1
    this.countMethods(methods, 'attempted')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        (async () => {
          const result = await worker.fetch(APP_RPC_URL, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: typeof body === 'string' ? body : new Uint8Array(body).buffer,
          })
          const bytes = await result.arrayBuffer()
          return new Response(bytes, { status: result.status, statusText: result.statusText, headers: result.headers })
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Private RPC read timed out')) }, READ_TIMEOUT_MS)
        }),
      ])
      if (generation !== this.generation) throw new Error('Private RPC response came from a replaced route')
      // Another concurrent request can stop this same worker while this reply
      // is in flight. Do not release that late reply as fresh wallet state.
      if (this.statusValue !== 'ready' && this.statusValue !== 'connecting') {
        throw new Error('Private RPC route stopped before the response arrived')
      }
      if (!response.ok) throw new Error(`Private RPC returned HTTP ${response.status}`)
      this.completed += 1
      this.countMethods(methods, 'completed')
      return response
    } catch (error) {
      this.failed += 1
      this.countMethods(methods, 'failed')
      if (generation === this.generation) this.statusValue = 'degraded'
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  private async readHex(method: string): Promise<string> {
    const id = nextId++
    const response = await this.fetchRpc(JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }))
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null || !('result' in payload) ||
      !('id' in payload) || payload.id !== id || !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' ||
      'error' in payload || typeof payload.result !== 'string' ||
      !/^0x[0-9a-f]+$/i.test(payload.result)) throw new Error(`Private RPC did not return a valid ${method} response`)
    return payload.result
  }
  close() {
    if (this.statusValue === 'closed') return
    this.generation += 1
    this.statusValue = 'closed'
    this.resolverUrls.clear()
    setWorkerBundleResolvers([])
    this.closeWorker()
  }
}
