import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mayRestoreRejectedClaim } from '../src/pool/claim-recovery.ts'

test('restores only failures proven to precede or reject both broadcasts', () => {
  assert.equal(mayRestoreRejectedClaim(false), true)
  assert.equal(mayRestoreRejectedClaim(true), false)
  assert.equal(mayRestoreRejectedClaim(true,
    { kind: 'canonical', accepted: false, reason: 'eth_sendRawTransaction: -32000 validation gas exceeded' },
    { kind: 'alt', accepted: false, reason: 'eth_sendFrameTransaction: -32502 precompile not allowed' },
  ), true)
  assert.equal(mayRestoreRejectedClaim(true,
    { kind: 'canonical', accepted: false, reason: 'Private RPC read timed out' },
    { kind: 'alt', accepted: false, reason: 'eth_sendFrameTransaction: -32502 precompile not allowed' },
  ), false)
  assert.equal(mayRestoreRejectedClaim(true,
    { kind: 'canonical', accepted: false, reason: 'eth_sendRawTransaction: -32000 validation gas exceeded' },
    { kind: 'alt', accepted: false, reason: 'Private RPC read timed out' },
  ), false)
  assert.equal(mayRestoreRejectedClaim(true,
    { kind: 'canonical', accepted: true, reason: `0x${'ab'.repeat(32)}` },
  ), false)
  assert.equal(mayRestoreRejectedClaim(true,
    { kind: 'canonical', accepted: false, reason: 'eth_sendRawTransaction: -32000 validation gas exceeded' },
    { kind: 'alt', accepted: true, txHash: `0x${'ab'.repeat(32)}` },
  ), false)
})
