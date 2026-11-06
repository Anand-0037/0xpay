// Covers fetch/XHR from this page. Anon-RPC's worker and browser-initiated
// loads run in other contexts, so these counters are not a whole-browser audit.
export type TrafficKind = 'app-static' | 'bootstrap' | 'worker-bundle' | 'poi' | 'artifacts' | 'indexer' | 'blocked'
export type TrafficEntry = Readonly<{ kind: TrafficKind; host: string; outcome: 'sent' | 'failed' | 'blocked' }>

const APP_RPC = 'https://ethereum-sepolia-rpc.publicnode.com/'
const BOOTSTRAP_RPC = 'https://ethereum-rpc.publicnode.com/'
const POI = 'https://ppoi.fdi.network/'
const ARTIFACT_HOST = 'ipfs-lb.com'
const INDEXER = 'https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql'
const NYM_SPECIFIER = '0x3acd9742c68f6d993066ae25533e09b9e1f60ed0'
const BOOTSTRAP_SELECTORS = new Set(['0x3898587d', '0x1c67ff29'])
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

function validBootstrap(body: unknown): boolean {
  if (typeof body !== 'string') return false
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (parsed.jsonrpc !== '2.0' || parsed.method !== 'eth_call' ||
      !Array.isArray(parsed.params) || parsed.params[1] !== 'latest') return false
    const call = parsed.params[0]
    if (typeof call !== 'object' || call === null) return false
    const to = (call as Record<string, unknown>).to
    const data = (call as Record<string, unknown>).data
    return typeof to === 'string' && to.toLowerCase() === NYM_SPECIFIER &&
      typeof data === 'string' && BOOTSTRAP_SELECTORS.has(data)
  } catch { return false }
}

export function classifyOutgoingRequest(raw: string, method: string, body: unknown, appOrigin: string,
  resolvers: ReadonlySet<string> = bundleUrls): TrafficKind {
  let url: URL
  try { url = new URL(raw, appOrigin) } catch { return 'blocked' }
  if (url.origin === appOrigin && ['http:', 'https:'].includes(url.protocol) &&
    method.toUpperCase() === 'GET' && !url.search) return 'app-static'
  if (url.href === APP_RPC) return 'blocked'
  if (url.href === BOOTSTRAP_RPC) return method.toUpperCase() === 'POST' && validBootstrap(body) ? 'bootstrap' : 'blocked'
  if (resolvers.has(url.href) && method.toUpperCase() === 'GET') return 'worker-bundle'
  if (url.href === POI && method.toUpperCase() === 'POST') return 'poi'
  if (url.hostname === ARTIFACT_HOST && url.protocol === 'https:' && url.pathname.startsWith('/ipfs/') &&
    method.toUpperCase() === 'GET' && !url.search) return 'artifacts'
  if (url.href === INDEXER && method.toUpperCase() === 'POST') return 'indexer'
  return 'blocked'
}

export function installNetworkGuard() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const kind = classifyOutgoingRequest(raw, method, init?.body, window.location.origin)
    const host = safeHost(raw, window.location.href)
    if (kind === 'blocked') {
      record(kind, host, 'blocked')
      throw new Error(`Network guard blocked ${host}`)
    }
    try {
      const response = await originalFetch(input, init)
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
    const kind = classifyOutgoingRequest(details.raw, details.method, body, window.location.origin)
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
