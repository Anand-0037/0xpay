# Evidence (real runs, public devnet chain 1337)

All values below were produced by commands run on 6 Nov 2026 (UTC ~11:00–11:30). Explorer: https://explorer.altmempool.wtf/ (search the hash).

## Pool deployment (`npm run deploy`, client/)
- Poseidon2 `0x3c913baa92e0bab4b6a56782f305dc62414298b0` (tx `0xba90b38c32b4bdddde51597b74fd8faebb6aafe8edb9057bdf40c342fd96bcbb`)
- Groth16Verifier `0xd2059624c0b6718e187b93ee715e0e9163e5777f` (tx `0xc25b7859294f47add6812b07ec34e56e5e52904f3cf3d5b6bd28d23ccfdc0a2a`)
- OxPayPool `0xf409d9a52cd9b8c61a44cc8c9cdef0d85b58259c` (tx `0xe1503d57c2f73c81f826013f9acda02f7ec7bd1b576eb0fd8865e3622a6e39d6`)
- Staked from its own constructor: registry `getDepositInfo` stake = `12000000000000000` wei (0.012 ETH).

## Deposit
- Deposit tx `0xa91cf7f2696319a5f457eefbda0e7865e2976b26f733a61d59388fd51563b1d1`, leaf 0, block 2946.

## Claim from a fresh 0-ETH key (`npm run demo`)
- Receiver `0xA53574196408eb677E33F69aEe2C0691e69aD69f`, balance before: 0 wei. Pool had 2 deposits.
- Groth16 proof generated in 1,354 ms (Node, snarkjs).
- `ethrex_simulateFrameTransaction` on the exact signed claim: `executionStatus: success`, 3/3 frames succeeded,
  `payer` = OxPayPool, `prefixShape: OnlyVerifyPay`, gasUsed `0xa6796` (681,878), maxCost `0x83bc9dd3e5400`,
  `canonicalMempoolValid: false`, violation `prefix gas budget exceeded: 632800 > 100000 (MAX_VERIFY_GAS)`.
- Canonical mempool (`eth_sendRawTransaction`): **rejected** — `-32000 Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`.
- Public alt-mempool sidecar (`eth_sendFrameTransaction`): **rejected** — `-32502 payer accesses un-deployed contract address 0x0000000000000000000000000000000000000006 with opcode STATICCALL`.
  Cause: the public sidecar's precompile allow-list is empty (`precompiles: []` default,
  packages/executor/src/config.ts:671), so BN254 precompiles 0x06/0x07/0x08 are treated as un-deployed contracts.
  The organizer has acknowledged this as a misconfiguration and offered a restart with a proper precompile array.

## Earlier iteration (fixed)
- First claim attempt was rejected by the sidecar with `payer uses banned opcode: GAS`: snarkjs' generated verifier
  passes `sub(gas(), 2000)` to precompile calls. Fixed by `circuits/patch-verifier.mjs` (fixed per-precompile gas
  limits), redeployed above.

## Local measurements (Foundry)
- Groth16 verifier call: 240,504 gas; full validation core: 256,288 gas; successful claim ≤ 331,884 gas.
- Circuit: 9,256 constraints (4,399 non-linear), depth-16 Poseidon tree.
## Public sidecar after precompile configuration update (6 Nov, ~11:55 UTC)

A read-only `skandha_config` call showed precompiles `0x01`–`0x11` plus `0x100`, including BN254 `0x06`–`0x08`. The existing pool still had code at `0xf409d9a52cd9b8c61a44cc8c9cdef0d85b58259c`. A fresh `npm run demo` run made deposit `0x61866dd3c2625d818097ea1ec776a0ce0552f00c8f43e5693068b7f623e8477d` at leaf 3, block 3263. The recipient/frame sender `0x1ABE36e3D122015F858e2287349ce1a50BCBA8BD` had 0 wei before claim. A proof was generated in 1,347 ms. Exact signed ethrex simulation reported success, 3/3 frames and the pool as payer; canonical submission again rejected the >100,000 validation-gas prefix. The estimator returned a frame-0 failure on its altered body, so exact-signed simulation was used as the preflight gate.

`eth_sendFrameTransaction` returned admitted hash `0x400610e5b79a02dbf8fe7e37127aa93b842a5265c2f859f5983f285af3a073ce`. `skandha_frameTransactionStatus` initially and again later reported `New`. At this writing there is **no public receipt or observed recipient payout**; do not describe this public claim as included. No retry was submitted.

Final observation for this run: `npm run demo` exited with `Receipt timed out: 0x400610e5b79a02dbf8fe7e37127aa93b842a5265c2f859f5983f285af3a073ce` after its receipt polling window. The public sidecar status remained `New`; no included claim or payout was observed.

## Public inclusion verified — 6 November, 12:35 UTC

The earlier timeout is resolved. The gateway was in manual mode with zero connected peers while the miner did not know the admitted hash. Both had the same genesis and pool code. After verifying the unchanged signed hash and a successful exact-signed simulation, the same transaction was submitted once to the documented normal miner sidecar, `https://altmempool.forshtat.com/rpc`, using `eth_sendFrameTransaction`.

- Transaction `0x400610e5b79a02dbf8fe7e37127aa93b842a5265c2f859f5983f285af3a073ce` mined in public block **3664** (`0xe50`).
- Block hash `0x1fd9a04ff85bb18710456e8e94e3242e8b875f52b0b49e7f0190151937c29171`.
- Receipt status `0x1`, all **three** frame statuses `0x1`, pool payer `0xf409d9a52cd9b8c61a44cc8c9cdef0d85b58259c`.
- Recipient `0x1ABE36e3D122015F858e2287349ce1a50BCBA8BD`: block 3663 **0 wei** → block 3664 **97,140,000,000,000,000 wei** (0.09714 devnet ETH).
- The increase equals 0.1 ETH minus the proof-bound 0.00286 ETH fee. The nullifier is spent at the receipt block.
- No new deposit/note/signer and no direct privileged-submission method were used for this retry.

This is a verified public CLI payment. The full canonical browser wallet through Anon-RPC still needs a fresh end-to-end rehearsal after the local safety fixes.

Independent read-only verification confirmed a stable receipt block on both endpoints, a spent nullifier, an exact native-transfer log from the pool to the recipient, and miner explorer **OnChain / included, 24 checks passed, no skipped checks**. Historical balance tags on this devnet can return the latest balance, so the transfer log and receipt are the payout evidence; the latest balance is informational. Actual gas used: **688,878**. [Miner explorer](https://explorer.altmempool.wtf/tx/0x400610e5b79a02dbf8fe7e37127aa93b842a5265c2f859f5983f285af3a073ce?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
