import { containsSensitiveResearchText } from '../net/research-egress.ts'

/** Public research transport only. Wallet/session/account objects must never be passed to this module. */
export type PublicResearchMarket = Readonly<{
  marketId: string; question: string; outcomes: readonly string[]; selectedOutcome: string
}>
export type PublicResearchSource = Readonly<{ id: string; url: string; retrievedAt: number; text: string }>
export type PublicResearchReceipt = Readonly<{
  role: 'researcher' | 'skeptic'; requestId: string | null; responseKey: string | null; completionId: string | null
  routerTeeVerified: boolean | null; verification: 'router-reported' | 'not-reported'; independentVerification: false
}>
export type PublicResearchResult = Readonly<{
  mode: '0g-private-research'; model: string
  researcher: { summary: string; thesis: string | null; estimatedProbabilityMicros: number | null; citations: string[] }
  skeptic: { counterpoints: string[]; resolutionAmbiguities: string[]; verdict: 'abstain' | 'review'; citations: string[] }
  receipts: PublicResearchReceipt[]
  privacy: { providerTrustMode: 'private'; proxySeesPlaintext: true }
}>
type Options = { signal?: AbortSignal; timeoutMs?: number; fetcher?: typeof fetch }
const ENDPOINT = '/api/research'
const MAX_RESPONSE_BYTES = 160_000
const MAX_TIMEOUT_MS = 240_000
const DEFAULT_TIMEOUT_MS = 180_000

export class ResearchRequestError extends Error {
  readonly code: 'invalid-input' | 'unavailable' | 'rejected' | 'invalid-response' | 'timeout' | 'aborted' | 'network'
  readonly status: number | null
  readonly backendCode: string | null
  readonly providerStatus: number | null
  readonly requestId: string | null
  constructor(message: string, code: ResearchRequestError['code'], status: number | null = null,
    details?: { backendCode: string; providerStatus: number | null; requestId: string | null }) {
    super(message); this.name = 'ResearchRequestError'; this.code = code; this.status = status
    this.backendCode = details?.backendCode ?? null; this.providerStatus = details?.providerStatus ?? null; this.requestId = details?.requestId ?? null
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a research object.')
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number): string {
  // oxlint-disable-next-line no-control-regex -- Reject non-text controls while allowing paragraph whitespace.
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || containsSensitiveResearchText(value)) throw new Error('Invalid research text.')
  return value.trim()
}
function publicUrl(value: unknown) {
  const url = new URL(text(value, 2048))
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
    host === 'localhost' || /(?:^|\.)(?:localhost|local|internal|lan)$/.test(host) ||
    !host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) throw new Error('Sources need public HTTPS URLs.')
  // URL encoding must not conceal account/secret text from the pre-egress check.
  if (containsSensitiveResearchText(decodeURIComponent(url.href))) throw new Error('Sources must not contain wallet or secret data.')
  return url.href
}
function sourcesForRequest(sources: readonly PublicResearchSource[]) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 6) throw new Error('Provide between one and six public sources.')
  const seen = new Set<string>()
  let total = 0
  return sources.map(source => {
    const id = text(source.id, 12)
    if (!/^S[1-9][0-9]{0,2}$/.test(id) || seen.has(id)) throw new Error('Each public source needs a unique S1-style ID.')
    seen.add(id)
    const content = text(source.text, 6000)
    total += content.length
    if (total > 18_000 || !Number.isSafeInteger(source.retrievedAt) || source.retrievedAt <= 0 ||
      source.retrievedAt > Date.now() + 30_000) throw new Error('Public source size or retrieval time is invalid.')
    // Construct each entry explicitly: extra wallet/account fields are never serialized.
    return { id, url: publicUrl(source.url), retrievedAt: source.retrievedAt, text: content }
  })
}

function buildPayload(market: PublicResearchMarket, sources: readonly PublicResearchSource[]) {
  const marketId = text(market.marketId, 128), question = text(market.question, 1500)
  if (!Array.isArray(market.outcomes) || market.outcomes.length < 2 || market.outcomes.length > 8) throw new Error('Choose valid public market outcomes.')
  const outcomes = market.outcomes.map(outcome => text(outcome, 128))
  if (new Set(outcomes).size !== outcomes.length) throw new Error('Market outcomes must be distinct.')
  const selectedOutcome = text(market.selectedOutcome, 128)
  if (!outcomes.includes(selectedOutcome)) throw new Error('Choose an outcome listed by this market.')
  // Never spread a workspace, draft, account context or caller-provided object.
  return { market: { marketId, question, outcomes, selectedOutcome }, sources: sourcesForRequest(sources) }
}

function citations(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.size) throw new Error('Invalid research citations.')
  const ids = value.map(id => text(id, 12))
  if (new Set(ids).size !== ids.length || ids.some(id => !allowed.has(id))) throw new Error('Research referenced a source that was not supplied.')
  return ids
}
function nullableText(value: unknown, limit: number) { return value === null ? null : text(value, limit) }
function strings(value: unknown) {
  if (!Array.isArray(value) || value.length > 6) throw new Error('Invalid research findings.')
  return value.map(entry => text(entry, 1000))
}
function identifier(value: unknown) {
  const id = nullableText(value, 256)
  if (id !== null && /[^\x21-\x7e]/.test(id)) throw new Error('Invalid public request identifier.')
  return id
}

function resultFrom(value: unknown, sourceIds: Set<string>): PublicResearchResult {
  const body = object(value), researcher = object(body.researcher), skeptic = object(body.skeptic), privacy = object(body.privacy)
  if (body.mode !== '0g-private-research' || body.model !== '0gm-1.0-35b-a3b' || privacy.providerTrustMode !== 'private' || privacy.proxySeesPlaintext !== true ||
    !Array.isArray(body.receipts) || body.receipts.length !== 2 || !['abstain', 'review'].includes(skeptic.verdict as string)) {
    throw new Error('The server did not return the expected private-research result.')
  }
  const probability = researcher.estimatedProbabilityMicros
  if (probability !== null && (typeof probability !== 'number' || !Number.isSafeInteger(probability) || probability < 0 || probability > 1_000_000)) throw new Error('Invalid research probability.')
  const roles = new Set<string>()
  const receipts = body.receipts.map(value => {
    const receipt = object(value)
    if ((receipt.role !== 'researcher' && receipt.role !== 'skeptic') || roles.has(receipt.role) ||
      receipt.independentVerification !== false ||
      (receipt.routerTeeVerified !== null && typeof receipt.routerTeeVerified !== 'boolean') ||
      receipt.verification !== (receipt.routerTeeVerified === null ? 'not-reported' : 'router-reported')) throw new Error('Invalid model verification metadata.')
    roles.add(receipt.role)
    const requestId = identifier(receipt.requestId), responseKey = identifier(receipt.responseKey), completionId = identifier(receipt.completionId)
    if (receipt.routerTeeVerified === false || (!requestId && !responseKey && !completionId)) throw new Error('Model evidence is missing or verification failed.')
    return { role: receipt.role, requestId, responseKey, completionId, routerTeeVerified: receipt.routerTeeVerified,
      verification: receipt.verification, independentVerification: false } as PublicResearchReceipt
  })
  return {
    mode: '0g-private-research', model: text(body.model, 200),
    researcher: { summary: text(researcher.summary, 2500), thesis: nullableText(researcher.thesis, 1500),
      estimatedProbabilityMicros: probability as number | null, citations: citations(researcher.citations, sourceIds) },
    skeptic: { counterpoints: strings(skeptic.counterpoints), resolutionAmbiguities: strings(skeptic.resolutionAmbiguities),
      verdict: skeptic.verdict as 'abstain' | 'review', citations: citations(skeptic.citations, sourceIds) },
    receipts, privacy: { providerTrustMode: 'private', proxySeesPlaintext: true },
  }
}

async function responseBody(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES) {
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maxBytes))) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Research response is too large.')
  }
  if (!response.body) throw new Error('Research response is empty.')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, output = ''
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('Research response is too large.')
      output += decoder.decode(chunk.value, { stream: true })
    }
    return output + decoder.decode()
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock() }
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: '0G research is not configured on this server.',
  PROVIDER_AUTH: '0G rejected the server credential or access permissions.',
  PROVIDER_CREDIT: '0G reported that inference credit is required.',
  PROVIDER_RATE_LIMIT: '0G rate-limited this private research request.',
  PROVIDER_CAPACITY: 'The private 0G provider could not serve this request.',
  PROVIDER_REQUEST: '0G rejected the configured model request.',
  PROVIDER_NETWORK: 'The private 0G provider was unreachable or its response was interrupted.',
  PROVIDER_ERROR: 'Private-tier 0G research is unavailable.',
  INVALID_RESPONSE: '0G returned a response that failed schema or verification checks.',
  TIMEOUT: '0G research timed out.', ABORTED: 'Research was cancelled.',
  BUSY: 'Another research request is already running.',
  RATE_LIMITED: 'The local research service rate limit was reached.',
  JOB_LIMIT_REACHED: 'The local research job allowance was reached.',
}
async function failureFrom(response: Response, signal: AbortSignal): Promise<ResearchRequestError> {
  // Never render a provider/server message. Only finite codes and independently
  // checked status/opaque request IDs may be used as a diagnostic.
  try {
    if (!response.redirected && response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      const body = object(JSON.parse(await abortable(responseBody(response, signal, 8192), signal)))
      const failure = object(body.error)
      if (typeof failure.code === 'string' && Object.hasOwn(FAILURE_MESSAGES, failure.code)) {
        const diagnostics = failure.diagnostics === undefined ? {} : object(failure.diagnostics)
        const providerStatus = typeof diagnostics.providerStatus === 'number' && Number.isInteger(diagnostics.providerStatus) &&
          diagnostics.providerStatus >= 100 && diagnostics.providerStatus <= 599 ? diagnostics.providerStatus : null
        const requestId = typeof diagnostics.requestId === 'string' && /^[a-z0-9._:-]{1,128}$/i.test(diagnostics.requestId) &&
          !containsSensitiveResearchText(diagnostics.requestId) ? diagnostics.requestId : null
        const detail = `${providerStatus === null ? '' : ` Provider HTTP ${providerStatus}.`}${requestId === null ? '' : ` Request ${requestId}.`}`
        return new ResearchRequestError(`${FAILURE_MESSAGES[failure.code]}${detail} No model result was returned.`,
          failure.code === 'INVALID_RESPONSE' ? 'invalid-response' : 'unavailable', response.status,
          { backendCode: failure.code, providerStatus, requestId })
      }
    } else void response.body?.cancel().catch(() => {})
  } catch (cause) { if (signal.aborted) throw cause }
  return new ResearchRequestError(response.status === 503 ? '0G research is unavailable. No model result was returned.' :
    'The research request was rejected. No model result was returned.', response.status === 503 ? 'unavailable' : 'rejected', response.status)
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    void pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value) }, cause => {
      signal.removeEventListener('abort', cancel); reject(cause)
    })
  })
}

/** Sends public market facts only to our same-origin server. Never falls back to a browser/local model. */
export async function requestPublicResearch(market: PublicResearchMarket, sources: readonly PublicResearchSource[], options: Options = {}): Promise<PublicResearchResult> {
  let payload: ReturnType<typeof buildPayload>
  try { payload = buildPayload(market, sources) }
  catch { throw new ResearchRequestError('Choose a market and valid public sources before requesting 0G research.', 'invalid-input') }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new ResearchRequestError('Invalid research timeout.', 'invalid-input')
  const controller = new AbortController()
  const cancel = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) cancel()
  else options.signal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException('Research timed out', 'TimeoutError')) }, timeoutMs)
  try {
    controller.signal.throwIfAborted()
    const response = await abortable((options.fetcher ?? fetch)(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', mode: 'same-origin',
      signal: controller.signal, body: JSON.stringify(payload),
    }), controller.signal)
    controller.signal.throwIfAborted()
    if (!response.ok) {
      throw await failureFrom(response, controller.signal)
    }
    if (response.redirected || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      void response.body?.cancel().catch(() => {})
      throw new ResearchRequestError('The research server returned an unexpected response.', 'invalid-response')
    }
    try { return resultFrom(JSON.parse(await abortable(responseBody(response, controller.signal), controller.signal)), new Set(payload.sources.map(source => source.id))) }
    catch (cause) {
      if (controller.signal.aborted) throw cause
      throw new ResearchRequestError('The research response could not be validated. No result was accepted.', 'invalid-response')
    }
  } catch (cause) {
    if (timedOut) throw new ResearchRequestError('0G research timed out. No model result was accepted.', 'timeout')
    if (controller.signal.aborted) throw new ResearchRequestError('Research was cancelled. No model result was accepted.', 'aborted')
    if (cause instanceof ResearchRequestError) throw cause
    throw new ResearchRequestError('The research server could not be reached. No model result was returned.', 'network')
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
}
