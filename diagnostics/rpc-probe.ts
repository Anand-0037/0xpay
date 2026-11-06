import { keccak256, toHex } from 'viem'
import { PrivateRpc } from '../src/rpc.ts'
import { APP_RPC_URL, MEMPOOL_RPC_URL, privacyNetworkFromSearch, PRIVACY_NETWORKS } from '../src/rpc/networks.ts'
import { installNetworkGuard, trafficSnapshot } from '../src/net/network-guard.ts'
import deployment from '../src/pool/deployments.devnet.json'

// Fixed public test data only. Never import the wallet/session or pool API.
const privacyNetwork = privacyNetworkFromSearch(window.location.search)
const ZERO = '0x0000000000000000000000000000000000000000'
const BALANCE_OF_ZERO = `0x70a08231${'0'.repeat(64)}`
const TOKEN_ADDRESSES = {
  USDC: '0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5',
  USDT: '0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9',
  WETH: '0x1b7d32025F7cA633943BbCC9Ec61a98ef66187b6',
  LINK: '0x7BF399a347FC0757e668058f11D3B696932353e4',
} as const
type ProbeCase = { label: string; method: 'eth_chainId' | 'eth_blockNumber' | 'eth_getBalance' | 'eth_call' | 'eth_getLogs'; params: unknown[]; endpoint: 'chain' | 'gateway' }
const cases: ProbeCase[] = [
  { label: 'Chain ID', method: 'eth_chainId', params: [], endpoint: 'chain' },
  { label: 'Block number', method: 'eth_blockNumber', params: [], endpoint: 'chain' },
  { label: 'Public balance · zero address', method: 'eth_getBalance', params: [ZERO, 'latest'], endpoint: 'gateway' },
  { label: 'Global pool deposits', method: 'eth_getLogs', params: [{ address: deployment.pool, fromBlock: '0x0', toBlock: 'latest', topics: [keccak256(toHex('Deposit(bytes32,uint32,uint256)'))] }], endpoint: 'gateway' },
]
const tokenCases: ProbeCase[] = Object.entries(TOKEN_ADDRESSES).map(([symbol, address]) => ({ label: `${symbol} balanceOf · zero address`, method: 'eth_call', params: [{ to: address, data: BALANCE_OF_ZERO }, 'latest'], endpoint: 'gateway' }))

const stage = document.querySelector<HTMLParagraphElement>('#stage')!
const results = document.querySelector<HTMLTableSectionElement>('#results')!
const counters = document.querySelector<HTMLPreElement>('#counters')!
const sequentialButton = document.querySelector<HTMLButtonElement>('#sequential')!
const dashboardButton = document.querySelector<HTMLButtonElement>('#dashboard')!
const disconnectButton = document.querySelector<HTMLButtonElement>('#disconnect')!
let route: PrivateRpc | undefined
let nextId = 10_000
let busy = false

function sanitized(value: unknown): string {
  return String(value).replace(/https?:\/\/[^\s"')]+/gi, '[endpoint]').replace(/0x[0-9a-f]{40,}/gi, '[hex]').replace(/[\r\n\t]/g, ' ').slice(0, 280)
}
function row(probe: ProbeCase, outcome: string, elapsed: number, detail: string): void {
  const tr = document.createElement('tr')
  for (const value of [`${probe.label}\n${probe.method}`, probe.endpoint, outcome, `${Math.round(elapsed)} ms`, route?.status ?? 'not created', detail]) {
    const td = document.createElement('td'); td.textContent = value; tr.append(td)
  }
  results.append(tr)
  renderCounters()
}
function renderCounters(): void {
  const traffic = trafficSnapshot()
  counters.textContent = JSON.stringify({ status: route?.status, worker: `${PRIVACY_NETWORKS[privacyNetwork].label} via current PrivateRpc`, stats: route?.stats, pageTraffic: traffic.counts, recentPageDestinations: traffic.recent }, null, 2)
}
function summarizeResult(method: ProbeCase['method'], value: unknown): string {
  if (method === 'eth_getLogs') {
    if (!Array.isArray(value)) return 'Unusable result: expected event-log array'
    return `${value.length} public event logs (contents not retained)`
  }
  if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) return 'Unusable result: expected hex'
  if (value === '0x') return 'Unusable result: empty hex (not a balance quantity)'
  if (method === 'eth_call' && value.length !== 66) return `Unusable ERC-20 balance result (${(value.length - 2) / 2} bytes)`
  return method === 'eth_chainId' ? `Chain ${BigInt(value)}` : method === 'eth_blockNumber' ? `Block ${BigInt(value)}` : `${BigInt(value)} base units for zero address`
}
async function read(probe: ProbeCase): Promise<void> {
  const started = performance.now(), id = ++nextId
  try {
    if (!route) throw new Error('Worker has not been created')
    const response = await route.fetchRpc(JSON.stringify({ jsonrpc: '2.0', id, method: probe.method, params: probe.params }), probe.endpoint === 'chain' ? APP_RPC_URL : MEMPOOL_RPC_URL)
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || !('jsonrpc' in payload) || payload.jsonrpc !== '2.0' || !('id' in payload) || payload.id !== id || ('result' in payload) === ('error' in payload)) throw new Error('Invalid JSON-RPC response envelope')
    if ('error' in payload) {
      const error = payload.error
      const message = error && typeof error === 'object' && 'message' in error ? sanitized(error.message) : 'No message'
      const code = error && typeof error === 'object' && 'code' in error ? sanitized(error.code) : 'unknown'
      row(probe, `HTTP ${response.status} · RPC error ${code}`, performance.now() - started, message)
    } else if ('result' in payload) row(probe, `HTTP ${response.status} · result`, performance.now() - started, summarizeResult(probe.method, payload.result))
  } catch (error) {
    row(probe, 'Read failed / blocked', performance.now() - started, sanitized(error))
  }
}
async function run(mode: 'sequential' | 'dashboard'): Promise<void> {
  if (busy) return
  busy = true; sequentialButton.disabled = true; dashboardButton.disabled = true; results.replaceChildren()
  const started = performance.now()
  const timer = window.setInterval(() => { stage.textContent = `Read-only ${mode} probe · ${Math.floor((performance.now() - started) / 1000)} seconds elapsed · route ${route?.status ?? 'starting'}`; renderCounters() }, 500)
  try {
    installNetworkGuard({ privacyNetwork })
    if (!route) { route = new PrivateRpc(undefined, privacyNetwork, 'devnet'); await route.connect() }
    else if (route.status !== 'ready') await route.reconnect()
    if (mode === 'dashboard') {
      // Match dashboard concurrency: independent balance/log reads plus an ordered token list.
      await Promise.all([read(cases[0]), read(cases[1]), read(cases[2]), read(cases[3]), (async () => { for (const probe of tokenCases) await read(probe) })()])
    } else for (const probe of [...cases, ...tokenCases]) await read(probe)
    stage.textContent = `Probe finished in ${Math.round(performance.now() - started)} ms · route ${route.status}. Nothing was signed or submitted.`
  } catch (error) {
    stage.textContent = `Worker connection failed: ${sanitized(error)}. Nothing was signed or submitted.`
  } finally {
    clearInterval(timer); renderCounters(); busy = false; sequentialButton.disabled = false; dashboardButton.disabled = false
  }
}
sequentialButton.addEventListener('click', () => { void run('sequential') })
dashboardButton.addEventListener('click', () => { void run('dashboard') })
disconnectButton.addEventListener('click', () => { route?.disconnect(); stage.textContent = 'Disconnected by you. Future reads are blocked until an explicit new run reconnects.'; renderCounters() })
window.addEventListener('pagehide', () => route?.close())
