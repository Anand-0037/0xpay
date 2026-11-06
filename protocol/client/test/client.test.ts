import { describe, expect, it } from 'vitest';
import { buildPoseidon } from 'circomlibjs';
import { decodeFunctionData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as frame from '@forshtat/hegota-support/tx';
import { createNote, encodeNoteLink, decodeNoteLink, merkle, claimAddresses, claimCalldata, depositCalldata, hash, preflightClaim } from '../src/index.js';
import { profile, sponsoredTx, rawFrame } from '../src/network.js';

const pool = '0x1111111111111111111111111111111111111111' as Hex;
describe('notes', () => {
  it('roundtrips the fragment and binds its commitment', () => {
    const note = createNote(pool, 1337);
    const link = encodeNoteLink(note, 'https://example.test/send?x=1#old');
    expect(link).toMatch(/^https:\/\/example.test\/send\?x=1#claim=/);
    expect(decodeNoteLink(link)).toEqual(note);
    expect(decodeNoteLink(link.slice(link.indexOf('#')))).toEqual(note);
  });
  it('matches circomlibjs Poseidon and Merkle zero tree', async () => {
    const p = await buildPoseidon();
    const h = (...x: bigint[]) => BigInt(p.F.toString(p(x)));
    const note = createNote(pool, 1337);
    expect(BigInt(note.commitment)).toBe(h(note.nullifier, note.secret));
    const leaves = [11n, 22n, 33n];
    const tree = merkle(leaves, 2);
    let node = leaves[2];
    for (let i = 0; i < 16; i++) node = tree.pathIndices[i] ? h(tree.pathElements[i], node) : h(node, tree.pathElements[i]);
    expect(node).toBe(tree.root);
    expect(tree.pathElements[0]).toBe(h(0n, 0n));
    expect(hash(1n, 2n)).toBe(h(1n, 2n));
  });
});
describe('encoding', () => {
  it('keeps the frame sender separate from the proof payout recipient', () => {
    const key = generatePrivateKey(), sender = privateKeyToAccount(key).address;
    const payout = '0x2222222222222222222222222222222222222222' as Hex;
    expect(claimAddresses(key, payout)).toEqual({ sender, recipient: payout });
    expect(claimAddresses(key)).toEqual({ sender, recipient: sender });
    expect(() => claimAddresses(key, '0x0000000000000000000000000000000000000000')).toThrow('Invalid payout address');
  });
  it('encodes deposit and claim selectors with the expected arguments', () => {
    expect(depositCalldata(`0x${'12'.repeat(32)}`)).toMatch(/^0xb214faa5/);
    const data = claimCalldata(Array(8).fill(1n), `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`, pool, 3n);
    expect(data.length).toBe(2 + 8 + (8 + 1 + 1 + 1 + 1) * 64);
  });
  it('encodes a signed type-0x06 three-frame transaction', async () => {
    const key = generatePrivateKey(), sender = privateKeyToAccount(key).address;
    const tx = await sponsoredTx({ sender, key, payer: pool, to: pool, data: '0x1234', verifyData: '0x1234', paymentGas: 600_000n });
    const raw = rawFrame(tx);
    expect(raw.startsWith('0x06')).toBe(true);
    const decoded = frame.decodeTx(profile, raw);
    expect(decoded.frames).toHaveLength(3);
    expect(decoded.frames[1].data).toBe('0x1234');
  });
  it('requires successful read-only estimate and execution simulation before submission', async () => {
    const key = generatePrivateKey(), sender = privateKeyToAccount(key).address;
    const tx = await sponsoredTx({ sender, key, payer: pool, to: pool, data: '0x1234', verifyData: '0x1234' });
    const methods: string[] = [];
    const transport = async (_url: string, request: unknown) => {
      const { method, params } = request as { method: string; params: Record<string, unknown>[] };
      methods.push(method);
      if (method === 'eth_estimateFrameTransactionGas') expect(params[0].signatures).toBeUndefined();
      if (method === 'ethrex_simulateFrameTransaction') expect(params[0]).toBe(rawFrame(tx));
      return { result: method === 'eth_estimateFrameTransactionGas'
        ? { frames: [] }
        : { payer: pool, gasUsed: '0x1234', executionStatus: 'success', frames: [{ succeeded: true }, { succeeded: true }, { succeeded: true }] } };
    };
    await expect(preflightClaim(tx, pool, transport)).resolves.toMatchObject({ simulation: { executionStatus: 'success' } });
    expect(methods).toEqual(['eth_estimateFrameTransactionGas', 'ethrex_simulateFrameTransaction']);
    await expect(preflightClaim(tx, pool, async (_url, request) => (request as { method: string }).method === 'eth_estimateFrameTransactionGas'
      ? { error: { code: -32500, message: 'default code reported failure' } }
      : { result: { payer: pool, gasUsed: '0x1234', executionStatus: 'success', frames: [{ succeeded: true }, { succeeded: true }, { succeeded: true }] } }
    )).resolves.toMatchObject({ estimateError: expect.stringContaining('default code reported failure'), simulation: { executionStatus: 'success' } });
    await expect(preflightClaim(tx, pool, async (_url, request) => ({ result: (request as { method: string }).method === 'eth_estimateFrameTransactionGas'
      ? { frames: [] }
      : { payer: pool, gasUsed: '0x1234', executionStatus: 'reverted', frames: [{ succeeded: false }] } }))).rejects.toThrow('Claim simulation failed');
  });
});
