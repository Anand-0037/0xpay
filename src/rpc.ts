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
let nextId = 1

export type RouteStats = Readonly<{ attempted: number; completed: number; failed: number; bootstrapReads: number }>
export type RouteStatus = 'connecting' | 'ready' | 'degraded' | 'failed' | 'closed'
type Worker = { ready: Promise<unknown>; fetch: (url: string, init: RequestInit) => Promise<Response>; close: () => void }
type WorkerFactory = (onBootstrap: (selector: string, result: unknown) => void) => Worker

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
  private readonly workerFactory: WorkerFactory
  private worker: Worker
  private generation = 0
  private statusValue: RouteStatus = 'connecting'
  private attempted = 0
  private completed = 0
  private failed = 0
  private bootstrapReads = 0
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
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Nym connection timed out')), 30_000) }),
      ])
      const chainId = await this.readHex('eth_chainId')
      if (chainId.toLowerCase() !== '0xaa36a7') throw new Error(`Unexpected chain ${chainId}`)
      const blockNumber = Number.parseInt(await this.readHex('eth_blockNumber'), 16)
      if (generation !== this.generation) throw new Error('Private RPC connection was replaced')
      this.statusValue = 'ready'
      return { chainId, blockNumber }
    } catch (error) {
      if (generation === this.generation) this.statusValue = 'failed'
      throw error
    } finally { if (timer) clearTimeout(timer) }
  }
  async reconnect() {
    if (this.statusValue === 'closed') throw new Error('Private RPC route is closed')
    this.generation += 1
    this.worker.close()
    this.resolverUrls.clear()
    setWorkerBundleResolvers([])
    this.worker = this.makeWorker()
    this.statusValue = 'connecting'
    return this.connect()
  }
  get stats(): RouteStats {
    return { attempted: this.attempted, completed: this.completed, failed: this.failed,
      bootstrapReads: this.bootstrapReads }
  }
  async fetchRpc(body: string | Uint8Array): Promise<Response> {
    if (this.statusValue !== 'ready' && this.statusValue !== 'connecting') throw new Error('Private RPC route needs reconnecting')
    const generation = this.generation
    const worker = this.worker
    this.attempted += 1
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
      if (!response.ok) throw new Error(`Private RPC returned HTTP ${response.status}`)
      this.completed += 1
      return response
    } catch (error) {
      this.failed += 1
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
    this.worker.close()
  }
}
