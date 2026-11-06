import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { claim, claimCalldata, config, createNote, deposit, getBalance, hash, merkle, setProofArtifacts, syncDeposits } from '../../client/src/index.js';
import { fund, rpc } from '../../client/src/node.js';
import { rawFrame, sponsoredTx, wireFrame } from '../../client/src/network.js';

setProofArtifacts(fileURLToPath(new URL('../../circuits/build/withdraw.wasm', import.meta.url)), fileURLToPath(new URL('../../circuits/build/withdraw_final.zkey', import.meta.url)));
const snarkjs = await import(fileURLToPath(new URL('../../client/node_modules/snarkjs/build/main.cjs', import.meta.url))) as { groth16: { fullProve(input: unknown, wasm: string, zkey: string): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] } }> } };
const hex32 = (x: bigint): Hex => toHex(x, { size: 32 });
const sourceKey = generatePrivateKey();
await fund(privateKeyToAccount(sourceKey).address);
let note = createNote(config.pool, config.chainId);
const deposited = await deposit(note, { privateKey: sourceKey });
const poolBeforeClaim = await getBalance(config.pool);
const firstKey = generatePrivateKey();
const firstRecipient = privateKeyToAccount(firstKey).address;
const first = await claim(note, { recipientKey: firstKey, onStep: s => { if (s.kind === 'canonical') console.log(JSON.stringify({ kind: s.kind, accepted: s.accepted, reason: s.reason })); if (s.kind === 'alt') console.log(JSON.stringify({ kind: s.kind, accepted: s.accepted, txHash: s.txHash, status: (s.report as { status?: string } | undefined)?.status, reason: s.reason })); if (s.kind === 'included') console.log(JSON.stringify({ kind: s.kind, txHash: s.txHash, blockNumber: s.blockNumber.toString() })); } });
const firstReceipt = await rpc<{ status: Hex }>(config.mempoolRpc, 'eth_getTransactionReceipt', [first.txHash]);
const poolAfterClaim = await getBalance(config.pool);
console.log(JSON.stringify({ control: 'valid claim', depositHash: deposited.txHash, claimHash: first.txHash, receiptStatus: firstReceipt.status, recipient: firstRecipient, recipientBalance: (await getBalance(firstRecipient)).toString(), poolBeforeClaim: poolBeforeClaim.toString(), poolAfterClaim: poolAfterClaim.toString() }));

async function makeProof(recipient: Hex) {
  const { leaves, logs } = await syncDeposits(note.pool);
  const index = logs.findIndex(x => x.commitment.toLowerCase() === note.commitment.toLowerCase());
  const tree = merkle(leaves, index);
  const fee = 2_860_000_000_000_000n;
  const nullifierHash = hash(note.nullifier);
  const input = { nullifier: note.nullifier.toString(), secret: note.secret.toString(), pathElements: tree.pathElements.map(String), pathIndices: tree.pathIndices, root: tree.root.toString(), nullifierHash: nullifierHash.toString(), recipient: BigInt(recipient).toString(), fee: fee.toString(), chainId: note.chainId, pool: BigInt(note.pool).toString() };
  const { proof } = await snarkjs.groth16.fullProve(input, fileURLToPath(new URL('../../circuits/build/withdraw.wasm', import.meta.url)), fileURLToPath(new URL('../../circuits/build/withdraw_final.zkey', import.meta.url)));
  const flat = [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt);
  return { flat, root: hex32(tree.root), nullifierHash: hex32(nullifierHash), fee };
}
type Result = { control: string; simulationStatus?: unknown; simulationError?: unknown; admission: string; poolBefore: string; poolAfter: string; recipientBefore: string; recipientAfter: string; txHash?: Hex; receipt?: unknown };
async function negative(control: string, change: 'none' | 'recipient' | 'root' | 'body'): Promise<Result> {
  const key = generatePrivateKey(), recipient = privateKeyToAccount(key).address;
  const proof = await makeProof(recipient);
  const payout = change === 'recipient' ? privateKeyToAccount(generatePrivateKey()).address : recipient;
  const root = change === 'root' ? hex32(BigInt(proof.root) ^ 1n) : proof.root;
  const data = claimCalldata(proof.flat, root, proof.nullifierHash, payout, proof.fee);
  const tx = await sponsoredTx({ sender: recipient, key, payer: note.pool, to: change === 'body' ? payout : note.pool, verifyData: change === 'body' ? claimCalldata(proof.flat, proof.root, proof.nullifierHash, recipient, proof.fee) : data, data: change === 'body' ? '0x' : data, paymentGas: 600_000n, senderGas: 300_000n, senderState: 200_000n });
  const poolBefore = await getBalance(note.pool), recipientBefore = await getBalance(payout);
  const sim = await rpc<{ executionStatus?: unknown; executionError?: unknown }>(config.ethrexRpc, 'ethrex_simulateFrameTransaction', [rawFrame(tx)]);
  let admission: string, txHash: Hex | undefined, receipt: unknown;
  try {
    txHash = await rpc<Hex>(config.mempoolRpc, 'eth_sendFrameTransaction', [wireFrame(tx)]);
    admission = 'ACCEPTED';
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      receipt = await rpc(config.mempoolRpc, 'eth_getTransactionReceipt', [txHash]);
      if (receipt) break;
    }
  } catch (error) { admission = `REJECTED ${String(error)}`; }
  const poolAfter = await getBalance(note.pool), recipientAfter = await getBalance(payout);
  const result = { control, simulationStatus: sim.executionStatus, simulationError: sim.executionError, admission, poolBefore: poolBefore.toString(), poolAfter: poolAfter.toString(), recipientBefore: recipientBefore.toString(), recipientAfter: recipientAfter.toString(), txHash, receipt };
  console.log(JSON.stringify(result));
  return result;
}
const results = [await negative('same nullifier after inclusion', 'none')];
note = createNote(config.pool, config.chainId);
await deposit(note, { privateKey: sourceKey });
results.push(await negative('tampered recipient', 'recipient'));
results.push(await negative('wrong root', 'root'));
results.push(await negative('frame 2 is transfer', 'body'));
writeFileSync('/home/asus/alt/localchain/negative-results.json', `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
