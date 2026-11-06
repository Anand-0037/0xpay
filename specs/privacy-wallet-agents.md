# Wallet and market-workspace decisions

This is a sanitized design record. Private chat history, credentials and working notes are excluded.

## Human direction

- Keep the existing RAILGUN wallet, encrypted local recovery and user-controlled signing.
- Make Anon-RPC the default for supported app and SDK blockchain reads. Stop those reads on route failure.
- Demonstrate a useful prediction-market application separately from the wallet. Do not pretend shielded balances are venue trading collateral.
- Use 0G for actual model inference. Do not replace unavailable inference with local rules labelled as AI.
- Keep wallet addresses, holdings, keys and user risk limits out of inference payloads.
- Research and skepticism produce proposals; local policy enforces hypothetical limits. Real-money execution remains a user's separate action.

## Implemented boundaries

Wallet runs on Sepolia. The market workspace reads Polygon chain 137 through the chosen Nox or Nym worker. Worker bootstrap is limited to pinned specifier lookups; public market APIs and the research service are separately accounted connections.

Retrieved venue rules and quotes form the public evidence pack. The researcher returns citations and a nullable estimate; the skeptic can abstain. Only an explicitly adopted, matching, unexpired result can drive a model-based paper proposal. Model text cannot change stake, budget, expiry, price or spread limits.

Paper execution rechecks quote freshness, liquidity, budget, duplicate state, evidence expiry and the live route while holding the journal lock. A broken or unreadable journal stops execution. No paper record is a venue fill or profit claim.

## Signed application policy

The user requested a verifiable, revocable mandate instead of editable limits alone. A browser EOA reviews and signs an EIP-712 paper policy binding the agent, assessed account, market list, session/nonce, budget, order cap, worst price, spread, exposure and expiry. The agent receives no signer. The journal rechecks that signature and committed spend under its shared lock before saving; local revocation uses the same lock and stops queued work. New records retain the verified policy digest; earlier simulations are not retroactively signed.

This is offchain application enforcement, not a token allowance, smart-account session key or venue order permission. ENS record matching is an isolated read adapter; ownership, names and live application wiring remain separate gates. Any future public name/hash binding must not be mistaken for private identity or automatic revocation.

## Evidence gates

1. Observe real market data and exact onchain outcome/collateral mapping.
2. Observe account reads through the worker and no direct-RPC fallback after interruption.
3. With authorized credits, record actual 0G request IDs for both roles and inspect the exact public-only payload.
4. Verify a paper result and reload recovery separately from a real trade.
5. For the wallet, independently verify recipient spendability before claiming an end-to-end private payment.

AI assistance was used for implementation, reviews and tests. The choices above came from the user's project guidance. The final submission should identify the user's actual design, testing and explanatory contributions accurately; this record is not a claim of independently completed human testing.
