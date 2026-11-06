import { Interface, ZeroAddress, ZeroHash, dnsEncode, ensNormalize, getAddress, getBytes, namehash } from 'ethers'

export type EnsIdentityTransport = { readonly status: string; fetchRpc(body: string): Promise<Response> }
export type EnsIdentityRequest = {
  name: string
  chainId: 1 | 11155111
  /** Canonical proxy from reviewed deployment configuration, never an implementation address. */
  universalResolver: string
  expectedResolver?: string
  expectedMandateHash?: string
}
export type EnsIdentitySnapshot = {
  name: string; chainId: 1 | 11155111; blockNumber: number; blockHash: string
  universalResolver: string; resolver: string; resolvedAddress: string
  mandateHash: string | null; matchesExpectedMandate: boolean
  /** A public record is not a signature, wallet permission or proof of ownership. */
  authorityVerified: false
}

// Exact public functions in the official ENSv2 deployment ABI. Use raw calls,
// not ethers 6.14's ENSv1 discovery helpers; do not patch the RAILGUN ethers copy.
// https://docs.ens.domains/ensv2/universal-resolver-v2/
// https://docs.ens.domains/ensv2/permissioned-resolver/
const universal = new Interface([
  'function isENSv2() view returns(bool)',
  'function findResolver(bytes name) view returns(address resolver, bytes32 node, uint256 offset)',
  'function resolve(bytes name, bytes data) view returns(bytes result,address resolver)',
  'error OffchainLookup(address sender,string[] urls,bytes callData,bytes4 callbackFunction,bytes extraData)',
])
const profile = new Interface(['function addr(bytes32 node) view returns(address)', 'function text(bytes32 node,string key) view returns(string)'])
const TEXT_KEY = '0xpay.mandate'
let nextId = 5_000_000
type Call = { method: string; params: unknown[] }
const malformed = () => new Error('ENS returned invalid or incomplete identity data.')
function ready(route: EnsIdentityTransport) {
  if (route.status !== 'ready') throw new Error('Reconnect the private ENS route before reading agent identity.')
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || value.length > 131_074 || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw malformed()
  return value
}
function address(value: string): string {
  const result = getAddress(value)
  if (result === ZeroAddress) throw new Error('ENS identity requires a non-zero contract or address record.')
  return result
}
function hash(value: string) {
  if (!/^0x[0-9a-f]{64}$/i.test(value) || value.toLowerCase() === ZeroHash) throw new Error('ENS mandate record must be a non-zero bytes32 hash.')
  return value.toLowerCase()
}
function decode(abi: Interface, method: string, value: unknown) {
  const data = hex(value)
  try {
    const values = abi.decodeFunctionResult(method, data)
    if (abi.encodeFunctionResult(method, values).toLowerCase() !== data.toLowerCase()) throw malformed()
    return values
  } catch { throw malformed() }
}
function blockHeader(value: unknown) {
  if (!value || typeof value !== 'object' || !('number' in value) || !('hash' in value) ||
    typeof value.number !== 'string' || !/^0x[1-9a-f][0-9a-f]*$/i.test(value.number) ||
    typeof value.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.hash)) throw malformed()
  const number = Number(BigInt(value.number))
  if (!Number.isSafeInteger(number)) throw malformed()
  return { number, hash: value.hash.toLowerCase(), tag: value.number.toLowerCase() }
}
async function read(route: EnsIdentityTransport, calls: Call[], assertCurrent: () => void) {
  assertCurrent(); ready(route)
  const requests = calls.map(call => ({ jsonrpc: '2.0', id: ++nextId, ...call }))
  const response = await route.fetchRpc(JSON.stringify(requests))
  assertCurrent(); ready(route)
  if (!response.ok) throw new Error('ENS private-route read failed; no direct fallback was used.')
  const text = await response.text()
  assertCurrent(); ready(route)
  if (text.length > 1_000_000) throw malformed()
  const payload: unknown = JSON.parse(text)
  if (!Array.isArray(payload) || payload.length !== requests.length) throw malformed()
  const expected = new Set(requests.map(call => call.id)); const values = new Map<number, unknown>()
  for (const item of payload) {
    if (!item || typeof item !== 'object' || item.jsonrpc !== '2.0' || !Number.isSafeInteger(item.id) ||
      !expected.has(item.id) || values.has(item.id)) throw malformed()
    if ('error' in item) {
      const data = item.error?.data
      if (typeof data === 'string' && data.startsWith(universal.getError('OffchainLookup')!.selector)) {
        throw new Error('ENS requires CCIP-Read. Offchain gateway requests are disabled until their privacy route is explicitly supported.')
      }
      throw new Error('ENS contract read failed. No gateway or direct HTTP fallback was used.')
    }
    if (!('result' in item)) throw malformed()
    values.set(item.id, item.result)
  }
  return requests.map(call => values.get(call.id))
}

/** Read-only evidence, not name ownership, signature or mandate enforcement. */
export async function readEnsAgentIdentity(route: EnsIdentityTransport, input: EnsIdentityRequest,
  assertCurrent: () => void = () => {}): Promise<EnsIdentitySnapshot> {
  if (input.chainId !== 1 && input.chainId !== 11155111) throw new Error('ENS identity must be resolved on Ethereum mainnet or Sepolia, not Polygon.')
  const chainId = input.chainId
  if (typeof input.name !== 'string' || input.name.length > 255) throw new Error('Enter a supported ENS name.')
  const name = ensNormalize(input.name.trim()), dnsName = dnsEncode(name)
  if (!name.includes('.') || getBytes(dnsName).length > 255) throw new Error('Enter a supported ENS name.')
  const proxy = address(input.universalResolver)
  const expectedResolver = input.expectedResolver ? address(input.expectedResolver) : undefined
  const expectedHash = input.expectedMandateHash ? hash(input.expectedMandateHash) : undefined
  const [chain, header] = await read(route, [
    { method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: ['latest', false] },
  ], assertCurrent)
  if (chain !== `0x${chainId.toString(16)}`) throw new Error('ENS chain does not match the selected identity network.')
  const snapshot = blockHeader(header)
  const call = (data: string): Call => ({ method: 'eth_call', params: [{ to: proxy, data }, snapshot.tag] })
  const [code, version, discovery] = await read(route, [
    { method: 'eth_getCode', params: [proxy, snapshot.tag] },
    call(universal.encodeFunctionData('isENSv2')),
    call(universal.encodeFunctionData('findResolver', [dnsName])),
  ], assertCurrent)
  if (hex(code) === '0x') throw new Error('The configured ENS Universal Resolver has no code on this network.')
  if (decode(universal, 'isENSv2', version)[0] !== true) throw new Error('The configured resolver is not reporting ENSv2 support.')
  const [discovered, node, offset] = decode(universal, 'findResolver', discovery)
  const resolver = address(discovered)
  if (node.toLowerCase() !== namehash(name).toLowerCase() || offset > BigInt(getBytes(dnsName).length - 1)) throw malformed()
  if (expectedResolver && resolver !== expectedResolver) throw new Error('ENS resolver changed or does not match the expected agent resolver.')
  const [resolved, mandate] = await read(route, [
    call(universal.encodeFunctionData('resolve', [dnsName, profile.encodeFunctionData('addr', [namehash(name)])])),
    call(universal.encodeFunctionData('resolve', [dnsName, profile.encodeFunctionData('text', [namehash(name), TEXT_KEY])])),
  ], assertCurrent)
  const [addressData, addressResolver] = decode(universal, 'resolve', resolved)
  const [textData, textResolver] = decode(universal, 'resolve', mandate)
  if (getAddress(addressResolver) !== resolver || getAddress(textResolver) !== resolver) throw new Error('ENS records came from a different resolver than the discovered identity.')
  const resolvedAddress = address(decode(profile, 'addr', addressData)[0])
  const record = decode(profile, 'text', textData)[0] as string
  const mandateHash = record === '' ? null : hash(record)
  if (expectedHash && mandateHash !== expectedHash) throw new Error('ENS mandate hash is missing or does not match the reviewed mandate.')
  const [finalChain, finalHeader] = await read(route, [
    { method: 'eth_chainId', params: [] }, { method: 'eth_getBlockByNumber', params: [snapshot.tag, false] },
  ], assertCurrent)
  const finalBlock = blockHeader(finalHeader)
  if (finalChain !== chain || finalBlock.hash !== snapshot.hash || finalBlock.number !== snapshot.number) throw new Error('ENS snapshot changed. Read the identity again before reviewing it.')
  return { name, chainId, blockNumber: snapshot.number, blockHash: snapshot.hash,
    universalResolver: proxy, resolver, resolvedAddress, mandateHash, matchesExpectedMandate: expectedHash !== undefined && mandateHash === expectedHash,
    authorityVerified: false }
}
