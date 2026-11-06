import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faucet, type RpcTransport } from '../src/pool/index.ts'
import { FAUCET_RPC_URL } from '../src/rpc/networks.ts'
import { createPayApi } from '../src/pool/api.ts'
import type { PrivateRpc } from '../src/rpc.ts'

const address = '0x1111111111111111111111111111111111111111'
const txHash = `0x${'a'.repeat(64)}`

test('wallet API exposes the devnet faucet action', () => {
  const api = createPayApi({} as PrivateRpc)
  assert.equal(typeof api.requestDevnetFunds, 'function')
})

test('devnet faucet requests funds through the injected transport and waits for an included receipt', async () => {
  const calls: { url: string; method: string; params: unknown[] }[] = []
  const transport: RpcTransport = async (url, body) => {
    const request = body as { method: string; params: unknown[] }
    calls.push({ url, method: request.method, params: request.params })
    if (request.method === 'skandha_explorer_faucet') return { result: { txHash, amount: '1000000000000000000' } }
    if (request.method === 'eth_getTransactionReceipt') return { result: { transactionHash: txHash, status: '0x1' } }
    throw new Error(`Unexpected method: ${request.method}`)
  }
  assert.equal(await faucet(address, transport), txHash)
  assert.deepEqual(calls, [
    { url: FAUCET_RPC_URL, method: 'skandha_explorer_faucet', params: [address] },
    { url: FAUCET_RPC_URL, method: 'eth_getTransactionReceipt', params: [txHash] },
  ])
})

test('faucet cannot report success without a verifiable transaction hash', async () => {
  const transport: RpcTransport = async () => ({ result: { amount: '1000000000000000000' } })
  await assert.rejects(faucet(address, transport), /did not return a transaction hash/)
})
