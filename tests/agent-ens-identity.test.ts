import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Interface, ZeroAddress, dnsEncode, namehash } from 'ethers'
import { readEnsAgentIdentity, type EnsIdentityRequest, type EnsIdentityTransport } from '../src/agents/ens-identity.ts'

// Synthetic protocol fixtures, not deployed names, ENS ownership or mandate evidence.
const proxy = '0x1111111111111111111111111111111111111111'
const resolver = '0x2222222222222222222222222222222222222222'
const signer = '0x3333333333333333333333333333333333333333'
const mandateHash = `0x${'ab'.repeat(32)}`
const blockHash = `0x${'bc'.repeat(32)}`
const request: EnsIdentityRequest = { name: 'researcher.0xpay.eth', chainId: 11155111, universalResolver: proxy, expectedResolver: resolver, expectedMandateHash: mandateHash }
const universal = new Interface(['function isENSv2() view returns(bool)', 'function findResolver(bytes) view returns(address,bytes32,uint256)', 'function resolve(bytes,bytes) view returns(bytes,address)', 'error OffchainLookup(address,string[],bytes,bytes4,bytes)'])
const profile = new Interface(['function addr(bytes32) view returns(address)', 'function text(bytes32,string) view returns(string)'])
function fixture(options: { chain?: string; version?: boolean; discovery?: string; returnedResolver?: string; record?: string; ccip?: boolean; reorg?: boolean; duplicateId?: boolean } = {}) {
  let blocks = 0
  const calls: { method: string; params: unknown[] }[] = []
  const route: EnsIdentityTransport = { status: 'ready', async fetchRpc(body) {
    const batch = JSON.parse(body)
    return Response.json(batch.map((call: { id: number; method: string; params: unknown[] }, index: number) => {
      calls.push(call)
      let result: unknown
      if (call.method === 'eth_chainId') result = options.chain ?? '0xaa36a7'
      else if (call.method === 'eth_getBlockByNumber') result = { number: '0x123', hash: ++blocks > 1 && options.reorg ? `0x${'de'.repeat(32)}` : blockHash }
      else if (call.method === 'eth_getCode') { assert.deepEqual(call.params, [proxy, '0x123']); result = '0x6000' }
      else {
        assert.equal(call.method, 'eth_call')
        const [transaction, tag] = call.params as [{ to: string; data: string }, string]
        assert.equal(transaction.to, proxy); assert.equal(tag, '0x123')
        assert.deepEqual(Object.keys(transaction).sort(), ['data', 'to'])
        const decoded = universal.parseTransaction({ data: transaction.data })!
        if (decoded.name === 'isENSv2') result = universal.encodeFunctionResult('isENSv2', [options.version ?? true])
        else if (decoded.name === 'findResolver') {
          assert.equal(decoded.args[0], dnsEncode(request.name))
          result = universal.encodeFunctionResult('findResolver', [options.discovery ?? resolver, namehash(request.name), 0])
        } else {
          assert.equal(decoded.args[0], dnsEncode(request.name))
          if (options.ccip) return { jsonrpc: '2.0', id: call.id, error: { code: 3, data: universal.encodeErrorResult('OffchainLookup', [proxy, ['https://gateway.example.org/{data}'], '0x', '0x12345678', '0x']) } }
          const query = profile.parseTransaction({ data: decoded.args[1] })!
          if (query.name === 'text') assert.equal(query.args[1], '0xpay.mandate')
          const value = query.name === 'addr' ? signer : options.record ?? mandateHash
          result = universal.encodeFunctionResult('resolve', [profile.encodeFunctionResult(query.name, [value]), options.returnedResolver ?? resolver])
        }
      }
      return { jsonrpc: '2.0', id: options.duplicateId && index > 0 ? batch[0].id : call.id, result }
    }))
  } }
  return { route, calls }
}

test('ENSv2 raw reads stay on injected private transport and return only snapshot evidence', async () => {
  const { route, calls } = fixture()
  const original = globalThis.fetch; let direct = 0
  globalThis.fetch = async () => { direct++; assert.fail('ENS must never use direct RPC or gateway HTTP') }
  try {
    const result = await readEnsAgentIdentity(route, request)
    assert.deepEqual(result, { name: request.name, chainId: 11155111, blockNumber: 291, blockHash, universalResolver: proxy, resolver, resolvedAddress: signer, mandateHash, matchesExpectedMandate: true, authorityVerified: false })
    assert.equal(direct, 0)
    assert.deepEqual(new Set(calls.map(call => call.method)), new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']))
  } finally { globalThis.fetch = original }
})

test('wrong chains and ENSv1 markers fail before profile records are read', async () => {
  const wrong = fixture({ chain: '0x89' })
  await assert.rejects(readEnsAgentIdentity(wrong.route, request), /ENS chain does not match/)
  assert.equal(wrong.calls.some(call => call.method === 'eth_call'), false)
  const legacy = fixture({ version: false })
  await assert.rejects(readEnsAgentIdentity(legacy.route, request), /not reporting ENSv2/)
  assert.equal(legacy.calls.length, 5)
})

test('expected resolver and per-record resolver mismatches are rejected', async () => {
  await assert.rejects(readEnsAgentIdentity(fixture({ discovery: signer }).route, request), /resolver changed/)
  await assert.rejects(readEnsAgentIdentity(fixture({ returnedResolver: signer }).route, request), /different resolver/)
  await assert.rejects(readEnsAgentIdentity(fixture({ discovery: ZeroAddress }).route, request), /non-zero/)
})

test('missing, malformed and different mandate records cannot satisfy the expected mandate', async () => {
  for (const record of ['', 'not a hash', `0x${'00'.repeat(32)}`, `0x${'dd'.repeat(32)}`]) {
    await assert.rejects(readEnsAgentIdentity(fixture({ record }).route, request), /mandate/)
  }
  const empty = await readEnsAgentIdentity(fixture({ record: '' }).route, { ...request, expectedMandateHash: undefined })
  assert.equal(empty.mandateHash, null); assert.equal(empty.matchesExpectedMandate, false); assert.equal(empty.authorityVerified, false)
})

test('CCIP reads stop explicitly without fetching a gateway or claiming identity', async () => {
  const original = globalThis.fetch; let direct = 0
  globalThis.fetch = async () => { direct++; assert.fail('No CCIP gateway HTTP permitted') }
  try {
    await assert.rejects(readEnsAgentIdentity(fixture({ ccip: true }).route, request), /CCIP-Read.*disabled/)
    assert.equal(direct, 0)
  } finally { globalThis.fetch = original }
})

test('snapshot changes, duplicate response ids and interrupted route invalidate the evidence', async () => {
  await assert.rejects(readEnsAgentIdentity(fixture({ reorg: true }).route, request), /snapshot changed/)
  await assert.rejects(readEnsAgentIdentity(fixture({ duplicateId: true }).route, request), /invalid or incomplete/)
  const { route } = fixture()
  let assertions = 0
  await assert.rejects(readEnsAgentIdentity(route, request, () => { if (++assertions >= 4) throw new Error('Route generation changed') }), /Route generation changed/)
  await assert.rejects(readEnsAgentIdentity({ ...route, status: 'failed' }, request), /Reconnect/)
})

test('input chain and expected hash are validated before any read', async () => {
  const { route, calls } = fixture()
  await assert.rejects(readEnsAgentIdentity(route, { ...request, chainId: 137 as 1 }), /not Polygon/)
  await assert.rejects(readEnsAgentIdentity(route, { ...request, expectedMandateHash: '0xwrong' }), /bytes32/)
  assert.equal(calls.length, 0)
})
