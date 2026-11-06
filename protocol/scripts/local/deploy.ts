import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, http, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = '/home/asus/alt/localchain';
const repo = '/home/asus/alt/0xpay-links';
const endpoint = 'http://127.0.0.1:10545';
const identity = JSON.parse(readFileSync(`${root}/identity.json`, 'utf8')) as { privateKey: Hex };
const registry = JSON.parse(readFileSync(`${root}/registry.json`, 'utf8')).address as Hex;
const chain = { id: 1337, name: '0xPay local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [endpoint] } } } as const;
const account = privateKeyToAccount(identity.privateKey);
const publicClient = createPublicClient({ chain, transport: http(endpoint) });
const wallet = createWalletClient({ chain, transport: http(endpoint), account });
if (await publicClient.getChainId() !== 1337) throw new Error('Wrong chain ID');
async function deploy(name: string, args: readonly unknown[] = [], value = 0n) {
  const artifact = JSON.parse(readFileSync(`${repo}/contracts/artifacts/${name}.json`, 'utf8')) as { abi: Abi; bytecode: Hex };
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const hash = await wallet.sendTransaction({ data, value, gas: 24_000_000n, gasPrice: 2_000_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} reverted: ${hash}`);
  console.log(JSON.stringify({ name, address: receipt.contractAddress, hash, block: receipt.blockNumber.toString(), status: receipt.status }));
  return { address: receipt.contractAddress, hash };
}
const poseidon = await deploy('Poseidon2');
const verifier = await deploy('Groth16Verifier');
const pool = await deploy('OxPayPool', [poseidon.address, verifier.address, registry], 312_000_000_000_000_000n);
const stakeData = encodeFunctionData({ abi: [{ type: 'function', name: 'getDepositInfo', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint32' }, { type: 'uint64' }] }], functionName: 'getDepositInfo', args: [pool.address] });
const stakeRaw = await publicClient.call({ to: registry, data: stakeData });
const stake = BigInt(`0x${stakeRaw.data!.slice(2, 66)}`);
if (stake < 12_000_000_000_000_000n) throw new Error(`Pool stake too low: ${stake}`);
const config = { chainId: 1337, ethrexRpc: endpoint, mempoolRpc: 'http://127.0.0.1:13000/rpc', explorer: 'http://127.0.0.1:13000/', pool: pool.address, poseidon: poseidon.address, verifier: verifier.address, registry, deployer: account.address, deployHash: pool.hash };
writeFileSync(`${repo}/deployments/local.json`, `${JSON.stringify(config, null, 2)}\n`);
console.log(JSON.stringify({ stake: stake.toString(), deployment: `${repo}/deployments/local.json` }));
