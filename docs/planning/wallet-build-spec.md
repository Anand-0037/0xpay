# Consolidated wallet build specification

Prepared from the owner's accepted directions and the working specification on 6 November 2026. This is a current planning record, not proof that the idea or source started during the event. Historical alternatives (RAILGUN, market research, AI APIs and the separate two-frame local lab) are not the release product.

## Product requirements

- One browser privacy wallet with the familiar scrolling cream/orange frontend and restrained, reduced-motion-aware animation.
- Dashboard: public balance, locally encrypted private notes, configured tokens and activity. Represent unavailable reads explicitly; never substitute invented balances.
- Deposit: create a fixed 0.1 ETH note, keep its secrets encrypted on-device, review the public deposit and signed maximum fee, and preserve any prepared hash before broadcast.
- Private send: choose note count and recipient; review public/private information, claim fee and exact net payout. Recipient starts with zero ETH and needs no interaction.
- Generate proofs locally. Show actual canonical rejection, normal alternative-mempool admission, receipt inclusion and observed recipient balance. Admission alone is not success.
- Application RPC uses the selected Anon-RPC worker by default. Route failure blocks reads and payments; reconnect is explicit. Bootstrap and page/artifact downloads are separate disclosed paths.
- Recovery words restore the funding key. Private notes require a separate encrypted backup. Test clean-profile offline restoration and preserve spent/pending transaction state across interruption.
- Payment links are a secondary bearer-secret path. Do not make an unverified link-receiver journey part of the main demo.

## Implementation decisions

Depth-16 Poseidon Merkle tree; Groth16 membership proof bound to nullifier, recipient, fee, chain and pool. The staked pool verifies the exact following claim call before approving gas. Three frames verify the fresh sender, verify proof/payment, and execute payout. Exact-signed simulation gates normal `eth_sendFrameTransaction` submission. No privileged builder submission. Receipt verification checks all frames, pool payer, matching Claim event, native ETH transfer and spent nullifier; unreliable historical state tags do not establish payout.

For fresh recipient creation, simulation exposed insufficient execution/state gas. The current signed claim budget and fee are shared with the review quote: 0.00386 test ETH fee on one 0.1 ETH note, leaving 0.09614. Do not rewrite the earlier CLI receipt that used a different fee.

## Release acceptance

Pass typecheck, meaningful payment/recovery tests, lint with zero errors and production build. Rehearse public-devnet browser deposit → encrypted backup → clean-profile restore → private claim → payout. Verify spent state after reload and explicit disconnect. Publish the same implementation, proving artifacts, evidence and privacy limits on GitHub and the hosted demo. Verify the hosted result separately. Prepare a human-narrated 2–3 minute demo and accurate submission; resolve prior-work eligibility before the final attestation.

## Privacy and trust boundaries

Development setup and unaudited experimental devnet only. Public deposits, recipients, amounts and timing remain visible. Small anonymity sets limit unlinkability. No tracker integration. Local storage can fail or be cleared; recovery words alone do not recover random notes. The pool needs an ETH float; workers, bootstrap, sidecar/builder and frontend hosting remain dependencies. A transport counter is not proof of anonymity or settlement.
