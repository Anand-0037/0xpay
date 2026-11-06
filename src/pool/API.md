# Pool API for PayApp

`createPoolApi(route: PrivateRpc)` returns the UI API. `App.tsx` supplies it as `<PayApp api={api} />` after Anon-RPC connects and the wallet unlocks. The route never falls back to direct RPC.

- `getPublicBalance(address: Hex): Promise<bigint>` reads ETH wei.
- `getPrivateBalance(): Promise<bigint>` reconciles encrypted notes with Deposit logs and `nullifierSpent`, then sums unspent notes at 0.1 ETH each.
- `listNotes(): Promise<StoredNote[]>` gives `{ note, status, txHash? }` with statuses `pending-deposit | unspent | spending | spent`. Keep the `note` object off network and out of logs.
- `depositNotes(count: number, onStep?): Promise<StoredNote[]>` writes the encrypted note before broadcast. It accepts 1–20 notes.
- `privateSend({ to, notes, onStep }): Promise<{txHash, blockNumber}[]>` claims each stored unspent note to `to`. `onStep` receives `ClaimStep`, including proof, canonical response, alt admission and inclusion. The proof and submission are routed through Anon-RPC. Treat `onStep` values as real RPC evidence only.
- `createPaymentLink(note): string` puts the bearer secret in the URL fragment.
- `claimLink(link, onStep)` claims a link into a fresh throwaway key. The recipient key is not persisted; for a usable receiver wallet, supply a recipient key through an updated API or use `privateSend` to a saved address. This is an open integration issue.
- `tokenPortfolio(address)` reads configured token addresses through Anon-RPC. Devnet defaults use the published predeploy addresses in sidecar `deploy/devnet/devnet-readme.md`; `VITE_USDC_ADDRESS`, `VITE_USDT_ADDRESS`, `VITE_WETH_ADDRESS`, and `VITE_LINK_ADDRESS` override them. On local chain 9, unset addresses are omitted.
- `activity()` returns note status and transaction hashes from stored notes after reconciliation.

`?chain=local` selects the local ethrex and sidecar URLs, configurable via `VITE_LOCAL_RPC_URL`, `VITE_LOCAL_MEMPOOL_URL`, and `VITE_LOCAL_CHAIN_ID`. The Nox/Nym worker remains the only RPC transport. The current Links client config is generated from `src/pool/deployments.devnet.json` and should be updated after a devnet reset.
