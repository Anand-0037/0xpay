# Evidence (real runs, public devnet chain 1337)

Values below were produced on 6 Nov 2026; each later section records the updated result. Explorer: https://explorer.altmempool.wtf/ (search the hash).

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

## Public browser deposit, backup recovery and included claim — 13:27–13:47 UTC

A disposable browser wallet deposited a real 0.1 devnet ETH note through Nox Anon-RPC. The UI exported an encrypted note backup. A clean browser profile imported the same funding account and restored the backup while external HTTPS requests were blocked. After an explicit Nox reconnect, the restored note was confirmed unspent. No wallet mnemonic, private key, backup password or note secret is included in these evidence files.

The initial claim simulation failed before submission because the fresh-recipient execution/state budget was insufficient. Exact-signed simulation compared budgets without broadcasting: raising execution gas alone failed; raising both execution and state budgets succeeded. The final browser review showed a 0.00386 ETH claim fee and 0.09614 ETH recipient amount.

- Browser claim: `0x6fd9da50ae8eda89f4a15b05b7eb9f1e0acc9248b5bb58431ec8c5f2a603f8e9`.
- Public block **4386**, block hash `0x64e17b8b30628096678de8a304ac74717b032548838f69952a62a59d45cd0a03`.
- All three frame receipts succeeded; payer is pool `0xf409d9a52cd9b8c61a44cc8c9cdef0d85b58259c`.
- Recipient `0x7e7df472ce15a4d847b20d085e89b708c9f4133d` was empty before submission and received exactly **96,140,000,000,000,000 wei**. The protocol native-transfer log and pool Claim event agree with the reviewed recipient and fee.
- The browser generated the proof in about **0.8 seconds**, received a real canonical MAX_VERIFY_GAS rejection, and submitted normally through `eth_sendFrameTransaction`.
- The completed note was saved as **spent** with this exact claim hash in encrypted browser storage. The first immediate reload hit bootstrap HTTP 429. A later clean-profile load reconciled zero unspent notes through Nox; explicit disconnect disabled private send, with no second claim. This receipt does not establish finality.

[Open browser claim](https://explorer.altmempool.wtf/tx/0x6fd9da50ae8eda89f4a15b05b7eb9f1e0acc9248b5bb58431ec8c5f2a603f8e9?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc). This rehearsal used a locally served production build, public synthetic ETH, and external test funding; it is not evidence that the hosted release or iPhone Safari works. Independent read-only receipt checks were direct test instrumentation, separate from the application's worker transport.

## Hosted browser payment — 16:26–16:40 UTC, 6 November

The public `https://0xpay.fun/` release at Git commit `920a2c2` completed the same payment journey through the **Nox Anon-RPC worker** using disposable devnet funds. This run used an isolated browser profile and generated test keys; no user wallet or real funds were involved. The public funding wallet `0x78965E10E21F25201ac7Fb416Ae7Ca22b9A12dEc` deposited a 0.1 ETH note, exported its encrypted note backup, and was restored with the same recovery words plus that backup in a second fresh browser profile. The second profile showed **1 unspent note** before payment. Secrets, passwords and the backup file stayed outside the repository.

- Deposit: [`0xd805b865…ac0dea`](https://explorer.altmempool.wtf/tx/0xd805b865ee538326f9030581b1076188a8c1711f84db24180d672c8d92ac0dea?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc), block **6022**. A pool deposit event came from that funding wallet.
- The payment review showed **0.1 ETH** before fee, **0.00386 ETH** claim fee, **0.09614 ETH** recipient payout, and the pool as gas payer. One click generated the proof in about **2.1 seconds**. Canonical `eth_sendRawTransaction` rejected the frame prefix as above `MAX_VERIFY_GAS`; normal `eth_sendFrameTransaction` admitted it.
- Claim: [`0x0aace393…251d72`](https://explorer.altmempool.wtf/tx/0x0aace393ed7d593fc01707901cfe2f09cbce59befead4db802816b7bd3251d72?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc), status **0x1**, type **0x6**, all three frame receipts **0x1**, block **6078**, block hash `0x6cc11e126d767ff2a944bf9522cb34186f7ee8a00479d3f629c1255e31ec0fdd`.
- The recipient `0xEB2CCE310F32113Ad397eBaA76Aba066731b1CB5` had **0 wei** before payment and **96,140,000,000,000,000 wei** after. The receipt's native-transfer log names the pool as sender, this exact recipient, and this exact amount; the pool also emitted a Claim event. Independent chain reads were test instrumentation, separate from the app's routed requests.
- Reloading the restored hosted wallet reconciled **0 unspent notes**. The first fresh Nox reload timed out; a second connection succeeded. This shows a real reliability limitation, not guaranteed availability. Inclusion is not finality, and the devnet may reset.

## Hosted Nym private lookup — 17:00 UTC, 6 November

On the deployed `e03f5a7` release, a fresh isolated browser connected through Nym and looked up the public pool address without a wallet. The result showed balance **0.605679732 ETH** and nonce **8** at block **6317**. The connection panel recorded **6/6 RPC reads through the worker**, zero failures and **2 direct bootstrap reads**. After an explicit disconnect, the old result cleared, the lookup control disabled and the worker-read counter stayed at 6/6. This checks the app's fail-closed route behavior for that flow; it does not prove all browser traffic anonymous. Page delivery, CDN and Nym service hosts were separate requests. Nym currently supports standard lookups here; payments require Nox because the sidecar rejects Nym-exit POSTs with HTTP 415.
