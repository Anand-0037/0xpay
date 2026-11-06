# 0xPay

0xPay is a devnet privacy wallet for fixed 0.1 ETH notes. Deposit into a Poseidon Merkle pool, then send to an address from a fresh zero-balance frame sender. A staked pool checks a Groth16 proof, sponsors the frame transaction, and pays the recipient from the note. The recipient needs no ETH or interaction. The pool needs an ETH gas float and deducts a claim fee from each note.

After setup and unlock, the browser dashboard shows public balance, locally encrypted private notes, token balances, and activity. It offers private send, payment links, and a step-by-step transaction view. Application RPC calls use the Nox Anon-RPC worker by default and stop if that route fails. The worker's bootstrap lookup and page/artifact downloads are separate network paths.

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

## Evidence and current limits

The [public devnet evidence](protocol/EVIDENCE.md) includes a funded **browser deposit → encrypted backup → fresh-profile restore → private claim → recipient payout** rehearsal on 6 November. Application calls used Nox Anon-RPC. The browser-generated claim [`0x6fd9da50ae8eda89f4a15b05b7eb9f1e0acc9248b5bb58431ec8c5f2a603f8e9`](https://explorer.altmempool.wtf/tx/0x6fd9da50ae8eda89f4a15b05b7eb9f1e0acc9248b5bb58431ec8c5f2a603f8e9?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) was included in public block **4386**: all three frames succeeded, the pool paid gas, and a previously empty recipient received **0.09614 devnet ETH**, after the reviewed **0.00386 ETH claim fee**. Canonical submission rejected the real validation prefix; the normal alternative mempool admitted and included it. [Browser receipt and screenshot](docs/evidence/public-browser-2026-11-06/) are recorded separately from local-chain tests.

This used a locally served production build and a disposable wallet, not the hosted website. The independent receipt/native-transfer check used direct public RPC as test instrumentation. The app's faucet funding was supplied by separate test automation. The first immediate reload hit a bootstrap HTTP 429. A later clean-profile load reconciled the spent note through Nox; explicit disconnect blocked private send. Hosted-release verification and mobile Safari remain separate gates.

An earlier [public CLI claim](https://explorer.altmempool.wtf/tx/0x400610e5b79a02dbf8fe7e37127aa93b842a5265c2f859f5983f285af3a073ce?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) was included in block **3664** and paid **0.09714 devnet ETH** using an older **0.00286 ETH** fee. The browser rehearsal exposed insufficient execution/state budget for a fresh recipient; exact-signed simulation verified the larger current budget before submission. These are distinct transactions and quotes.

A separate local sidecar admitted and included claim `0xaa61ab27648734771229378ca370e36c774b1c8a4cbded9cf0ecc0b3a9b42ebb` (local block 198, type 6, receipt success). Local replay, recipient tampering, wrong-root and wrong-frame controls were rejected. That CLI used direct loopback RPC, not Anon-RPC.

## Privacy and safety

The deposit amount and transaction are public. A claim's recipient and payout are public. Deposit-to-claim linkage is obscured only within the pool's anonymity set; small pools, timing, and fixed denominations still leak context. Anon-RPC hides the browser's IP from the RPC for routed calls, but the RPC still sees request contents. A payment link is a bearer secret in a URL fragment: anyone who receives it can claim the note. The link-claim payout goes to the receiver's unlocked wallet; a fresh zero-ETH key submits the frame.

Recovery words restore the funding account, but they do **not** reconstruct randomly generated private notes. The wallet can export and restore a separate encrypted note backup; its file and password must be kept safely. A real encrypted backup was restored with external HTTPS blocked in a clean browser profile, reconciled through Nox, and used for the public browser claim above. This remains unaudited devnet software and is not ready for real funds.

## CROPS

- **C:** The app has no application backend, but the hosted frontend, Anon-RPC worker/bootstrap and configured devnet sidecar/builder remain availability dependencies. Source and a local protocol CLI are available; the app stops when its private route fails.
- **O:** Authored source uses the repository's MIT license. The generated SnarkJS verifier retains its GPL-3.0 header and upstream notices. Rebuilding requires the documented circuit toolchain and dependencies.
- **P:** Routed RPC requests expose their contents to the RPC provider while reducing direct client-IP linkage. Page loads, bootstrap and proof-artifact downloads are separate paths; public deposits, recipients, amounts and timing remain visible. There are no client analytics.
- **S:** Wallet keys and notes are encrypted locally and bound to the unlocked wallet session. Trust assumptions include the development setup, unaudited contracts, worker/bootstrap and sidecar/builder; recovery words alone are not a private-note backup.

This is unaudited devnet software using a development trusted setup and draft ERC-8421 frame transactions. Do not use it with real funds. The design reuses the established fixed-note pool pattern, Poseidon and Groth16 tooling from Circom/SnarkJS, the Hegota support package, Anon-RPC's browser harness, and Kazuhiko Arase's MIT-licensed QR generator (license header preserved in `src/pay/vendor/qrcode.mjs`). AI tools assisted with planning, implementation, tests, and copy; project-specific source and design provenance must be disclosed in the hackathon submission.

The earlier RAILGUN and paper Polymarket work remains in Git history and the separate `work/polymarket-agents` branch. It is not part of this wallet build.
