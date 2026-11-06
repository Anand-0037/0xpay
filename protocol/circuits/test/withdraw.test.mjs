import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

test('generates and verifies a depth-16 withdrawal proof', () => {
  const output = execFileSync(process.execPath, [new URL('./prove.mjs', import.meta.url).pathname,
    '0x000000000000000000000000000000000000B0b0',
    '0x000000000000000000000000000000000000A0a0', '1337', '1000000000000000',
    BigInt(`0x${randomBytes(31).toString('hex')}`).toString(),
    BigInt(`0x${randomBytes(31).toString('hex')}`).toString()],
  { encoding: 'utf8' });
  const fixture = JSON.parse(output);
  assert.equal(fixture.publicSignals.length, 6);
  assert.equal(fixture.publicSignals[0], fixture.root);
  assert.equal(fixture.publicSignals[1], fixture.nullifierHash);
});
