// Page fetch/XHR guard. Worker traffic is outside this page and counted by PrivateRpc.
import { APP_RPC_URL, FAUCET_RPC_URL, LOCAL_RPC_URL, LOCAL_MEMPOOL_URL, MEMPOOL_RPC_URL, PRIVACY_NETWORKS, workerBootstrapParams, type PrivacyNetwork } from '../rpc/networks.ts'
export type TrafficKind = 'app-static' | 'bootstrap' | 'worker-bundle' | 'artifacts' | 'blocked'
export type TrafficEntry = Readonly<{ kind: TrafficKind; host: string; outcome: 'sent' | 'failed' | 'blocked' }>
const counts = new Map<TrafficKind, number>()
const recent: TrafficEntry[] = []
let bundleUrls = new Set<string>()
let installed = false
export function setWorkerBundleResolvers(urls: readonly string[]) { bundleUrls = new Set(urls.filter(raw => { try { return new URL(raw).protocol === 'https:' } catch { return false } })) }
export function trafficSnapshot() { return { counts: Object.fromEntries(counts) as Record<TrafficKind, number>, recent: [...recent] } }
function record(kind: TrafficKind, host: string, outcome: TrafficEntry['outcome']) { counts.set(kind, (counts.get(kind) ?? 0) + 1); recent.unshift({ kind, host, outcome }); if (recent.length > 20) recent.length = 20 }
function validBootstrap(body: unknown, network: PrivacyNetwork) {
  if (typeof body !== 'string') return false
  try { const x = JSON.parse(body); return x?.jsonrpc === '2.0' && Number.isSafeInteger(x.id) && workerBootstrapParams({ method: x.method, params: x.params }, network) !== null } catch { return false }
}
export function classifyOutgoingRequest(raw: string, method: string, body: unknown, appOrigin: string, resolvers: ReadonlySet<string> = bundleUrls, privacyNetwork: PrivacyNetwork = 'nym'): TrafficKind {
  let url: URL
  try { url = new URL(raw, appOrigin) } catch { return 'blocked' }
  if (url.origin === appOrigin && method.toUpperCase() === 'GET' && !url.search) return 'app-static'
  if (url.href === new URL(PRIVACY_NETWORKS[privacyNetwork].bootstrapRpc).href) return method.toUpperCase() === 'POST' && validBootstrap(body, privacyNetwork) ? 'bootstrap' : 'blocked'
  if (resolvers.has(url.href) && method.toUpperCase() === 'GET') return 'worker-bundle'
  if ([APP_RPC_URL, MEMPOOL_RPC_URL, FAUCET_RPC_URL, LOCAL_RPC_URL, LOCAL_MEMPOOL_URL].includes(url.href)) return 'blocked'
  return 'blocked'
}
export function installNetworkGuard({ privacyNetwork = 'nym' }: { privacyNetwork?: PrivacyNetwork } = {}) {
  if (installed || typeof window === 'undefined') return
  installed = true
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input), method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const kind = classifyOutgoingRequest(raw, method, init?.body, window.location.origin, bundleUrls, privacyNetwork), host = new URL(raw, window.location.href).host
    if (kind === 'blocked') { record(kind, host, 'blocked'); throw new Error(`Network guard blocked ${host}`) }
    try { const response = await originalFetch(input, { ...init, redirect: 'error' }); record(kind, host, response.ok ? 'sent' : 'failed'); return response } catch (error) { record(kind, host, 'failed'); throw error }
  }
  if (typeof XMLHttpRequest === 'undefined') return
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  const requests = new WeakMap<XMLHttpRequest, { raw: string; method: string }>()
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: [boolean?, string?, string?]) {
    requests.set(this, { method, raw: String(url) })
    return originalOpen.call(this, method, url, args[0] ?? true, args[1], args[2])
  }
  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const request = requests.get(this)
    if (!request) throw new Error('Network guard saw XHR without open')
    const kind = classifyOutgoingRequest(request.raw, request.method, body, window.location.origin, bundleUrls, privacyNetwork)
    const host = new URL(request.raw, window.location.href).host
    if (kind === 'blocked') { record(kind, host, 'blocked'); throw new Error(`Network guard blocked ${host}`) }
    this.addEventListener('loadend', () => record(kind, host, this.status >= 200 && this.status < 300 ? 'sent' : 'failed'), { once: true })
    return originalSend.call(this, body)
  }

}
