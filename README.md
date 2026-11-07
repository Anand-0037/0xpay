# 0xPay

**Pay from a private note. Route your wallet queries through Anon-RPC.**

0xPay is a devnet wallet for paying someone without making a direct onchain transfer from your funding address to their address. You deposit a fixed 0.1 test ETH note, then your browser proves it can spend a note from the pool. A fresh account with zero ETH submits the claim; the pool covers gas and sends the payout.

Supported blockchain requests use Anon-RPC’s Nox worker by default. If that route fails, those requests stop. The RPC still sees what is queried, and the deposit, recipient, payout amount and timing remain public. A small pool and close timing can make the deposit and payout easier to correlate.

[Open the wallet](https://0xpay.fun/) · [See an included payment](https://explorer.altmempool.wtf/tx/0x6d24a75bc4c788c618f918b80131d8259ce32e05790e4ee6b639eddb3c807f76?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) · [Detailed evidence](protocol/EVIDENCE.md)

## Try 0xPay

**Inspect privately, no wallet needed:** Open **Private lookup** and check a devnet address or transaction through Nox. The onchain data remains public. If the route disconnects or fails, new supported reads stop rather than using direct RPC.

**Make a devnet payment:** Create a disposable wallet and use **Get 1 devnet ETH from faucet** under **Add to private balance** if needed. Deposit one fixed **0.1 ETH** note and export its **encrypted note backup**. In a clean browser, restore the wallet words **and** import that backup; wallet words alone do not restore notes. Review the recipient, fee and payout, submit once, then wait for inclusion and check the recipient balance. Reload to confirm the note remains spent. If submission is uncertain, check the existing transaction before retrying.

## How it works

1. Deposit 0.1 devnet ETH into the pool. The deposit is public. The browser stores the resulting note encrypted; recovery words alone cannot restore notes, so export a separate encrypted note backup.
2. Send a note to a recipient. The browser creates a Groth16 proof that binds the pool root, note nullifier, recipient and fee. A fresh zero-ETH key submits the frame transaction. The staked pool verifies the proof, pays gas and pays the recipient.
3. Inspect an address or transaction without creating a wallet. **Private lookup** sends supported devnet RPC reads through Anon-RPC and stops when that route fails. It does not provide full address history.

The claim needs the alternative mempool: its proof validation exceeds the canonical 100,000-gas prefix limit, and the payer reads its own storage. The app submits through the normal sidecar path, not a privileged builder endpoint. The wallet uses the [Anon-RPC browser harness](https://ethereum.github.io/anon-rpc/wallets/) with Nox by default. Nym supports standard lookups on this devnet; the current sidecar requires Nox for payment. No direct RPC fallback is used for supported app reads.

```text
Browser: encrypted note + local proof
  → Anon-RPC worker → devnet RPC / normal sidecar
  → frame: fresh sender → pool verifies and sponsors → pool pays recipient
```

## Evidence

The earlier hosted browser run completed the deposit → encrypted backup → clean-profile restore → payment journey. A fresh run on 7 November used an existing funded note and completed a new payment through Nox. Its claim was **included in block 12396**; the app reported **0.09614 devnet ETH** at the recipient and **0 unspent notes** afterward. This fresh run did not repeat deposit or restore, and a later standalone lookup failed with `NoTunnelExitError`; the app then blocked further reads.

| Checkpoint | Observed evidence |
| --- | --- |
| Deposit | Earlier hosted run deposited one 0.1 devnet ETH note. |
| Restored note | Earlier run restored the separate encrypted backup in a fresh browser profile. |
| Claim included | Fresh claim `0x6d24a75b…807f76`, block 12396; miner explorer status **On chain**. |
| Recipient paid | Fresh run: 0.09614 devnet ETH after the reviewed 0.00386 ETH claim fee. |
| Note spent | Fresh run showed 0 unspent notes; earlier run also verified this after reload. |

The ordinary mempool rejected the fresh claim’s validation prefix; the normal alternative sidecar admitted it. The explorer showed the miner had included it while the gateway had not seen it. [Transaction evidence and limits](protocol/EVIDENCE.md) contains the earlier complete recovery run.

[Hosted payment screen](media/hosted-payment-2026-11-06.png) — the actual browser review, canonical rejection, alternative admission, inclusion and recipient balance. This screenshot is from the earlier payment in block 6078; the linked evidence file records that run.

[Private lookup screen](media/private-lookup-2026-11-07.png) — a wallet-free read of the deployed pool address through Nox at devnet block 8169. This shows the app result, not proof that every network request is anonymous.

Nox connection can time out; one fresh reload needed a second attempt. This run does not prove every browser or worker can complete the flow. The devnet can reset and erase explorer history. A receipt shows inclusion, not chain finality.

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

This is **unaudited devnet software** using a development trusted setup and draft ERC-8421. Do not use real funds. The design borrows the fixed-note pool pattern and uses Circom/SnarkJS, Poseidon, the Hegota support package and Anon-RPC; it does not claim to invent a new privacy primitive. OpenAI Codex and Claude assisted with the circuit and contract (`protocol/circuits/withdraw.circom`, `protocol/contracts/src/OxPayPool.sol`), wallet and recovery code (`src/pay/`, `src/pool/note-backup.ts`), tests (`tests/`) and drafts. Anand chose the product and privacy trade-offs and reviewed real devnet results.

## CROPS

- **Censorship resistance:** The hosted domain, selected worker, sidecar and builder remain dependencies. If the private route fails, the app stops chain reads and payments; users can build the open client, but cannot force a sidecar to include a payment.
- **Open source:** Authored code is MIT licensed; the generated SnarkJS verifier retains its upstream GPL-3.0 notice. The repo includes build instructions and protocol source; running a payment still needs a compatible devnet.
- **Privacy:** For routed calls, the RPC sees query contents without the browser's direct IP. Bootstrap and page hosts receive separate requests; the public chain exposes the deposit, payout, recipient, amount and timing. No client analytics or trackers are installed.
- **Security:** Funding keys and notes stay encrypted in browser storage, with a separate encrypted note backup. The frontend, contracts and development trusted setup are unaudited; users must trust the code they load.
