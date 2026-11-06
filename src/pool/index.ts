import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { decodeEventLog, encodeFunctionData, isAddress, keccak256, parseAbiItem, toHex, zeroAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import deployment from './deployments.devnet.json';
import { rpc, sleep, sponsoredTx, rawFrame, wireFrame } from './network.ts';
import type { FrameTx } from '@forshtat/hegota-support/tx';

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

// The browser route stays on the public devnet; local admission evidence uses a separate CLI.
export const config: { chainId: number; ethrexRpc: string; mempoolRpc: string; explorer: string; pool: Hex } = deployment as typeof config;
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
const depositEvent = parseAbiItem('event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)');
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
async function waitReceipt(hash: Hex, transport?: RpcTransport): Promise<{ status: Hex; blockNumber: Hex; logs: { topics: Hex[]; data: Hex }[] }> {
  for (let i = 0; i < 90; i++) {
    const receipt = await rpc<{ status: Hex; blockNumber: Hex; logs: { topics: Hex[]; data: Hex }[] } | null>(config.mempoolRpc, 'eth_getTransactionReceipt', [hash], transport);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`Transaction reverted: ${hash}`);
      return receipt;
    }
    await sleep(2000);
  }
  throw new Error(`Receipt timed out: ${hash}`);
}
export async function deposit(note: Note, opts: { privateKey: Hex; onStep?: (s: { kind: string; [k: string]: unknown }) => void; transport?: RpcTransport }): Promise<{ txHash: Hex; leafIndex: number }> {
  const account = privateKeyToAccount(opts.privateKey);
  const nonce = Number(BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_getTransactionCount', [account.address, 'pending'], opts.transport)));
  const raw = await account.signTransaction({ type: 'legacy', chainId: note.chainId, nonce, to: note.pool, value: 100_000_000_000_000_000n, data: depositCalldata(note.commitment), gas: 20_000_000n, gasPrice: 2_000_000_000n });
  const txHash = await rpc<Hex>(config.mempoolRpc, 'eth_sendRawTransaction', [raw], opts.transport);
  opts.onStep?.({ kind: 'submitted', txHash });
  const receipt = await waitReceipt(txHash, opts.transport);
  const log = receipt.logs.find(x => x.topics[0]?.toLowerCase() === keccak256(toHex('Deposit(bytes32,uint32,uint256)')).toLowerCase());
  if (!log) throw new Error(`Deposit event missing: ${txHash}`);
  const decoded = decodeEventLog({ abi: [depositEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  const leafIndex = Number(decoded.args.leafIndex);
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
export async function preflightClaim(tx: FrameTx, pool: Hex, transport?: RpcTransport): Promise<{ estimate?: unknown; estimateError?: string; simulation: unknown }> {
  // The estimator raises BODY gas limits before simulation, changing the signed hash.
  // Omit signatures here; the ethrex simulation below verifies the exact signed bytes.
  const estimateTx = { ...(wireFrame(tx) as Record<string, unknown>), signatures: undefined };
  let estimate: unknown, estimateError: string | undefined;
  try { estimate = await rpc(config.mempoolRpc, 'eth_estimateFrameTransactionGas', [estimateTx], transport); }
  catch (error) { estimateError = String(error); }
  const simulation = await rpc<{
    payer?: Hex | null;
    gasUsed?: Hex | null;
    executionStatus?: string | null;
    executionError?: string | null;
    frames?: { succeeded: boolean }[] | null;
  }>(config.ethrexRpc, 'ethrex_simulateFrameTransaction', [rawFrame(tx)], transport);
  if (simulation.payer?.toLowerCase() !== pool.toLowerCase()
    || !simulation.gasUsed
    || simulation.executionStatus !== 'success'
    || simulation.frames?.length !== tx.frames.length
    || simulation.frames.some(frame => !frame.succeeded)) {
    throw new Error(`Claim simulation failed: ${JSON.stringify(simulation)}`);
  }
  return { estimate, estimateError, simulation };
}
export async function claim(note: Note, opts: { recipientKey?: Hex; recipient?: Hex; onStep: (s: ClaimStep) => void; transport?: RpcTransport }): Promise<{ txHash: Hex; blockNumber: bigint }> {
  const key = opts.recipientKey ?? generatePrivateKey();
  const { sender, recipient } = claimAddresses(key, opts.recipient);
  opts.onStep({ kind: 'key', address: sender, balanceWei: await getBalance(sender, opts.transport) });
  const { leaves, logs } = await syncDeposits(note.pool, opts.transport);
  opts.onStep({ kind: 'sync', leaves: leaves.length });
  const index = logs.findIndex(x => x.commitment.toLowerCase() === note.commitment.toLowerCase());
  if (index < 0) throw new Error('Note commitment not deposited');
  const tree = merkle(leaves, index), nullifierHash = hash(note.nullifier);
  const maxFeePerGas = 2_000_000_000n;
  const paymentGas = 600_000n, senderGas = 300_000n, senderState = 200_000n;
  // The sidecar's max cost also includes intrinsic/signature gas; allow 50k for those plus 0.5 mETH margin.
  const fee = (30_000n + paymentGas + senderGas + senderState + 50_000n) * maxFeePerGas + 500_000_000_000_000n;
  const started = performance.now();
  const input = { nullifier: note.nullifier.toString(), secret: note.secret.toString(), pathElements: tree.pathElements.map(String), pathIndices: tree.pathIndices, root: tree.root.toString(), nullifierHash: nullifierHash.toString(), recipient: BigInt(recipient).toString(), fee: fee.toString(), chainId: note.chainId, pool: BigInt(note.pool).toString() };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  if (publicSignals[0] !== tree.root.toString()) throw new Error('Proof root mismatch');
  opts.onStep({ kind: 'proof', ms: performance.now() - started });
  const flat = [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt);
  const data = claimCalldata(flat, hex32(tree.root), hex32(nullifierHash), recipient, fee);
  const nonce = BigInt(await rpc<Hex>(config.mempoolRpc, 'eth_getTransactionCount', [sender, 'pending'], opts.transport));
  const tx = await sponsoredTx({ sender, key, payer: note.pool, to: note.pool, verifyData: data, data, nonce, paymentGas, senderGas, senderState, maxFeePerGas });
  opts.onStep({ kind: 'preflight', ...await preflightClaim(tx, note.pool, opts.transport) });
  let canonicalHash: Hex | undefined;
  try { canonicalHash = await rpc<Hex>(config.mempoolRpc, 'eth_sendRawTransaction', [rawFrame(tx)], opts.transport); opts.onStep({ kind: 'canonical', accepted: true, reason: canonicalHash }); }
  catch (error) { opts.onStep({ kind: 'canonical', accepted: false, reason: String(error) }); }
  let txHash: Hex;
  try {
    txHash = await rpc<Hex>(config.mempoolRpc, 'eth_sendFrameTransaction', [wireFrame(tx)], opts.transport);
    const report = await rpc(config.mempoolRpc, 'skandha_frameTransactionStatus', [txHash], opts.transport).catch(() => undefined);
    opts.onStep({ kind: 'alt', accepted: true, txHash, report });
  } catch (error) {
    opts.onStep({ kind: 'alt', accepted: false, reason: String(error) });
    if (!canonicalHash) throw error;
    txHash = canonicalHash;
  }
  const receipt = await waitReceipt(txHash, opts.transport), blockNumber = BigInt(receipt.blockNumber);
  opts.onStep({ kind: 'included', blockNumber, txHash, explorerUrl: config.explorer });
  opts.onStep({ kind: 'balance', address: recipient, balanceWei: await getBalance(recipient, opts.transport) });
  return { txHash, blockNumber };
}
