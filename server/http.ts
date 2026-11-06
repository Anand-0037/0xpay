import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { runZeroGResearch, safeZeroGDiagnostics, validatePublicResearchInput, ZeroGError, type ZeroGConfig, type ZeroGErrorCode } from './zero-g.ts'

export type ResearchServerOptions = {
  config?: ZeroGConfig
  allowedOrigins?: string[]
  staticRoot?: string
  research?: (input: unknown, signal: AbortSignal) => Promise<unknown>
  maxJobs?: number
}
const MAX_BODY = 128 * 1024
const media: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  response.end(JSON.stringify(value))
}
function failure(response: ServerResponse, status: number, code: string, message: string) {
  json(response, status, { error: { code, message } })
}
async function body(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers['content-length']
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) { request.resume(); throw new Error('BODY_TOO_LARGE') }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > MAX_BODY) { request.resume(); throw new Error('BODY_TOO_LARGE') }
    chunks.push(Buffer.from(chunk))
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
  catch { throw new SyntaxError('Invalid request encoding') }
  return JSON.parse(text)
}

const safeErrors: Record<ZeroGErrorCode, { status: number; message: string }> = {
  NOT_CONFIGURED: { status: 503, message: '0G inference is not configured on this server.' },
  NO_SOURCES: { status: 400, message: 'Retrieve public evidence before requesting research.' },
  INVALID_INPUT: { status: 400, message: 'Only bounded public market evidence is accepted.' },
  PROVIDER_ERROR: { status: 503, message: 'Private-tier 0G research is unavailable. No fallback was used.' },
  PROVIDER_AUTH: { status: 502, message: '0G rejected authentication or access permissions. No fallback was used.' },
  PROVIDER_CREDIT: { status: 402, message: '0G requires available inference credit. No fallback was used.' },
  PROVIDER_RATE_LIMIT: { status: 429, message: '0G rate-limited this private request. No automatic retry was made.' },
  PROVIDER_CAPACITY: { status: 503, message: 'The private 0G provider could not serve this request. No fallback was used.' },
  PROVIDER_REQUEST: { status: 502, message: '0G rejected the configured model request. No fallback was used.' },
  PROVIDER_NETWORK: { status: 502, message: 'The private 0G provider was unreachable or its response was interrupted.' },
  TIMEOUT: { status: 504, message: '0G research timed out.' },
  ABORTED: { status: 408, message: 'Research was cancelled.' },
  INVALID_RESPONSE: { status: 502, message: '0G returned an invalid research response.' },
}

/** Loopback development server, or one same-origin production service after approval. */
export function createResearchServer(options: ResearchServerOptions = {}) {
  const origins = new Set(options.allowedOrigins ?? ['http://127.0.0.1:4202', 'http://localhost:4202', 'http://localhost:5173'])
  for (const origin of origins) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid application origin configuration')
  }
  const maxJobs = options.maxJobs ?? 20
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) throw new Error('Research job limit must be between 1 and 100')
  const config = { ...options.config }
  const research = options.research ?? ((input, signal) => runZeroGResearch(input, config, fetch, signal))
  const configured = typeof config.apiKey === 'string' && Boolean(config.apiKey.trim())
  let jobs = 0
  let active = false
  let attempts: number[] = []
  const server = createServer(async (request, response) => {
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://localhost') }
    catch { failure(response, 400, 'INVALID_PATH', 'Invalid request path.'); return }
    if ((url.pathname === '/health' || url.pathname === '/api/status') && !url.search) {
      if (request.method !== 'GET') { failure(response, 405, 'METHOD_NOT_ALLOWED', 'Use a status request.'); return }
      json(response, 200, { status: 'ok', provider: '0g', configured, providerTrustMode: 'private', proxySeesPlaintext: true,
        jobLimit: maxJobs, jobsRemaining: maxJobs - jobs, accessPolicy: 'origin-only-not-authentication' })
      return
    }
    if (url.pathname === '/api/research' && !url.search) {
      if (request.method !== 'POST') { failure(response, 405, 'METHOD_NOT_ALLOWED', 'Use a research request.'); return }
      if (!request.headers.origin || !origins.has(request.headers.origin)) {
        failure(response, 403, 'ORIGIN_NOT_ALLOWED', 'Research is restricted to the configured application origin.'); return
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
        failure(response, 415, 'INVALID_CONTENT_TYPE', 'Research requires a JSON request.'); return
      }
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
        failure(response, 415, 'INVALID_CONTENT_ENCODING', 'Compressed research requests are not supported.'); return
      }
      if (!configured) { failure(response, 503, 'NOT_CONFIGURED', '0G inference is not configured on this server.'); return }
      if (active) { failure(response, 503, 'BUSY', 'A research request is already running.'); return }
      if (jobs >= maxJobs) { failure(response, 429, 'JOB_LIMIT_REACHED', 'This service has reached its research job allowance.'); return }
      attempts = attempts.filter(time => Date.now() - time < 60_000)
      if (attempts.length >= 6) { failure(response, 429, 'RATE_LIMITED', 'Wait before starting another research request.'); return }
      active = true
      attempts.push(Date.now())
      const controller = new AbortController()
      const abort = () => { if (!response.writableEnded) controller.abort() }
      response.on('close', abort)
      try {
        const input = validatePublicResearchInput(await body(request))
        if (controller.signal.aborted) return
        // Count before dispatch, including provider failures and cancelled jobs:
        // neither cancellation nor a model error restores spent credit allowance.
        jobs++
        const result = await research(input, controller.signal)
        if (!controller.signal.aborted) json(response, 200, result)
      } catch (error) {
        if (!controller.signal.aborted && !response.writableEnded) {
          if (error instanceof ZeroGError && Object.hasOwn(safeErrors, error.code)) {
            const safe = safeErrors[error.code]
            json(response, safe.status, { error: { code: error.code, message: safe.message,
              diagnostics: safeZeroGDiagnostics(error.diagnostics, config.apiKey) } })
          }
          else if (error instanceof Error && error.message === 'BODY_TOO_LARGE') failure(response, 413, 'BODY_TOO_LARGE', 'The research request is too large.')
          else if (error instanceof SyntaxError) failure(response, 400, 'INVALID_JSON', 'The research request must be valid JSON.')
          else failure(response, 502, 'RESEARCH_FAILED', 'Research could not complete. No fallback model was used.')
        }
      } finally { response.off('close', abort); active = false }
      return
    }
    if (options.staticRoot && (request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
      const root = resolve(options.staticRoot)
      try {
        const decoded = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        if (decoded.split(/[\\/]/).some(segment => segment.startsWith('.'))) { failure(response, 404, 'NOT_FOUND', 'Not found.'); return }
        const path = resolve(root, `.${decoded}`)
        const actualRoot = await realpath(root)
        const actualPath = await realpath(path)
        if (!path.startsWith(root + sep) || !actualPath.startsWith(actualRoot + sep)) { failure(response, 404, 'NOT_FOUND', 'Not found.'); return }
        const bytes = await readFile(actualPath)
        response.writeHead(200, { 'Content-Type': media[extname(path)] ?? 'application/octet-stream',
          'Cache-Control': extname(path) === '.html' ? 'no-store' : 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
        response.end(request.method === 'HEAD' ? undefined : bytes)
        return
      } catch { /* Missing assets and invalid paths do not reveal server paths. */ }
    }
    failure(response, 404, 'NOT_FOUND', 'Not found.')
  })
  server.requestTimeout = 250_000
  server.headersTimeout = 15_000
  return server
}
