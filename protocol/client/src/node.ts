import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeDeployData, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { GATEWAY, EXPLORER, receipt, rpc, sponsoredTx, rawFrame, wireFrame, setCliTransport } from './network.js';

const execFileAsync = promisify(execFile);
setCliTransport(async (url, body) => {
  const { stdout } = await execFileAsync('curl', ['-sS', '--fail', '--connect-timeout', '10', '--max-time', '45', '-H', 'Content-Type: application/json', '--data', JSON.stringify(body), url], { maxBuffer: 10_000_000 });
  return JSON.parse(stdout);
});

export { generatePrivateKey, privateKeyToAccount, rpc, GATEWAY, EXPLORER, receipt };
export async function fund(address: Address): Promise<Hex> {
  const result = await rpc<{ txHash: Hex }>(GATEWAY, 'skandha_explorer_faucet', [address]);
  const mined = await receipt(result.txHash);
  if (mined.status !== '0x1') throw new Error(`Faucet transfer reverted: ${result.txHash}`);
  return result.txHash;
}
export async function sendLegacy(key: Hex, tx: { to?: Address; value?: bigint; data?: Hex; gas?: bigint }): Promise<Hex> {
  const account = privateKeyToAccount(key);
  const nonce = Number(BigInt(await rpc<Hex>(GATEWAY, 'eth_getTransactionCount', [account.address, 'pending'])));
  const raw = await account.signTransaction({ type: 'legacy', chainId: 1337, nonce, to: tx.to, value: tx.value ?? 0n, data: tx.data ?? '0x', gas: tx.gas ?? 6_000_000n, gasPrice: 2_000_000n });
  return rpc<Hex>(GATEWAY, 'eth_sendRawTransaction', [raw]);
}
export async function deployArtifact(key: Hex, path: string, value = 0n, args: readonly unknown[] = []): Promise<{ address: Address; hash: Hex }> {
  const artifact = JSON.parse(fs.readFileSync(path, 'utf8')) as { abi: Abi; bytecode: Hex };
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const hash = await sendLegacy(key, { data, value, gas: 30_000_000n });
  const mined = await receipt(hash);
  if (mined.status !== '0x1' || !mined.contractAddress) throw new Error(`Deployment reverted: ${hash}`);
  return { address: mined.contractAddress, hash };
}
export async function smoke() {
  const payerKey = generatePrivateKey();
  const payerOwner = privateKeyToAccount(payerKey).address;
  const faucetHash = await fund(payerOwner);
  console.log({ payerOwner, faucetHash });
  const deployed = await deployArtifact(payerKey, '/home/asus/alt/mempool-workshop/contracts/artifacts/SponsorPaymaster.json', 10_000_000_000_000_000n);
  console.log({ paymaster: deployed.address, deployHash: deployed.hash });
  const key = generatePrivateKey();
  const sender = privateKeyToAccount(key).address;
  const balanceBefore = await rpc<Hex>(GATEWAY, 'eth_getBalance', [sender, 'latest']);
  const tx = await sponsoredTx({ sender, key, payer: deployed.address, to: payerOwner });
  let canonical: string;
  try { canonical = `ACCEPTED ${await rpc<Hex>(GATEWAY, 'eth_sendRawTransaction', [rawFrame(tx)])}`; }
  catch (error) { canonical = `REJECTED ${String(error)}`; }
  console.log({ sender, balanceBefore, canonical });
  const altHash = await rpc<Hex>(GATEWAY, 'eth_sendFrameTransaction', [wireFrame(tx)]);
  let status: unknown;
  for (let i = 0; i < 45; i++) {
    status = await rpc(GATEWAY, 'skandha_frameTransactionStatus', [altHash]);
    if ((status as { status?: string })?.status === 'Included') break;
    const found = await rpc(GATEWAY, 'eth_getTransactionReceipt', [altHash]);
    if (found) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const mined = await receipt(altHash);
  const balanceAfter = await rpc<Hex>(GATEWAY, 'eth_getBalance', [sender, 'latest']);
  console.log({ altHash, status, mined, balanceAfter, explorer: `${EXPLORER}?tx=${altHash}` });
}
