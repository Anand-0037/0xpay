# Provenance and AI assistance

## Starting point and participation track

The project owner reports that some 0xPay wallet code, branding or design existed before hackathon kickoff. The owner confirmed on 6 November that the Hacker Dashboard is set to **Classic / From Scratch**. This document does not assert eligibility. ETHGlobal's [Mumbai rules](https://ethglobal.com/events/mumbai/info/details) exclude prior project-specific code, designs and assets from Classic; an organizer ruling or approved track change is outstanding. Do not describe the entire wallet as created from scratch during the event.

The release branch starts from `559d93754e4508e270d1093fe114e0cc30ebd967`, whose product used RAILGUN and an earlier wallet frontend. The repository preserves that history and the separate market-exploration branch. Commit timestamps alone do not establish when source was first written. The old project-specific wallet, design and assets must be distinguished from public libraries and boilerplate when discussing eligibility.

## What changed in the pool-wallet release

The new release replaces the RAILGUN path with a fixed-denomination Poseidon/Groth16 pool and a three-frame alternative-mempool claim. It adds pool-sponsored gas, recipient-bound proofs, encrypted note backup/restore, exact prepared-transaction recovery, fail-closed Anon-RPC application transport and the browser payment UI. The [public-browser evidence](evidence/public-browser-2026-11-06/) distinguishes the funded public payment from earlier CLI and owned-local-chain tests. The independent `work/frame-claims` local lab was not merged wholesale into this release.

This is an integration of established fixed-note pool designs and open-source proof tooling; it is not a newly invented privacy primitive. See the README for license boundaries and upstream notices.

## AI assistance

Codex and Claude assisted with architecture, code, tests, browser automation, debugging, documentation and submission drafts. Assisted areas include `src/pool/`, `src/wallet/`, `src/rpc.ts`, `src/rpc/`, `src/net/`, `src/pay/`, `src/dashboard/`, `src/ui/`, `protocol/`, `tests/`, build/CI configuration and the README/evidence prose. Generated proving/verifier artifacts derive from the documented Circom/SnarkJS toolchain. Vendored dependencies and QR code source retain their upstream attribution.

The owner's recorded directions selected a single privacy wallet, the alternative-mempool payment path, Anon-RPC, encrypted local recovery, the scrolling cream/orange interface and Ethereum Foundation as the main sponsor target. AI agents performed much of the implementation and verification. The team must describe its own contributions accurately and be able to explain the design, code and trade-offs; this document does not establish compliance with the event's meaningful-human-contribution requirement.

The [planning record](planning/wallet-build-spec.md) consolidates the accepted product requirements and implementation decisions. It is not an original timestamped prompt transcript. Raw local sessions can contain recovery material and credentials and are not included in this public repository. Any additional required prompts or specs must be reviewed and sanitized before disclosure; this planning record is not a claim that all submission artifacts are complete.
