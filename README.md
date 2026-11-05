# 0xPay

0xPay is an in-progress browser wallet for private payments on Ethereum Sepolia. RAILGUN is the intended on-chain privacy layer. The implemented app currently has an Anon-RPC Nym read path and a wallet overview with unavailable balances; wallet setup, shielding and sending are not implemented yet.

## Run locally

```sh
npm ci
npm run dev
```

Check the build with `npm run build` and lint with `npm run lint`.

The Anon-RPC worker's specifier is resolved through a limited direct bootstrap read on Ethereum mainnet. The app's Sepolia `eth_chainId` and `eth_blockNumber` requests use `worker.fetch`. The public Nym worker and RPC endpoint can be unavailable. A successful read does not prove that every wallet or SDK network path is private.

This repository must never contain wallet keys or recovery phrases. Use testnet funds only.
