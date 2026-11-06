import { CLAIM_GAS, CLAIM_FEE, DEPOSIT_TX } from './fees.ts';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { decodeFunctionResult, encodeFunctionData, isAddress, keccak256, parseAbiItem, toHex, zeroAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import deployment from './deployments.devnet.json';
import { rpc, sleep, sponsoredTx, rawFrame, wireFrame } from './network.ts';
import type { FrameTx } from '@forshtat/hegota-support/tx';
import { assertReturnedHash, broadcastPrepared, depositEvent, isCanonicalPolicyRejection, NOTE_VALUE, verifyClaimReceipt, verifyDepositReceipt, verifyNativePayout, type ClaimIntent, type DepositIntent, type PaymentReceipt, type PreparedPayment } from './payment-records.ts';
import { decodeEventLog } from 'viem';
export type { PreparedPayment } from './payment-records.ts';

export type Note = { nullifier: bigint; secret: bigint; commitment: `0x${string}`; pool: `0x${string}`; chainId: number };
export type RpcTransport = (url: string, body: unknown) => Promise<unknown>;
export type ClaimStep =
  | { kind: 'key'; address: `0x${string}`; balanceWei: bigint }
  | { kind: 'sync'; leaves: number }
  | { kind: 'proof'; ms: number }
  | { kind: 'preflight'; estimate?: unknown; estimateError?: string; simulation: unknown }
  | { kind: 'canonical'; accepted: boolean; reason: string }
  | { kind: 'alt'; accepted: boolean; txHash?: `0x${string}`; report?: unknown; reason?: string }
  | { kind: 'included'; blockNumber: bigint; txHash: `0x${string}`; explorerUrl: string }
  | { kind: 'balance'; address: `0x${string}`; balanceWei: bigint };

// Browser workers require a reachable HTTPS devnet. Loopback testing belongs to protocol/ CLI.
export const config: { chainId: number; ethrexRpc: string; mempoolRpc: string; explorer: string; pool: Hex; poolCodeHash: Hex } = deployment as typeof config;
const poseidon = await buildPoseidon();
export const hash = (...inputs: bigint[]): bigint => BigInt(poseidon.F.toString(poseidon(inputs)));
const hex32 = (n: bigint): Hex => toHex(n, { size: 32 });
const field = (): bigint => {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return BigInt(toHex(bytes));
};
export function createNote(pool: Hex, chainId: number): Note {
  const nullifier = field(), secret = field();
  return { nullifier, secret, commitment: hex32(hash(nullifier, secret)), pool, chainId };
}
export function encodeNoteLink(note: Note, baseUrl: string): string {
  const payload = JSON.stringify({ v: 1, n: hex32(note.nullifier), s: hex32(note.secret), c: note.commitment, p: note.pool, i: note.chainId });
  const encoded = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${baseUrl.split('#')[0]}#claim=${encoded}`;
}
export function decodeNoteLink(hashOrUrl: string): Note {
  const fragment = hashOrUrl.includes('#') ? hashOrUrl.split('#')[1] : hashOrUrl;
  const encoded = fragment.startsWith('claim=') ? fragment.slice(6) : new URLSearchParams(fragment).get('claim');
  if (!encoded) throw new Error('Missing claim note');
  const x = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as { v: number; n: Hex; s: Hex; c: Hex; p: Hex; i: number };
  if (x.v !== 1 || !/^0x[\da-fA-F]{40}$/.test(x.p) || !Number.isSafeInteger(x.i)) throw new Error('Invalid claim note');
  const note = { nullifier: BigInt(x.n), secret: BigInt(x.s), commitment: x.c, pool: x.p, chainId: x.i };
  if (hex32(hash(note.nullifier, note.secret)).toLowerCase() !== note.commitment.toLowerCase()) throw new Error('Invalid commitment');
  return note;
}

export function merkle(leaves: bigint[], leafIndex: number): { root: bigint; pathElements: bigint[]; pathIndices: number[] } {
  if (leaves.length > 65536 || leafIndex < 0 || leafIndex >= leaves.length) throw new Error('Invalid Merkle index');
  let level = leaves.slice(), zero = hash(0n, 0n), index = leafIndex;
  const pathElements: bigint[] = [], pathIndices: number[] = [];
  for (let depth = 0; depth < 16; depth++) {
    pathElements.push(level[index ^ 1] ?? zero);
    pathIndices.push(index & 1);
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash(level[i], level[i + 1] ?? zero));
    level = next;
    zero = hash(zero, zero);
    index >>= 1;
  }
  return { root: level[0], pathElements, pathIndices };
}
const poolAbi = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [{ name: 'commitment', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'proof', type: 'uint256[8]' }, { name: 'root', type: 'bytes32' }, { name: 'nullifierHash', type: 'bytes32' }, { name: 'recipient', type: 'address' }, { name: 'fee', type: 'uint256' }], outputs: [] }] as const;
export const claimCalldata = (proof: readonly bigint[], root: Hex, nullifierHash: Hex, recipient: Hex, fee: bigint): Hex =>
  encodeFunctionData({ abi: poolAbi, functionName: 'claim', args: [proof as unknown as readonly [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint], root, nullifierHash, recipient, fee] });
export const depositCalldata = (commitment: Hex): Hex => encodeFunctionData({ abi: poolAbi, functionName: 'deposit', args: [commitment] });
export async function syncDeposits(pool: Hex, transport?: RpcTransport): Promise<{ leaves: bigint[]; logs: { commitment: Hex; leafIndex: number }[] }> {
  const raw = await rpc<{ data: Hex; topics: Hex[] }[]>(config.mempoolRpc, 'eth_getLogs', [{ address: pool, fromBlock: '0x0', toBlock: 'latest', topics: [keccak256(toHex('Deposit(bytes32,uint32,uint256)'))] }], transport);
  const logs = raw.map(log => {
    const decoded = decodeEventLog({ abi: [depositEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return { commitment: decoded.args.commitment as Hex, leafIndex: Number(decoded.args.leafIndex) };
  }).sort((a, b) => a.leafIndex - b.leafIndex);
  for (let i = 0; i < logs.length; i++) if (logs[i].leafIndex !== i) throw new Error(`Missing deposit leaf ${i}`);
  return { leaves: logs.map(x => BigInt(x.commitment)), logs };
}
export async function getBalance(address: Hex, transport?: RpcTransport): Promise<bigint> {
  return BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_getBalance', [address, 'latest'], transport));
}
export async function faucet(address: Hex, transport?: RpcTransport): Promise<void> {
  const result = await rpc<{ txHash: Hex }>(config.mempoolRpc, 'skandha_explorer_faucet', [address], transport);
  await waitReceipt(result.txHash, transport);
}
async function waitReceipt(hash: Hex, transport?: RpcTransport): Promise<PaymentReceipt> {
  for (let i = 0; i < 90; i++) {
    const receipt = await rpc<PaymentReceipt | null>(config.mempoolRpc, 'eth_getTransactionReceipt', [hash], transport);
    if (receipt) {
      assertReturnedHash(receipt.transactionHash, hash);
      if (receipt.status !== '0x1') throw new Error(`Transaction reverted: ${hash}`);
      return receipt;
    }
    await sleep(2000);
  }
  throw new Error(`Receipt timed out: ${hash}`);
}
function assertNoteDomain(note: Note) {
  if (note.chainId !== config.chainId || note.pool.toLowerCase() !== config.pool.toLowerCase()) throw new Error('Note belongs to another network or pool');
}
export async function deposit(note: Note, opts: { privateKey: Hex; onStep?: (s: { kind: string; [k: string]: unknown }) => void; onPrepared?: (intent: PreparedPayment) => Promise<void>; transport?: RpcTransport }): Promise<{ txHash: Hex; leafIndex: number }> {
  assertNoteDomain(note);
  const account = privateKeyToAccount(opts.privateKey);
  const nonce = Number(BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_getTransactionCount', [account.address, 'pending'], opts.transport)));
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Funding account nonce is unsupported');
  const raw = await account.signTransaction({ type: 'legacy', chainId: note.chainId, nonce, to: note.pool, value: NOTE_VALUE, data: depositCalldata(note.commitment), gas: DEPOSIT_TX.gas, gasPrice: DEPOSIT_TX.gasPrice });
  const expectedHash = keccak256(raw);
  const intent: DepositIntent = Object.freeze({ operation: 'deposit', txHash: expectedHash, chainId: note.chainId, pool: note.pool, sender: account.address, nonce, commitment: note.commitment, amountWei: NOTE_VALUE.toString() });
  const txHash = await broadcastPrepared(intent, opts.onPrepared, () => rpc<Hex>(config.mempoolRpc, 'eth_sendRawTransaction', [raw], opts.transport));
  assertReturnedHash(txHash, expectedHash);
  opts.onStep?.({ kind: 'submitted', txHash });
  const receipt = await waitReceipt(txHash, opts.transport);
  const { leafIndex } = verifyDepositReceipt(receipt, intent);
  opts.onStep?.({ kind: 'included', txHash, leafIndex, blockNumber: BigInt(receipt.blockNumber) });
  return { txHash, leafIndex };
}
let wasmPath = '/circuits/withdraw.wasm', zkeyPath = '/circuits/withdraw_final.zkey';
export function setProofArtifacts(wasm: string, zkey: string): void { wasmPath = wasm; zkeyPath = zkey; }
export function claimAddresses(key: Hex, payout?: Hex): { sender: Hex; recipient: Hex } {
  const sender = privateKeyToAccount(key).address;
  const recipient = payout ?? sender;
  if (!isAddress(recipient) || recipient.toLowerCase() === zeroAddress) throw new Error('Invalid payout address');
  return { sender, recipient };
}
export type ClaimSimulation = { payer?: Hex | null; gasUsed?: Hex | null; executionStatus?: string | null; executionError?: string | null; frames?: { succeeded: boolean }[] | null; canonicalMempoolValid?: boolean; canonicalMempoolViolation?: string };
export async function preflightClaim(tx: FrameTx, pool: Hex, transport?: RpcTransport): Promise<{ estimate?: unknown; estimateError?: string; simulation: ClaimSimulation }> {
  // The estimator raises BODY gas limits before simulation, changing the signed hash.
  // Omit signatures here; the ethrex simulation below verifies the exact signed bytes.
  const estimateTx = { ...(wireFrame(tx) as Record<string, unknown>), signatures: undefined };
  let estimate: unknown, estimateError: string | undefined;
  try { estimate = await rpc(config.mempoolRpc, 'eth_estimateFrameTransactionGas', [estimateTx], transport); }
  catch (error) { estimateError = String(error); }
  const simulation = await rpc<ClaimSimulation>(config.ethrexRpc, 'ethrex_simulateFrameTransaction', [rawFrame(tx)], transport);
  if (simulation.payer?.toLowerCase() !== pool.toLowerCase()
    || !simulation.gasUsed
    || simulation.executionStatus !== 'success'
    || simulation.frames?.length !== tx.frames.length
    || simulation.frames.some(frame => !frame.succeeded)) {
    const failedFrame = simulation.frames?.findIndex(frame => !frame.succeeded) ?? -1;
    const detail = failedFrame >= 0 ? ` at frame ${failedFrame + 1}` : ': the gas payer or validation response did not match';
    throw new Error(`Claim simulation failed${detail}. No claim was submitted. Your note is preserved.`);
  }
  return { estimate, estimateError, simulation };
}
export async function claim(note: Note, opts: { recipientKey?: Hex; recipient?: Hex; onStep: (s: ClaimStep) => void; onPrepared?: (intent: PreparedPayment) => Promise<void>; transport?: RpcTransport }): Promise<{ txHash: Hex; blockNumber: bigint }> {
  assertNoteDomain(note);
  const key = opts.recipientKey ?? generatePrivateKey();
  const { sender, recipient } = claimAddresses(key, opts.recipient);
  opts.onStep({ kind: 'key', address: sender, balanceWei: await getBalance(sender, opts.transport) });
  const { leaves, logs } = await syncDeposits(note.pool, opts.transport);
  opts.onStep({ kind: 'sync', leaves: leaves.length });
  const index = logs.findIndex(x => x.commitment.toLowerCase() === note.commitment.toLowerCase());
  if (index < 0) throw new Error('Note commitment not deposited');
  const tree = merkle(leaves, index), nullifierHash = hash(note.nullifier);
  const { maxFeePerGas, payment: paymentGas, sender: senderGas, senderState } = CLAIM_GAS;
  const fee = CLAIM_FEE;
  const started = performance.now();
  const input = { nullifier: note.nullifier.toString(), secret: note.secret.toString(), pathElements: tree.pathElements.map(String), pathIndices: tree.pathIndices, root: tree.root.toString(), nullifierHash: nullifierHash.toString(), recipient: BigInt(recipient).toString(), fee: fee.toString(), chainId: note.chainId, pool: BigInt(note.pool).toString() };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const expectedSignals = [tree.root, nullifierHash, BigInt(recipient), fee, BigInt(note.chainId), BigInt(note.pool)].map(String);
  if (publicSignals.length !== expectedSignals.length || publicSignals.some((value, index) => value !== expectedSignals[index])) throw new Error('Proof public inputs do not match the prepared payment');
  opts.onStep({ kind: 'proof', ms: performance.now() - started });
  const flat = [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt);
  const data = claimCalldata(flat, hex32(tree.root), hex32(nullifierHash), recipient, fee);
  const nonce = BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_getTransactionCount', [sender, 'pending'], opts.transport));
  const tx = await sponsoredTx({ sender, key, payer: note.pool, to: note.pool, verifyData: data, data, nonce, paymentGas, senderGas, senderState, maxFeePerGas });
  const preflight = await preflightClaim(tx, note.pool, opts.transport);
  opts.onStep({ kind: 'preflight', ...preflight });
  const raw = rawFrame(tx), expectedHash = keccak256(raw);
  const intent: ClaimIntent = Object.freeze({ operation: 'claim', txHash: expectedHash, chainId: note.chainId, pool: note.pool, sender, recipient, nullifierHash: hex32(nullifierHash), feeWei: fee.toString(), amountWei: (NOTE_VALUE - fee).toString() });
  // Finish the durable journal callback before either submission endpoint is used.
  await opts.onPrepared?.(intent);
  let canonicalHash: Hex | undefined;
  try {
    canonicalHash = await rpc<Hex>(config.mempoolRpc, 'eth_sendRawTransaction', [raw], opts.transport);
    assertReturnedHash(canonicalHash, expectedHash);
    opts.onStep({ kind: 'canonical', accepted: true, reason: canonicalHash });
  } catch (error) {
    if (!isCanonicalPolicyRejection(error, preflight.simulation)) throw new Error(`Canonical submission outcome is unknown. Check ${expectedHash} before another send.`);
    opts.onStep({ kind: 'canonical', accepted: false, reason: String(error) });
  }
  let txHash = canonicalHash;
  if (!txHash) {
    try {
      txHash = await rpc<Hex>(config.mempoolRpc, 'eth_sendFrameTransaction', [wireFrame(tx)], opts.transport);
      assertReturnedHash(txHash, expectedHash);
      const report = await rpc(config.mempoolRpc, 'skandha_frameTransactionStatus', [txHash], opts.transport).catch(() => undefined);
      opts.onStep({ kind: 'alt', accepted: true, txHash, report });
    } catch (error) {
      if (/eth_sendFrameTransaction: -(?:32500|32502|32602)\b/.test(String(error))) opts.onStep({ kind: 'alt', accepted: false, reason: String(error) });
      throw new Error(`Claim submission did not complete. Check ${expectedHash} before another send.`);
    }
  }
  const receipt = await waitReceipt(txHash, opts.transport), blockNumber = BigInt(receipt.blockNumber);
  const payout = await confirmClaimPayment(receipt, intent, opts.transport);
  opts.onStep({ kind: 'included', blockNumber, txHash, explorerUrl: config.explorer });
  opts.onStep({ kind: 'balance', address: recipient, balanceWei: payout.recipientBalance });
  return { txHash, blockNumber };
}

/** Read-only completion/reload check for an already prepared exact hash. */
export async function confirmClaimPayment(receipt: PaymentReceipt, intent: ClaimIntent, transport?: RpcTransport) {
  if (intent.chainId !== config.chainId || intent.pool.toLowerCase() !== config.pool.toLowerCase() || BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_chainId', [], transport)) !== BigInt(intent.chainId)) throw new Error('Pending claim belongs to another network or pool');
  const { blockNumber, amountWei } = verifyClaimReceipt(receipt, intent);
  const blockTag = toHex(blockNumber);
  verifyNativePayout(receipt, intent, amountWei);
  const header = await rpc<{ hash: Hex } | null>(config.mempoolRpc, 'eth_getBlockByNumber', [blockTag, false], transport);
  if (header?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('Claim block changed; reconcile the existing transaction');
  // This devnet currently returns latest balances even for historical block tags.
  // The protocol transfer log proves this receipt's exact payout; balance is informational.
  const after = BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_getBalance', [intent.recipient, 'latest'], transport));
  const spentAbi = [parseAbiItem('function nullifierSpent(bytes32) view returns (bool)')];
  const spentResult = await rpc<Hex>(config.mempoolRpc, 'eth_call', [{ to: intent.pool, data: encodeFunctionData({ abi: spentAbi, functionName: 'nullifierSpent', args: [intent.nullifierHash] }) }, 'latest'], transport);
  const spent = decodeFunctionResult({ abi: spentAbi, functionName: 'nullifierSpent', data: spentResult });
  if (!spent) throw new Error('Claim nullifier is not spent; check the existing transaction');
  const checked = await rpc<{ hash: Hex } | null>(config.mempoolRpc, 'eth_getBlockByNumber', [blockTag, false], transport);
  if (checked?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('Claim block changed during verification; reconcile the existing transaction');
  return { blockNumber, amountWei, recipientBalance: after, payoutEvidence: 'eip-7708-transfer' as const };
}
