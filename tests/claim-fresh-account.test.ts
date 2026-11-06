import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claim, config, createNote, type ClaimStep, type RpcTransport } from '../src/pool/index.ts'

test('claim stops before proving or submission if its sender already has ETH', async () => {
  const methods: string[] = []
  const steps: ClaimStep[] = []
  const transport: RpcTransport = async (_url, body) => {
    const method = (body as { method: string }).method
    methods.push(method)
    if (method === 'eth_getBalance') return { result: '0x1' }
    throw new Error(`Unexpected request after funded sender check: ${method}`)
  }
  await assert.rejects(claim(createNote(config.pool, config.chainId), {
    recipientKey: `0x${'1'.repeat(64)}`,
    recipient: `0x${'2'.repeat(40)}`,
    onStep: step => steps.push(step),
    transport,
  }), /Claim account is funded/)
  assert.deepEqual(methods, ['eth_getBalance'])
  assert.equal(steps.length, 1)
  assert.equal(steps[0]?.kind, 'key')
  if (steps[0]?.kind === 'key') assert.equal(steps[0].balanceWei, 1n)
})
