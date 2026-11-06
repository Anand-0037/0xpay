# Public browser rehearsal · 6 November 2026

These files record a real public-devnet test, using synthetic ETH and a disposable wallet. No note secret, recovery phrase, private key or password is included.

1. A browser created and funded a fixed 0.1 ETH note through Nox Anon-RPC.
2. The UI exported an encrypted backup. A clean profile imported the funding account and restored the note with external HTTPS blocked. `recovery.json` records this and an initial simulation failure before broadcast.
3. After correcting the fresh-recipient gas/state budget, the same recovered note paid 0.09614 ETH in public block 4386. `payment.json` contains the real receipt. `browser-payment.png` shows the actual completed browser UI.
4. The first immediate reload hit the bootstrap provider's HTTP 429 limit; its error is retained in `payment.json`. A later fresh-profile load reconciled zero unspent notes through Nox and explicit disconnect disabled private send. See `reload-reconnect.json` and `spent-after-reconnect.png`. No second claim was submitted.

The app was served from a pinned local production build. This does not verify the deployed website or mobile Safari. Funding and independent receipt checks used separate test instrumentation. Counters establish observed routing, not end-to-end anonymity. The recipient, amount and timing are public; the pool has a small devnet anonymity set.

Browser claim: [0x6fd9da50…03f8e9](https://explorer.altmempool.wtf/tx/0x6fd9da50ae8eda89f4a15b05b7eb9f1e0acc9248b5bb58431ec8c5f2a603f8e9?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
