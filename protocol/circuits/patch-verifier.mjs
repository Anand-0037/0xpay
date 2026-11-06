import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../contracts/src/Groth16Verifier.sol', import.meta.url);
let source = readFileSync(path, 'utf8');

// EIP-1108 costs: ECMUL 6,000, ECADD 150, pairing 45,000 + 34,000 * 4.
// Fixed call limits avoid the GAS opcode, which payer validation bans.
for (const [address, limit] of [['7', '30000'], ['6', '10000'], ['8', '250000']]) {
  const original = `staticcall(sub(gas(), 2000), ${address},`;
  const occurrences = source.split(original).length - 1;
  if (occurrences !== 1) throw new Error(`Expected one snarkjs call to precompile ${address}; found ${occurrences}`);
  source = source.replace(original, `staticcall(${limit}, ${address},`);
}

writeFileSync(path, source);
