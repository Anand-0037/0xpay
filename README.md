# 0xPay

0xPay is a devnet privacy wallet for fixed 0.1 ETH notes. Deposit into a Poseidon Merkle pool, then send to an address from a fresh zero-balance frame sender. A staked pool checks a Groth16 proof, sponsors the frame transaction, and pays the recipient from the note. The recipient needs no ETH or interaction. The pool needs an ETH gas float and deducts a claim fee from each note.

The browser opens on a dashboard with public balance, locally encrypted private notes, token balances, and activity. It offers private send, payment links, and a step-by-step transaction view. Application RPC calls use the Nox Anon-RPC worker by default and stop if that route fails. The worker's bootstrap lookup and page/artifact downloads are separate network paths.

```text
Browser: encrypted notes + local proof
  → Anon-RPC worker → devnet RPC / normal sidecar → builder

Frame 0: verify fresh sender
Frame 1: pool verifies proof and approves gas payment
Frame 2: pool pays recipient and marks the note spent
```

## Run the wallet

Use Node 24 and the checked-in lockfile:

```sh
npm ci --ignore-scripts
npm run dev
```

Checks: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. The current browser target is the public alt-mempool devnet, chain 1337. `?chain=local` is intentionally ignored because Nox requires a reachable HTTPS endpoint and cannot tunnel to a local HTTP sidecar. Local integration is exercised through the CLI in `protocol/`.

## Protocol source

- `protocol/circuits/`: Circom withdrawal circuit, local development setup, proof tests, and the verifier patch that replaces banned dynamic `GAS` calls with fixed precompile limits.
- `protocol/contracts/`: `OxPayPool`, Groth16 verifier, Foundry tests, and deployable artifacts.
- `protocol/client/` and `protocol/scripts/`: frame transaction builder, preflight, deployment, demo, and negative-control scripts.
- `public/circuits/`: browser proving artifacts. Do not use these keys for real funds.

For a protocol rebuild, install each subpackage with `npm ci --ignore-scripts`, run `protocol/circuits/build.sh`, then `npm run build` and `forge test -vv --gas-report` in `protocol/contracts`, and `npm run typecheck`/`npm test` in `protocol/client`. The circuit build needs its documented Circom/SnarkJS toolchain. The deployment script writes a new throwaway key under `protocol/deployments/.deployer-key`; keep it private and never commit it.

## Evidence and current limit

The [public devnet evidence](protocol/EVIDENCE.md) records a real included claim: `0x400610e5b79a02dbf8fe7e37127aa93b842a5265c2f859f5983f285af3a073ce`, block **3664**. All three frames succeeded, the pool paid gas, and a fresh recipient received **0.09714 devnet ETH** from a zero balance. The same signed claim was rejected by canonical prefix-gas rules and admitted by normal alternative-mempool submission. The earlier gateway timeout was resolved by submitting the identical transaction to the documented miner sidecar after verifying its hash and simulation.

[Open the included claim and its 24 passing admission checks](https://explorer.altmempool.wtf/tx/0x400610e5b79a02dbf8fe7e37127aa93b842a5265c2f859f5983f285af3a073ce?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).

A separate local sidecar configured with BN254 precompiles admitted and included claim `0xaa61ab27648734771229378ca370e36c774b1c8a4cbded9cf0ecc0b3a9b42ebb` (local block 198, type 6, receipt status success). Replay, recipient tampering, wrong root, and wrong second frame were rejected in local negative controls. This local CLI used direct loopback RPC, not Anon-RPC. The browser route was separately observed reaching public devnet chain 1337 through Nox; an end-to-end browser deposit and claim remains unverified.

## Privacy and safety

The deposit amount and transaction are public. A claim's recipient and payout are public. Deposit-to-claim linkage is obscured only within the pool's anonymity set; small pools, timing, and fixed denominations still leak context. Anon-RPC hides the browser's IP from the RPC for routed calls, but the RPC still sees request contents. A payment link is a bearer secret in a URL fragment: anyone who receives it can claim the note. The link-claim payout goes to the receiver's unlocked wallet; a fresh zero-ETH key submits the frame.

Recovery words restore the funding account, but they do **not** reconstruct randomly generated private notes. The wallet can export and restore a separate encrypted note backup; its file and password must be kept safely. The backup flow is covered by local tests but has not yet been verified in a fresh browser, so this devnet build is not ready for real funds.

## CROPS

- **C:** The app has no application backend, but the hosted frontend, Anon-RPC worker/bootstrap and configured devnet sidecar/builder remain availability dependencies. Source and a local protocol CLI are available; the app stops when its private route fails.
- **O:** Authored source uses the repository's MIT license. The generated SnarkJS verifier retains its GPL-3.0 header and upstream notices. Rebuilding requires the documented circuit toolchain and dependencies.
- **P:** Routed RPC requests expose their contents to the RPC provider while reducing direct client-IP linkage. Page loads, bootstrap and proof-artifact downloads are separate paths; public deposits, recipients, amounts and timing remain visible. There are no client analytics.
- **S:** Wallet keys and notes are encrypted locally and bound to the unlocked wallet session. Trust assumptions include the development setup, unaudited contracts, worker/bootstrap and sidecar/builder; recovery words alone are not a private-note backup.

This is unaudited devnet software using a development trusted setup and draft ERC-8421 frame transactions. Do not use it with real funds. The design reuses the established fixed-note pool pattern, Poseidon and Groth16 tooling from Circom/SnarkJS, the Hegota support package, Anon-RPC's browser harness, and Kazuhiko Arase's MIT-licensed QR generator (license header preserved in `src/pay/vendor/qrcode.mjs`). AI tools assisted with planning, implementation, tests, and copy; project-specific source and design provenance must be disclosed in the hackathon submission.

The earlier RAILGUN and paper Polymarket work remains in Git history and the separate `work/polymarket-agents` branch. It is not part of this wallet build.
