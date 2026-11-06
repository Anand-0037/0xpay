# Evidence (real runs, public devnet chain 1337)

All values below were produced by commands run on 6 Nov 2026 (UTC ~11:00–11:30). Explorer: https://explorer.altmempool.wtf/ (search the hash).

## Pool deployment (`npm run deploy`, client/)
- Poseidon2 `0x3c913baa92e0bab4b6a56782f305dc62414298b0` (tx `0xba90b38c32b4bdddde51597b74fd8faebb6aafe8edb9057bdf40c342fd96bcbb`)
- Groth16Verifier `0xd2059624c0b6718e187b93ee715e0e9163e5777f` (tx `0xc25b7859294f47add6812b07ec34e56e5e52904f3cf3d5b6bd28d23ccfdc0a2a`)
- OxPayPool `0xf409d9a52cd9b8c61a44cc8c9cdef0d85b58259c` (tx `0xe1503d57c2f73c81f826013f9acda02f7ec7bd1b576eb0fd8865e3622a6e39d6`)
- Staked from its own constructor: registry `getDepositInfo` stake = `12000000000000000` wei (0.012 ETH).

## Deposit
- Deposit tx `0xa91cf7f2696319a5f457eefbda0e7865e2976b26f733a61d59388fd51563b1d1`, leaf 0, block 2946.

## Claim from a fresh 0-ETH key (`npm run demo`)
- Receiver `0xA53574196408eb677E33F69aEe2C0691e69aD69f`, balance before: 0 wei. Pool had 2 deposits.
- Groth16 proof generated in 1,354 ms (Node, snarkjs).
- `ethrex_simulateFrameTransaction` on the exact signed claim: `executionStatus: success`, 3/3 frames succeeded,
  `payer` = OxPayPool, `prefixShape: OnlyVerifyPay`, gasUsed `0xa6796` (681,878), maxCost `0x83bc9dd3e5400`,
  `canonicalMempoolValid: false`, violation `prefix gas budget exceeded: 632800 > 100000 (MAX_VERIFY_GAS)`.
- Canonical mempool (`eth_sendRawTransaction`): **rejected** — `-32000 Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`.
- Public alt-mempool sidecar (`eth_sendFrameTransaction`): **rejected** — `-32502 payer accesses un-deployed contract address 0x0000000000000000000000000000000000000006 with opcode STATICCALL`.
  Cause: the public sidecar's precompile allow-list is empty (`precompiles: []` default,
  packages/executor/src/config.ts:671), so BN254 precompiles 0x06/0x07/0x08 are treated as un-deployed contracts.
  The organizer has acknowledged this as a misconfiguration and offered a restart with a proper precompile array.

## Earlier iteration (fixed)
- First claim attempt was rejected by the sidecar with `payer uses banned opcode: GAS`: snarkjs' generated verifier
  passes `sub(gas(), 2000)` to precompile calls. Fixed by `circuits/patch-verifier.mjs` (fixed per-precompile gas
  limits), redeployed above.

## Local measurements (Foundry)
- Groth16 verifier call: 240,504 gas; full validation core: 256,288 gas; successful claim ≤ 331,884 gas.
- Circuit: 9,256 constraints (4,399 non-linear), depth-16 Poseidon tree.
