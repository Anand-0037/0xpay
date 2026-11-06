import { readFile } from 'node:fs/promises';
import { buildPoseidon } from 'circomlibjs';
import { groth16 } from 'snarkjs';

// Development fixture generator. Args: recipient, pool, chainId, fee, [nullifier, secret].
const [recipient, pool, chainId, fee, noteNullifier, noteSecret] = process.argv.slice(2);
if (!recipient || !pool || !chainId || !fee) throw new Error('recipient pool chainId fee required');
const poseidon = await buildPoseidon();
const hash = (values) => BigInt(poseidon.F.toString(poseidon(values)));
const nullifier = noteNullifier ? BigInt(noteNullifier) : 123456789n;
const secret = noteSecret ? BigInt(noteSecret) : 987654321n;
const commitment = hash([nullifier, secret]);
const nullifierHash = hash([nullifier]);
let zero = hash([0n, 0n]);
let root = commitment;
const pathElements = [];
for (let i = 0; i < 16; i++) {
  pathElements.push(zero.toString());
  root = hash([root, zero]);
  zero = hash([zero, zero]);
}
const input = {
  nullifier: nullifier.toString(), secret: secret.toString(),
  pathElements, pathIndices: Array(16).fill(0),
  root: root.toString(), nullifierHash: nullifierHash.toString(),
  recipient: BigInt(recipient).toString(), fee: BigInt(fee).toString(),
  chainId: BigInt(chainId).toString(), pool: BigInt(pool).toString(),
};
const base = new URL('../build/', import.meta.url).pathname;
const { proof, publicSignals } = await groth16.fullProve(input, `${base}withdraw.wasm`, `${base}withdraw_final.zkey`);
const key = JSON.parse(await readFile(`${base}verification_key.json`, 'utf8'));
if (!await groth16.verify(key, publicSignals, proof)) throw new Error('generated proof failed verification');
const flatProof = [
  proof.pi_a[0], proof.pi_a[1],
  proof.pi_b[0][1], proof.pi_b[0][0],
  proof.pi_b[1][1], proof.pi_b[1][0],
  proof.pi_c[0], proof.pi_c[1],
].map(String);
process.stdout.write(JSON.stringify({
  commitment: commitment.toString(), root: root.toString(),
  nullifierHash: nullifierHash.toString(), proof: flatProof,
  publicSignals,
}));
// snarkjs leaves worker threads alive after fullProve; FFI needs a terminating process.
process.exit(0);
