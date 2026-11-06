# 0xPay

[Open the wallet](https://0xpay.fun/) · [Transaction evidence](protocol/EVIDENCE.md)

0xPay is a privacy wallet on the alt-mempool devnet. It combines two protections: a fixed-note pool for payments and Anon-RPC for blockchain requests. A recipient can receive a payout at a fresh address with **zero ETH**; the pool pays the transaction fee.

## The problem

A normal wallet asks an RPC provider about addresses and transactions from the user's network connection. The provider can associate those requests with an IP address. A normal transfer also exposes the sender and requires the recipient to have gas for a later move. 0xPay reduces the first link for routed requests and uses a proof-backed pool to change the payment path. It does **not** hide every part of a transaction or make the user anonymous to every service.

## What the app does

1. Deposit 0.1 devnet ETH into the pool. The deposit is public. The browser stores the resulting note encrypted; recovery words alone cannot restore notes, so export a separate encrypted note backup.
2. Send a note to a recipient. The browser creates a Groth16 proof that binds the pool root, note nullifier, recipient and fee. A fresh zero-ETH key submits the frame transaction. The staked pool verifies the proof, pays gas and pays the recipient.
3. Inspect an address or transaction without creating a wallet. **Private lookup** sends supported devnet RPC reads through Anon-RPC and stops when that route fails. It does not provide full address history.

The claim needs the alternative mempool: its proof validation exceeds the canonical 100,000-gas prefix limit, and the payer reads its own storage. The app submits through the normal sidecar path, not a privileged builder endpoint. The wallet uses the [Anon-RPC browser harness](https://ethereum.github.io/anon-rpc/wallets/) with Nox by default and Nym as another worker. No direct RPC fallback is used for supported app reads.

```text
Browser: encrypted note + local proof
  → Anon-RPC worker → devnet RPC / normal sidecar
  → frame: fresh sender → pool verifies and sponsors → pool pays recipient
```

## Evidence

A locally served production build completed a real browser deposit, encrypted backup, fresh-profile restore and claim through Nox. [Claim 0x6fd9…f8e9](https://explorer.altmempool.wtf/tx/0x6fd9da50ae8eda89f4a15b05b7eb9f1e0acc9248b5bb58431ec8c5f2a603f8e9?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) was included in devnet block 4386. All three frames succeeded; the pool paid gas and a previously empty recipient received **0.09614 devnet ETH** after a **0.00386 ETH** claim fee. The canonical submission rejected the validation prefix; the normal alternative mempool admitted the claim. [Full reproducible evidence and limits](protocol/EVIDENCE.md).

That rehearsal does not prove that every hosted browser, worker or mobile device can complete the same flow. The devnet can reset and erase explorer history. A receipt shows inclusion, not chain finality.

## Run and inspect

Use Node 24 and the lockfile:

```sh
npm ci --ignore-scripts
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
```

The wallet lives in `src/`; the circuit, contract, client and deployment scripts are in `protocol/`. The app targets devnet chain 1337. The [protocol evidence](protocol/EVIDENCE.md) records deployment, negative controls, transactions and testing limits.

## Privacy and safety

The RPC endpoint sees the **contents** of routed requests but not the browser's direct IP for those calls. Worker bootstrap, page delivery and proof-artifact downloads use separate paths. The deposit, pool payout, recipient, amount and timing remain public. Linkage depends on the pool's actual anonymity set; a small pool and close timing weaken it.

A payment link carries a bearer note secret. **The creator still holds the same note and can claim it first**; making a link is not a completed payment. After importing a link into encrypted storage, the app removes the secret from the address bar. Keep links and backups private.

This is **unaudited devnet software** using a development trusted setup and draft ERC-8421. Do not use real funds. The design borrows the fixed-note pool pattern and uses Circom/SnarkJS, Poseidon, the Hegota support package and Anon-RPC; it does not claim to invent a new privacy primitive. AI tools assisted with design, implementation and tests.

## CROPS

- **Censorship resistance:** Open-source client and protocol; the hosted app, worker, sidecar and builder remain availability dependencies.
- **Open source:** MIT-licensed authored code; the generated SnarkJS verifier retains its upstream GPL-3.0 notice.
- **Privacy:** Routed RPC calls reduce direct IP linkage. The public chain and other network paths expose the limits above.
- **Security:** Keys and notes stay encrypted in the browser vault. The contracts, development setup and frontend are unaudited.
