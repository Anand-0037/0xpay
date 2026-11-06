// Covers fetch/XHR from this page. Anon-RPC's worker and browser-initiated
// loads run in other contexts, so these counters are not a whole-browser audit.
import { APP_RPC_URL, PRIVACY_NETWORKS, workerBootstrapParams, type PrivacyNetwork } from '../rpc/networks.ts'
import { isPublicResearchBody } from './research-egress.ts'
export type TrafficKind = 'app-static' | 'bootstrap' | 'worker-bundle' | 'market-api' | 'research-api' | 'poi' | 'artifacts' | 'indexer' | 'blocked'
export type TrafficEntry = Readonly<{ kind: TrafficKind; host: string; outcome: 'sent' | 'failed' | 'blocked' }>

const APP_RPC = new URL(APP_RPC_URL).href
const POI = 'https://ppoi.fdi.network/'
const ARTIFACT_HOST = 'ipfs-lb.com'
const INDEXER = 'https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql'
const MAX_RECENT = 20

const counts = new Map<TrafficKind, number>()
const recent: TrafficEntry[] = []
let bundleUrls = new Set<string>()
let installed = false

export function setWorkerBundleResolvers(urls: readonly string[]) {
  bundleUrls = new Set(urls.filter((raw) => {
    try { return new URL(raw).protocol === 'https:' } catch { return false }
  }))
}

export function trafficSnapshot() {
  return { counts: Object.fromEntries(counts) as Record<TrafficKind, number>, recent: [...recent] }
}

function record(kind: TrafficKind, host: string, outcome: TrafficEntry['outcome']) {
  counts.set(kind, (counts.get(kind) ?? 0) + 1)
  recent.unshift({ kind, host, outcome })
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT
}

function validBootstrap(body: unknown, network: PrivacyNetwork): boolean {
  if (typeof body !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 4 ||
      !('jsonrpc' in parsed) || parsed.jsonrpc !== '2.0' || !('id' in parsed) ||
      typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id) || parsed.id < 0 ||
      !('method' in parsed) || !('params' in parsed)) return false
    return workerBootstrapParams({ method: parsed.method, params: parsed.params }, network) !== null
  } catch { return false }
}

export function classifyOutgoingRequest(raw: string, method: string, body: unknown, appOrigin: string,
  resolvers: ReadonlySet<string> = bundleUrls, paymentServices = false, privacyNetwork: PrivacyNetwork = 'nym', marketData = false): TrafficKind {
  let url: URL
  try { url = new URL(raw, appOrigin) } catch { return 'blocked' }
  if (url.origin === appOrigin && url.pathname.startsWith('/api/')) {
    if (!marketData || url.search || url.hash || url.username || url.password) return 'blocked'
    if (url.pathname === '/api/status' && method.toUpperCase() === 'GET' && body == null) return 'research-api'
    return url.pathname === '/api/research' && method.toUpperCase() === 'POST' && isPublicResearchBody(body) ? 'research-api' : 'blocked'
  }
  if (url.origin === appOrigin && ['http:', 'https:'].includes(url.protocol) &&
    method.toUpperCase() === 'GET' && !url.search) return 'app-static'
  const bootstrapRpc = new URL(PRIVACY_NETWORKS[privacyNetwork].bootstrapRpc).href
  // Nox bootstraps on Sepolia too. Only these fixed, non-user lookups may
  // precede the worker; every application RPC request remains blocked.
  if (url.href === bootstrapRpc) return method.toUpperCase() === 'POST' && validBootstrap(body, privacyNetwork) ? 'bootstrap' : 'blocked'
  if (url.href === APP_RPC) return 'blocked'
  // Market HTTP goes through the worker's explicit allowlisted transport too.
  // Do not silently permit a dependency to bypass it with page fetch/XHR.
  if (resolvers.has(url.href) && method.toUpperCase() === 'GET') return 'worker-bundle'
  if (paymentServices && url.href === POI && method.toUpperCase() === 'POST') return 'poi'
  if (paymentServices && url.hostname === ARTIFACT_HOST && url.protocol === 'https:' && url.pathname.startsWith('/ipfs/') &&
    method.toUpperCase() === 'GET' && !url.search) return 'artifacts'
  if (paymentServices && url.href === INDEXER && method.toUpperCase() === 'POST') return 'indexer'
  return 'blocked'
}

export function installNetworkGuard({ paymentServices = false, privacyNetwork = 'nym', marketData = false }: { paymentServices?: boolean; privacyNetwork?: PrivacyNetwork; marketData?: boolean } = {}) {
  if (installed || typeof window === 'undefined') return
  installed = true
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const kind = classifyOutgoingRequest(raw, method, init?.body, window.location.origin, bundleUrls, paymentServices, privacyNetwork, marketData)
    const host = safeHost(raw, window.location.href)
    if (kind === 'blocked') {
      record(kind, host, 'blocked')
      throw new Error(`Network guard blocked ${host}`)
    }
    try {
      // Do not let an approved destination forward a page request to an unapproved host.
      const response = await originalFetch(input, { ...init, redirect: 'error' })
      record(kind, host, response.ok ? 'sent' : 'failed')
      return response
    } catch (error) { record(kind, host, 'failed'); throw error }
  }

  if (typeof XMLHttpRequest === 'undefined') return
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  const requests = new WeakMap<XMLHttpRequest, { raw: string; method: string }>()
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: [boolean?, string?, string?]) {
    requests.set(this, { raw: String(url), method })
    return originalOpen.call(this, method, url, args[0] ?? true, args[1], args[2])
  }
  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const details = requests.get(this)
    if (!details) throw new Error('Network guard saw XHR without open')
    const kind = classifyOutgoingRequest(details.raw, details.method, body, window.location.origin, bundleUrls, paymentServices, privacyNetwork, marketData)
    const host = safeHost(details.raw, window.location.href)
    if (kind === 'blocked') {
      record(kind, host, 'blocked')
      throw new Error(`Network guard blocked ${host}`)
    }
    this.addEventListener('loadend', () => record(kind, host, this.status >= 200 && this.status < 300 ? 'sent' : 'failed'), { once: true })
    try { return originalSend.call(this, body) }
    catch (error) { record(kind, host, 'failed'); throw error }
  }
}

function safeHost(raw: string, base: string) {
  try { return new URL(raw, base).host } catch { return '(invalid URL)' }
}
