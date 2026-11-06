import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poseidonContract } from 'circomlibjs';

const base = new URL('../', import.meta.url).pathname;
const output = join(base, 'artifacts');
await mkdir(output, { recursive: true });
for (const name of ['OxPayPool', 'Groth16Verifier']) {
  const path = join(base, 'out', `${name}.sol`, `${name}.json`);
  const data = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(join(output, `${name}.json`), JSON.stringify({ abi: data.abi, bytecode: data.bytecode.object }, null, 2));
}
await writeFile(join(output, 'Poseidon2.json'), JSON.stringify({
  abi: poseidonContract.generateABI(2),
  bytecode: poseidonContract.createCode(2)
}, null, 2));
