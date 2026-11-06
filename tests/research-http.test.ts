import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createResearchServer, type ResearchServerOptions } from '../server/http.ts'
import { ZeroGError } from '../server/zero-g.ts'

const origin = 'https://app.example.org'
const key = 'sk-synthetic-http-fixture-not-a-real-key'
const valid = () => ({ market: { marketId: '123', question: 'Will the public fixture resolve Yes?', outcomes: ['Yes', 'No'], selectedOutcome: 'Yes' }, sources: [{ id: 'S1', url: 'https://gamma-api.polymarket.com/markets/123', retrievedAt: Date.now(), text: 'Synthetic public market resolution rules, not independent news.' }] })
const headers = { origin, 'content-type': 'application/json' }
async function withServer(options: ResearchServerOptions, run: (base: string) => Promise<void>) {
  const server = createResearchServer({ config: { apiKey: key }, allowedOrigins: [origin], ...options })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try { await run(base) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}
const post = (base: string, value: unknown = valid(), extraHeaders: Record<string, string> = headers) => fetch(`${base}/api/research`, { method: 'POST', headers: extraHeaders, body: JSON.stringify(value) })

test('startup/status never run inference or disclose credentials and report bounded credit allowance', async () => {
  let calls = 0
  await withServer({ research: async () => { calls++; return {} } }, async base => {
    const response = await fetch(`${base}/api/status`)
    const text = await response.text()
    assert.equal(calls, 0); assert.equal(text.includes(key), false)
    assert.deepEqual(JSON.parse(text), { status: 'ok', provider: '0g', configured: true, providerTrustMode: 'private', proxySeesPlaintext: true, jobLimit: 20, jobsRemaining: 20, accessPolicy: 'origin-only-not-authentication' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })
  assert.throws(() => createResearchServer({ maxJobs: 101 }), /job limit/)
  assert.throws(() => createResearchServer({ maxJobs: 0 }), /job limit/)
  assert.throws(() => createResearchServer({ allowedOrigins: ['*'] }))
})

test('only exact allowlisted Origin and JSON content type can reach research, without CORS', async () => {
  let calls = 0
  await withServer({ research: async () => { calls++; return { done: true } } }, async base => {
    const deniedHeaders: Record<string, string>[] = [{ 'content-type': 'application/json' }, { origin: 'https://app.example.org.attacker.invalid', 'content-type': 'application/json' }, { origin: 'null', 'content-type': 'application/json' }]
    for (const bad of deniedHeaders) {
      const response = await post(base, valid(), bad); assert.equal(response.status, 403)
      assert.equal(response.headers.get('access-control-allow-origin'), null)
    }
    assert.equal((await post(base, valid(), { origin, 'content-type': 'text/plain' })).status, 415)
    assert.equal((await post(base, valid(), { ...headers, 'content-encoding': 'gzip' })).status, 415)
    assert.equal(calls, 0)
    const good = await post(base, valid(), { origin, 'content-type': 'application/json; charset=utf-8' })
    assert.equal(good.status, 200); assert.deepEqual(await good.json(), { done: true }); assert.equal(calls, 1)
  })
})

test('missing key cannot invoke injected research and status is only an availability flag', async () => {
  await withServer({ config: {}, research: async () => { assert.fail('No inference without configured key') } }, async base => {
    const response = await post(base)
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'NOT_CONFIGURED')
    const status = await (await fetch(`${base}/api/status`)).json()
    assert.equal(status.configured, false); assert.equal(status.jobsRemaining, 20)
  })
})

test('malformed JSON, invalid UTF-8 and invalid public schemas fail before the model and do not spend allowance', async () => {
  let calls = 0
  await withServer({ research: async () => { calls++; return {} } }, async base => {
    for (const body of ['{', Buffer.from([0xff]), JSON.stringify({ ...valid(), wallet: 'unrequested-account' })]) {
      const response = await fetch(`${base}/api/research`, { method: 'POST', headers, body })
      assert.equal(response.status, 400)
    }
    assert.equal(calls, 0)
    assert.equal((await (await fetch(`${base}/api/status`)).json()).jobsRemaining, 20)
  })
})

test('declared and chunked bodies are bounded to 128KB without reaching inference', async () => {
  await withServer({ research: async () => { assert.fail('Oversized body must not infer') } }, async base => {
    assert.equal((await fetch(`${base}/api/research`, { method: 'POST', headers, body: 'x'.repeat(128 * 1024 + 1) })).status, 413)
    const status = await new Promise<number>(resolve => {
      const req = httpRequest(`${base}/api/research`, { method: 'POST', headers }, response => { response.resume(); resolve(response.statusCode ?? 0) })
      req.on('error', error => { assert.fail(error.message) })
      req.write('x'.repeat(64 * 1024)); req.write('x'.repeat(64 * 1024)); req.end('x')
    })
    assert.equal(status, 413)
  })
})

test('untrusted errors and even forged ZeroGError messages never escape', async () => {
  for (const error of [new Error(key), new ZeroGError('PROVIDER_ERROR', key, 201)]) {
    await withServer({ research: async () => { throw error } }, async base => {
      const response = await post(base); const text = await response.text()
      assert.equal(text.includes(key), false); assert.ok(response.status >= 500)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal((await (await fetch(`${base}/api/status`)).json()).jobsRemaining, 19)
    })
  }
})

test('HTTP diagnostics use fixed error messages/statuses and revalidate provider metadata', async () => {
  for (const [code, upstream, status] of [['PROVIDER_AUTH', 401, 502], ['PROVIDER_CREDIT', 402, 402],
    ['PROVIDER_RATE_LIMIT', 429, 429], ['PROVIDER_CAPACITY', 503, 503], ['PROVIDER_REQUEST', 400, 502],
    ['PROVIDER_NETWORK', null, 502], ['INVALID_RESPONSE', 200, 502]] as const) {
    await withServer({ research: async () => { throw new ZeroGError(code, `${key} PRIVATE_PROMPT_SENTINEL`, 201,
      { providerStatus: upstream, requestId: 'request-public-fixture' }) } }, async base => {
      const response = await post(base), body = await response.json()
      assert.equal(response.status, status)
      assert.equal(body.error.code, code)
      assert.deepEqual(body.error.diagnostics, { providerStatus: upstream, requestId: 'request-public-fixture' })
      assert.equal(JSON.stringify(body).includes(key), false)
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PROMPT_SENTINEL/)
    })
  }
  await withServer({ research: async () => { throw new ZeroGError('PROVIDER_AUTH', key, 201,
    { providerStatus: 999, requestId: key, privateKey: key }) } }, async base => {
    const response = await post(base), body = await response.json()
    assert.equal(response.status, 502)
    assert.deepEqual(body.error.diagnostics, { providerStatus: null, requestId: null })
    assert.equal(JSON.stringify(body).includes(key), false)
  })
})

test('one concurrent job, per-minute bounds and global process allowance prevent repeated credit use', async () => {
  let calls = 0; let release: (() => void) | undefined
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  await withServer({ maxJobs: 1, research: async () => { calls++; entered(); await new Promise<void>(resolve => { release = resolve }); return {} } }, async base => {
    const first = post(base); await started
    const second = await post(base); assert.equal(second.status, 503); assert.equal((await second.json()).error.code, 'BUSY')
    release!(); assert.equal((await first).status, 200)
    const third = await post(base); assert.equal(third.status, 429); assert.equal((await third.json()).error.code, 'JOB_LIMIT_REACHED')
    assert.equal(calls, 1); assert.equal((await (await fetch(`${base}/api/status`)).json()).jobsRemaining, 0)
  })
  await withServer({ research: async () => ({}) }, async base => {
    for (let index = 0; index < 6; index++) assert.equal((await post(base)).status, 200)
    assert.equal((await post(base)).status, 429)
    assert.equal((await (await fetch(`${base}/api/status`)).json()).jobsRemaining, 14)
  })
})

test('client disconnect aborts in-flight inference and does not restore consumed allowance', async () => {
  let received!: () => void; let aborted!: () => void
  const started = new Promise<void>(resolve => { received = resolve })
  const cancelled = new Promise<void>(resolve => { aborted = resolve })
  await withServer({ research: async (_input, signal) => {
    received()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new ZeroGError('ABORTED', 'Cancelled', 408)) }, { once: true }))
    return {}
  } }, async base => {
    const controller = new AbortController()
    const pending = fetch(`${base}/api/research`, { method: 'POST', headers, body: JSON.stringify(valid()), signal: controller.signal }).catch(() => undefined)
    await started; controller.abort(); await pending
    await Promise.race([cancelled, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Abort was not forwarded')), 1000); timer.unref() })])
    assert.equal((await (await fetch(`${base}/api/status`)).json()).jobsRemaining, 19)
  })
})

test('API route and method boundaries never fall through to static files', async () => {
  await withServer({ research: async () => { assert.fail('Wrong route or method') } }, async base => {
    for (const method of ['GET', 'PUT', 'OPTIONS']) assert.equal((await fetch(`${base}/api/research`, { method })).status, 405)
    for (const path of ['/api/research?x=1', '/api/research/', '/api/unknown', '/api/status?x=1']) assert.equal((await fetch(base + path)).status, 404)
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405)
  })
})

test('static service confines real files to root, rejects symlink escapes, and supports HEAD', async () => {
  const temporary = await mkdtemp(join(tmpdir(), '0xpay-http-test-'))
  const root = join(temporary, 'public'); await mkdir(root)
  await writeFile(join(root, 'index.html'), '<main>Synthetic public app</main>')
  await writeFile(join(root, '.env'), key)
  await writeFile(join(temporary, 'outside.txt'), key)
  // A directory junction is supported on Windows without administrator privileges.
  await mkdir(join(temporary, 'private')); await writeFile(join(temporary, 'private', 'secret.txt'), key)
  await symlink(join(temporary, 'private'), join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await withServer({ staticRoot: root }, async base => {
      assert.equal((await fetch(base)).status, 200)
      const head = await fetch(base, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '')
      for (const path of ['/.env', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/escape/secret.txt', '/%ZZ']) {
        const response = await fetch(base + path); assert.equal(response.status, 404); assert.equal((await response.text()).includes(key), false)
      }
      assert.equal((await fetch(base, { method: 'POST' })).status, 404)
    })
  } finally {
    const target = resolve(temporary)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep + '0xpay-http-test-'))
    await rm(target, { recursive: true, force: true })
  }
})
