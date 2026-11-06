import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { AbiCoder } from 'ethers'
import { setWorkerBundleResolvers } from './net/network-guard.ts'
import { isPublicMarketRead } from './net/market-egress.ts'
import { APP_RPC_URL, AGENT_RPC_URL, PRIVACY_NETWORKS, workerBootstrapParams, type PrivacyNetwork } from './rpc/networks.ts'
export { APP_RPC_URL, PRIVACY_NETWORKS, privacyNetworkFromSearch, type PrivacyNetwork } from './rpc/networks.ts'

const WORKER_RESOLVERS_SELECTOR = '0x1c67ff29'
const READ_TIMEOUT_MS = 60_000
// A cold mixnet worker can need substantially longer than a warm RPC request.
const CONNECT_TIMEOUT_MS = 90_000
const MAX_PUBLIC_MARKET_BYTES = 2_000_000
let nextId = 1

export type MethodCount = Readonly<{ attempted: number; completed: number; failed: number }>
export type RouteStats = Readonly<{
  attempted: number; completed: number; failed: number; bootstrapReads: number
  methodCounts?: Readonly<Record<string, MethodCount>>
  /** Fully buffered HTTP 2xx responses, not validated market facts or RPC calls. */
  publicMarketCounts?: MethodCount
}>
export type RouteStatus = 'connecting' | 'ready' | 'degraded' | 'failed' | 'closed'
type Worker = { ready: Promise<unknown>; fetch: (url: string, init: RequestInit) => Promise<Response>; close: () => void }
type WorkerFactory = (onBootstrap: (selector: string, result: unknown) => void, requestBootstrap: (payload: unknown) => Promise<string>) => Worker

class PublicMarketResponseError extends Error {}

async function boundedPublicMarketBody(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  const announced = response.headers.get('content-length')
  if (announced && (!/^\d+$/.test(announced) || BigInt(announced) > BigInt(MAX_PUBLIC_MARKET_BYTES))) {
    void response.body?.cancel().catch(() => {})
    throw new PublicMarketResponseError('Public market response is too large')
  }
  if (!response.body) return null
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > MAX_PUBLIC_MARKET_BYTES) throw new PublicMarketResponseError('Public market response is too large')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally {
    signal.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Keep telemetry bounded to known method names. Never retain params, IDs, raw
// transaction bytes, or arbitrary strings supplied as a JSON-RPC method.
const COUNTED_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_call', 'eth_getLogs',
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

async function bootstrapRequest(value: unknown, network: PrivacyNetwork, signal: AbortSignal) {
  const params = workerBootstrapParams(value, network)
  if (!params) throw new Error('Direct RPC is reserved for worker bootstrap')
  const label = PRIVACY_NETWORKS[network].label
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new Error(`${label} worker bootstrap was cancelled`)
    const id = nextId++
    let response: Response
    try {
      response = await fetch(PRIVACY_NETWORKS[network].bootstrapRpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_call', params }),
      })
    } catch (error) {
      if (signal.aborted) throw new Error(`${label} worker bootstrap was cancelled`)
      // Retry only a failed network/timeout lookup of this exact public worker
      // record. JSON-RPC/ABI errors and account/transaction calls never enter it.
      const transient = error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError'
      if (transient && attempt === 0) continue
      throw new Error(`${label} worker bootstrap ${transient ? 'network request failed after two attempts' : 'request failed'}`)
    }
    if (signal.aborted) throw new Error(`${label} worker bootstrap was cancelled`)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (attempt === 0 && [408, 429, 500, 502, 503, 504].includes(response.status)) continue
      throw new Error(`${label} worker bootstrap returned HTTP ${response.status}`)
    }
    let payload: unknown
    try { payload = await response.json() }
    catch { throw new Error(`${label} worker bootstrap did not return valid JSON`) }
    if (signal.aborted) throw new Error(`${label} worker bootstrap was cancelled`)
    if (typeof payload !== 'object' || payload === null || !('result' in payload) ||
      !('id' in payload) || payload.id !== id || !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' ||
      'error' in payload || typeof payload.result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(payload.result)) {
      throw new Error(`${label} worker bootstrap did not return a valid worker record`)
    }
    try {
      if (params[0].data === WORKER_RESOLVERS_SELECTOR) AbiCoder.defaultAbiCoder().decode(['string[]'], payload.result)
      else if (!/^0x[0-9a-f]{64}$/i.test(payload.result)) throw new Error('Invalid hash')
    } catch { throw new Error(`${label} worker bootstrap returned a malformed worker record`) }
    return payload.result
  }
  throw new Error(`${label} worker bootstrap failed`)
}

export class PrivateRpc {
  readonly network: PrivacyNetwork
  readonly chain: 'sepolia' | 'polygon-readonly'
  readonly rpcUrl: string
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
  private publicMarketCounts = { attempted: 0, completed: 0, failed: 0 }
  private marketControllers = new Set<AbortController>()
  private resolverUrls = new Set<string>()
  private bootstrapController = new AbortController()
  constructor(workerFactory?: WorkerFactory, network: PrivacyNetwork = 'nym', chain: 'sepolia' | 'polygon-readonly' = 'sepolia') {
    if (chain !== 'sepolia' && chain !== 'polygon-readonly') throw new Error('Unsupported private RPC chain')
    this.network = network
    this.chain = chain
    this.rpcUrl = chain === 'polygon-readonly' ? AGENT_RPC_URL : APP_RPC_URL
    this.workerFactory = workerFactory ?? ((_onBootstrap, requestBootstrap) => new AnonRpcWorker({
      address: PRIVACY_NETWORKS[network].specifier, preExisting: { rpcProvider: { request: requestBootstrap } },
    }) as Worker)
    this.worker = this.makeWorker()
  }
  private makeWorker() {
    const generation = this.generation
    const controller = new AbortController()
    this.bootstrapController = controller
    const onBootstrap = (selector: string, result: unknown) => {
      if (generation === this.generation && this.statusValue !== 'closed') this.recordBootstrap(selector, result)
    }
    const requestBootstrap = async (payload: unknown) => {
      if (generation !== this.generation || controller.signal.aborted) throw new Error('Worker bootstrap route was replaced or disconnected')
      const result = await bootstrapRequest(payload, this.network, controller.signal)
      if (generation !== this.generation || controller.signal.aborted) throw new Error('Worker bootstrap route was replaced or disconnected')
      const params = workerBootstrapParams(payload, this.network)!
      onBootstrap(params[0].data, result)
      return result
    }
    return this.workerFactory(onBootstrap, requestBootstrap)
  }
  private closeWorker() {
    this.bootstrapController.abort()
    for (const controller of this.marketControllers) controller.abort(new Error('Private market route was disconnected or replaced'))
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
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${PRIVACY_NETWORKS[this.network].label} connection timed out`)), CONNECT_TIMEOUT_MS) }),
      ])
      // A replaced worker may finish starting after Reconnect has installed a
      // new one. Its old startup must never issue requests on the new route.
      if (generation !== this.generation) throw new Error('Private RPC connection was replaced')
      const chainId = await this.readHex('eth_chainId')
      if (generation !== this.generation) throw new Error('Private RPC connection was replaced')
      if (chainId.toLowerCase() !== (this.chain === 'polygon-readonly' ? '0x89' : '0xaa36a7')) throw new Error(`Unexpected chain ${chainId}`)
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
      publicMarketCounts: { ...this.publicMarketCounts },
      methodCounts: Object.fromEntries([...this.methodCounts].map(([method, counts]) => [method, { ...counts }])) }
  }
  /** Only the two public venue GETs; no auth, account queries, orders or direct fallback.
   * An HTTP rejection fails this request but does not invalidate a healthy RPC
   * connection. Worker/timeout failures degrade the route; caller cancellation
   * does not. These HTTP counters never increment blockchain RPC method counts.
   */
  async fetchPublicMarket(rawUrl: string, signal?: AbortSignal): Promise<Response> {
    let url: URL
    try { url = new URL(rawUrl) } catch { throw new Error('Unsupported public market request') }
    if (!isPublicMarketRead(url, 'GET', undefined)) throw new Error('Unsupported public market request')
    if (this.statusValue !== 'ready') throw new Error('Private market route needs reconnecting')
    signal?.throwIfAborted()
    const generation = this.generation, worker = this.worker, controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    this.marketControllers.add(controller)
    this.publicMarketCounts.attempted++
    const timer = setTimeout(() => controller.abort(new Error('Private market request timed out')), READ_TIMEOUT_MS)
    let onAbort: (() => void) | undefined
    try {
      const response = await Promise.race([
        (async () => {
          controller.signal.throwIfAborted()
          const result = await worker.fetch(url.href, {
            method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal,
            credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
          })
          if (controller.signal.aborted) {
            void result.body?.cancel().catch(() => {})
            controller.signal.throwIfAborted()
          }
          if (result.redirected || result.url && result.url !== url.href) {
            void result.body?.cancel().catch(() => {})
            throw new PublicMarketResponseError('Public market redirects are not permitted')
          }
          const bytes = await boundedPublicMarketBody(result, controller.signal)
          return new Response(bytes, { status: result.status, statusText: result.statusText, headers: result.headers })
        })(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'))
          controller.signal.addEventListener('abort', onAbort, { once: true })
          if (controller.signal.aborted) onAbort()
        }),
      ])
      controller.signal.throwIfAborted()
      if (generation !== this.generation || this.statusValue !== 'ready') throw new Error('Private market response came from a replaced or stopped route')
      this.publicMarketCounts[response.ok ? 'completed' : 'failed']++
      return response
    } catch (error) {
      this.publicMarketCounts.failed++
      if (generation === this.generation && this.statusValue === 'ready' && !signal?.aborted && !(error instanceof PublicMarketResponseError)) this.statusValue = 'degraded'
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      this.marketControllers.delete(controller)
    }
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
    if (this.chain === 'polygon-readonly') {
      const value: unknown = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
      const calls: unknown[] = Array.isArray(value) ? value : [value]
      const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getCode', 'eth_call'])
      if (!calls.length || calls.length > 32 || calls.some(call => !call || typeof call !== 'object' ||
        !('method' in call) || typeof call.method !== 'string' || !allowed.has(call.method))) {
        throw new Error('The agent Polygon connection permits read-only RPC methods only')
      }
    }
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
          const result = await worker.fetch(this.rpcUrl, {
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
