import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { AbiCoder } from 'ethers'
import { setWorkerBundleResolvers } from './net/network-guard.ts'
import { APP_RPC_URL, LOCAL_RPC_URL, LOCAL_MEMPOOL_URL, PRIVACY_NETWORKS, workerBootstrapParams, type PrivacyNetwork, type ChainNetwork } from './rpc/networks.ts'
export { APP_RPC_URL, PRIVACY_NETWORKS, privacyNetworkFromSearch, type PrivacyNetwork } from './rpc/networks.ts'

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
export type RouteFailure = Readonly<{
  kind: 'connect-timeout' | 'request-timeout' | 'http' | 'worker' | 'protocol'
  message: string
  httpStatus?: number
}>
type Connection = { chainId: string; blockNumber: number }
export class PrivateRpcLifecycleError extends Error {
  readonly reason: 'replaced' | 'disconnected' | 'closed'
  constructor(reason: PrivateRpcLifecycleError['reason']) {
    super(`Private RPC route was ${reason}`)
    this.name = 'PrivateRpcLifecycleError'
    this.reason = reason
  }
}
class DependencyError extends Error {
  readonly failure: RouteFailure
  constructor(failure: RouteFailure) { super(failure.message); this.name = 'PrivateRpcDependencyError'; this.failure = failure }
}
type Worker = { ready: Promise<unknown>; fetch: (url: string, init: RequestInit) => Promise<Response>; close: () => void }
type WorkerFactory = (onBootstrap: (selector: string, result: unknown) => void) => Worker

// Some worker implementations do not reject ready/fetch when closed. Race the
// lifecycle explicitly so a replaced route cannot hold callers until timeout.
function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      operation().then(value => { signal.removeEventListener('abort', aborted); resolve(value) },
        error => { signal.removeEventListener('abort', aborted); reject(error) })
    } catch (error) { signal.removeEventListener('abort', aborted); reject(error) }
  })
}

// Keep telemetry bounded to known method names. Never retain params, IDs, raw
// transaction bytes, or arbitrary strings supplied as a JSON-RPC method.
const COUNTED_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_getLogs',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash',
  'eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas',
  'net_version', 'web3_clientVersion', 'eth_sendRawTransaction', 'eth_sendFrameTransaction', 'eth_estimateFrameTransactionGas', 'ethrex_simulateFrameTransaction', 'skandha_frameTransactionStatus',
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

async function bootstrapRequest(value: unknown, network: PrivacyNetwork) {
  const params = workerBootstrapParams(value, network)
  if (!params) throw new Error('Direct RPC is reserved for worker bootstrap')
  const id = nextId++
  const response = await fetch(PRIVACY_NETWORKS[network].bootstrapRpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_call', params }),
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
  readonly network: PrivacyNetwork
  readonly chain: ChainNetwork
  readonly rpcUrl: string
  private readonly workerFactory: WorkerFactory
  private worker: Worker
  private workerClosed = false
  private generation = 0
  private generationAbort = new AbortController()
  private connectionAttempt: { generation: number; kind: 'initial' | 'reconnect'; promise: Promise<Connection> } | null = null
  private statusValue: RouteStatus = 'connecting'
  private failureValue: RouteFailure | null = null
  private attempted = 0
  private completed = 0
  private failed = 0
  private bootstrapReads = 0
  private methodCounts = new Map<string, { attempted: number; completed: number; failed: number }>()
  private resolverUrls = new Set<string>()
  constructor(workerFactory?: WorkerFactory, network: PrivacyNetwork = 'nym', chain: ChainNetwork = 'devnet') {
    if (chain !== 'devnet' && chain !== 'local') throw new Error('Unsupported private RPC chain')
    this.network = network
    this.chain = chain
    this.rpcUrl = chain === 'local' ? LOCAL_RPC_URL : APP_RPC_URL
    this.workerFactory = workerFactory ?? ((onBootstrap) => new AnonRpcWorker({
      address: PRIVACY_NETWORKS[network].specifier, preExisting: { rpcProvider: { request: async (payload: { method: string; params?: unknown[] }) => {
        const result = await bootstrapRequest(payload, network)
        const params = workerBootstrapParams(payload, network)!
        onBootstrap(params[0].data, result)
        return result
      } } },
    }) as Worker)
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
    this.worker.close()
    this.workerClosed = true
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
  get failure(): RouteFailure | null { return this.failureValue ? { ...this.failureValue } : null }
  connect(): Promise<Connection> {
    if (this.statusValue === 'closed') return Promise.reject(new PrivateRpcLifecycleError('closed'))
    if (this.statusValue === 'degraded' || this.statusValue === 'failed') return Promise.reject(new Error('Private RPC route needs reconnecting'))
    if (this.connectionAttempt?.generation === this.generation) return this.connectionAttempt.promise
    return this.startConnection('initial')
  }
  private startConnection(kind: 'initial' | 'reconnect'): Promise<Connection> {
    const generation = this.generation
    const promise = this.connectWorker(generation, this.worker, this.generationAbort)
    const attempt = { generation, kind, promise }
    this.connectionAttempt = attempt
    const clear = () => { if (this.connectionAttempt === attempt) this.connectionAttempt = null }
    void promise.then(clear, clear)
    return promise
  }
  private dependencyFailure(error: unknown, operation: 'connect' | 'request'): RouteFailure {
    return error instanceof DependencyError ? error.failure : {
      kind: 'worker', message: `${PRIVACY_NETWORKS[this.network].label} worker ${operation} failed. Reconnect to continue.`,
    }
  }
  private async connectWorker(generation: number, worker: Worker, cancellation: AbortController): Promise<Connection> {
    this.statusValue = 'connecting'
    this.failureValue = null
    const timer = setTimeout(() => cancellation.abort(new DependencyError({ kind: 'connect-timeout', message: `${PRIVACY_NETWORKS[this.network].label} connection timed out` })), CONNECT_TIMEOUT_MS)
    try {
      await abortable(cancellation.signal, () => worker.ready)
      // A replaced worker may finish starting after Reconnect has installed a
      // new one. Its old startup must never issue requests on the new route.
      if (generation !== this.generation) throw new PrivateRpcLifecycleError('replaced')
      if (import.meta.env?.DEV) console.info('[private-rpc] connected worker; reading chain ID', this.rpcUrl)
      const chainId = await this.readHex('eth_chainId')
      if (generation !== this.generation) throw new PrivateRpcLifecycleError('replaced')
      if (BigInt(chainId) !== (this.chain === 'local' ? BigInt(import.meta.env?.VITE_LOCAL_CHAIN_ID || '1337') : 1337n)) throw new DependencyError({ kind: 'protocol', message: `Unexpected chain ${chainId}` })
      const block = BigInt(await this.readHex('eth_blockNumber'))
      if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new DependencyError({ kind: 'protocol', message: 'Private RPC returned an unsafe block number' })
      const blockNumber = Number(block)
      if (import.meta.env?.DEV) console.info('[private-rpc] connected chain', { chainId, blockNumber })
      if (generation !== this.generation) throw new PrivateRpcLifecycleError('replaced')
      this.statusValue = 'ready'
      return { chainId, blockNumber }
    } catch (error) {
      if (generation === this.generation) {
        this.statusValue = 'failed'
        this.failureValue = this.dependencyFailure(error, 'connect')
        cancellation.abort(error)
        try { this.closeWorker() } catch { this.failureValue = { kind: 'worker', message: 'Private worker cleanup failed. Reload before reconnecting.' } }
        this.resolverUrls.clear()
        setWorkerBundleResolvers([])
      }
      throw error
    } finally { clearTimeout(timer) }
  }
  reconnect(): Promise<Connection> {
    if (this.statusValue === 'closed') return Promise.reject(new PrivateRpcLifecycleError('closed'))
    if (this.statusValue === 'connecting' && this.connectionAttempt?.generation === this.generation && this.connectionAttempt.kind === 'reconnect') return this.connectionAttempt.promise
    this.generation += 1
    this.generationAbort.abort(new PrivateRpcLifecycleError('replaced'))
    try { this.closeWorker() } catch {
      this.statusValue = 'failed'
      this.failureValue = { kind: 'worker', message: 'Private worker cleanup failed. Reload before reconnecting.' }
      return Promise.reject(new Error(this.failureValue.message))
    }
    this.resolverUrls.clear()
    setWorkerBundleResolvers([])
    this.generationAbort = new AbortController()
    this.statusValue = 'connecting'
    try { this.worker = this.makeWorker(); this.workerClosed = false }
    catch (error) {
      this.statusValue = 'failed'
      this.failureValue = this.dependencyFailure(error, 'connect')
      this.generationAbort.abort(error)
      return Promise.reject(error)
    }
    return this.startConnection('reconnect')
  }
  disconnect() {
    if (this.statusValue === 'closed') return
    this.generation += 1
    this.statusValue = 'degraded'
    this.failureValue = null
    this.generationAbort.abort(new PrivateRpcLifecycleError('disconnected'))
    try { this.closeWorker() } catch { this.failureValue = { kind: 'worker', message: 'Private worker cleanup failed. Reload before reconnecting.' } }
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
  async fetchRpc(body: string | Uint8Array, targetUrl: string = this.rpcUrl): Promise<Response> {
    if (this.statusValue !== 'ready' && this.statusValue !== 'connecting') throw new Error('Private RPC route needs reconnecting')
    const allowedUrls = this.chain === 'local' ? [this.rpcUrl, LOCAL_MEMPOOL_URL] : [this.rpcUrl, 'https://altmempoolgateway.forshtat.com/rpc', 'https://altmempool.forshtat.com/rpc']
    if (!allowedUrls.includes(targetUrl)) throw new Error('Unapproved worker RPC target')
    const generation = this.generation
    const worker = this.worker
    const cancellation = this.generationAbort
    const methods = countedMethods(body)
    this.attempted += 1
    this.countMethods(methods, 'attempted')
    const controller = new AbortController()
    const routeAborted = () => controller.abort(cancellation.signal.reason)
    cancellation.signal.addEventListener('abort', routeAborted, { once: true })
    if (cancellation.signal.aborted) routeAborted()
    const timer = setTimeout(() => controller.abort(new DependencyError({ kind: 'request-timeout', message: 'Private RPC read timed out' })), READ_TIMEOUT_MS)
    try {
      const response = await abortable(controller.signal,
        async () => {
          const result = await worker.fetch(targetUrl, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: typeof body === 'string' ? body : new Uint8Array(body).buffer,
          })
          const bytes = await result.arrayBuffer()
          return new Response(bytes, { status: result.status, statusText: result.statusText, headers: result.headers })
        })
      if (generation !== this.generation) throw new PrivateRpcLifecycleError('replaced')
      // Another concurrent request can stop this same worker while this reply
      // is in flight. Do not release that late reply as fresh wallet state.
      if (this.statusValue !== 'ready' && this.statusValue !== 'connecting') {
        throw new Error('Private RPC route stopped before the response arrived')
      }
      if (!response.ok) throw new DependencyError({ kind: 'http', message: `Private RPC returned HTTP ${response.status}`, httpStatus: response.status })
      this.completed += 1
      this.countMethods(methods, 'completed')
      return response
    } catch (error) {
      this.failed += 1
      this.countMethods(methods, 'failed')
      if (import.meta.env?.DEV && !(error instanceof PrivateRpcLifecycleError)) console.warn('[private-rpc] request failed', { methods, targetUrl, error: String(error) })
      if (generation === this.generation && !(error instanceof PrivateRpcLifecycleError)) {
        this.statusValue = 'degraded'
        this.failureValue = this.dependencyFailure(error, 'request')
        cancellation.abort(error)
      }
      throw error
    } finally {
      clearTimeout(timer)
      cancellation.signal.removeEventListener('abort', routeAborted)
    }
  }
  private async readHex(method: string): Promise<string> {
    const id = nextId++
    const response = await this.fetchRpc(JSON.stringify({ jsonrpc: '2.0', id, method, params: [] }))
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null || !('result' in payload) ||
      !('id' in payload) || payload.id !== id || !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' ||
      'error' in payload || typeof payload.result !== 'string' ||
      !/^0x[0-9a-f]+$/i.test(payload.result)) throw new DependencyError({ kind: 'protocol', message: `Private RPC did not return a valid ${method} response` })
    return payload.result
  }
  close() {
    if (this.statusValue === 'closed') return
    this.generation += 1
    this.statusValue = 'closed'
    this.generationAbort.abort(new PrivateRpcLifecycleError('closed'))
    this.resolverUrls.clear()
    setWorkerBundleResolvers([])
    try { this.closeWorker() } catch { this.failureValue = { kind: 'worker', message: 'Private worker cleanup failed. Reload before reconnecting.' } }
  }
}
