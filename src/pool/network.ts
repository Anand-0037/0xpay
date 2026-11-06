import { getProfile } from '@forshtat/hegota-support/profiles';
import * as frameLib from '@forshtat/hegota-support/tx';
import { toWire } from '@forshtat/hegota-support/rpc';
import type { Address, Hex } from 'viem';
import { config } from './index.ts';

export const profile = getProfile('ethrex-eip8141-tracer');
export const GATEWAY = 'https://altmempoolgateway.forshtat.com/rpc';
export const ETHREX = 'https://altmempool.forshtat.com';
export const EXPLORER = 'https://explorer.altmempool.wtf/';
export type RpcTransport = (url: string, body: unknown) => Promise<unknown>;
let overrideTransport: RpcTransport | undefined;
export const setCliTransport = (transport: RpcTransport) => { overrideTransport = transport; };
export const defaultTransport: RpcTransport = async (url, body) => {
  if (overrideTransport) return overrideTransport(url, body);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json();
};
let rpcId = 0;
export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = [], transport: RpcTransport = defaultTransport): Promise<T> {
  const result = await transport(url, { jsonrpc: '2.0', id: ++rpcId, method, params }) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (result.error) throw new Error(`${method}: ${result.error.code} ${result.error.message}${result.error.data ? ` ${JSON.stringify(result.error.data)}` : ''}`);
  return result.result as T;
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function receipt(hash: Hex, transport?: RpcTransport): Promise<{ status: Hex; blockNumber: Hex; contractAddress?: Address; logs?: unknown[] }> {
  for (let i = 0; i < 90; i++) {
    const found = await rpc<{ status: Hex; blockNumber: Hex; contractAddress?: Address; logs?: unknown[] } | null>(GATEWAY, 'eth_getTransactionReceipt', [hash], transport);
    if (found) return found;
    await sleep(2000);
  }
  throw new Error(`Receipt timed out: ${hash}`);
}
// Adapted from the frame shape in mempool-workshop/src/lib/frameTx/build.ts.
export async function sponsoredTx(a: { sender: Address; key: Hex; payer: Address; to: Address; data?: Hex; verifyData?: Hex; nonce?: bigint; paymentGas?: bigint; senderGas?: bigint; senderState?: bigint; maxFeePerGas?: bigint }): Promise<frameLib.FrameTx> {
  const frames = [
    frameLib.frame(profile, 'VERIFY', { scope: 'EXECUTION', target: null, execution: 30_000n }),
    frameLib.frame(profile, 'VERIFY', { scope: 'PAYMENT', target: a.payer, execution: a.paymentGas ?? 50_000n, data: a.verifyData }),
    frameLib.frame(profile, 'SENDER', { target: a.to, execution: a.senderGas ?? 50_000n, state: a.senderState, data: a.data }),
  ];
  const tx = frameLib.newTx({ chainId: config.chainId, sender: a.sender, nonceSeq: a.nonce ?? 0n, frames, signatures: [frameLib.secp256k1Placeholder(profile)], fees: { maxFeePerGas: a.maxFeePerGas ?? 2_000_000_000n } });
  return frameLib.signTx(profile, tx, a.key);
}
export const rawFrame = (tx: frameLib.FrameTx): Hex => frameLib.encodeTx(profile, tx);
export const wireFrame = (tx: frameLib.FrameTx) => toWire(tx);
