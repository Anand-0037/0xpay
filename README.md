# 0xPay

A browser privacy wallet with Anon-RPC enabled by default.

RAILGUN supplies shielded balances and payments. Anon-RPC routes supported blockchain requests through an anonymizing worker. If that route fails, protected requests stop instead of switching to direct RPC. Keys are encrypted locally in the browser.

## Run

Node 24:

```sh
npm ci
npm run dev
```

Checks: `npm run lint`, `npm test`, `npm run build`.

## What works and what still needs proof

A real Sepolia shield and spendable sender balance have been observed. A complete private payment with independently confirmed recipient spendability remains unverified. Preserve the original wallet and recovery words; do not treat this prototype as a production wallet.

## Prediction-market extension

The `work/polymarket-agents` branch adds a separate Agents entry. Its target is real market data → cited researcher → skeptical review → local risk checks → user review and a labelled paper result. Wallet creation and signing stay user-controlled. Live venue access, model-driven research and end-to-end agent behavior require separate verification; the wallet is not replaced.

## Privacy boundaries

Anon-RPC reduces direct IP/query linkage at the RPC endpoint. It does not hide public transactions or positions, prove that RPC data is honest, or make authenticated venue orders anonymous. Bootstrap, worker downloads and the wallet's POI/indexer/proof services have separate network paths. Market APIs and hosted AI tools must be accounted for separately. RAILGUN funds are not automatically Polymarket collateral.

Built with React, TypeScript, ethers, the RAILGUN Wallet SDK and the Anon-RPC browser harness. Existing protocol and network implementations are reused; 0xPay supplies the interface, transport enforcement and recovery logic.

[Anon-RPC](https://ethereum.github.io/anon-rpc/wallets/) · [RAILGUN SDK](https://docs.railgun.org/developer-guide) · [Source](https://github.com/Anand-0037/0xpay)
