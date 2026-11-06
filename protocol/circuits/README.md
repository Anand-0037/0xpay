# Withdrawal circuit

**DEV ONLY.** `build.sh` makes a local Powers of Tau and Groth16 setup with one contribution and fixed development entropy. The proving key is unsuitable for production.

`withdraw.circom` has a depth-16 Poseidon Merkle path. Its six public signals are ordered `root, nullifierHash, recipient, fee, chainId, pool`. The zero leaf is `Poseidon(0, 0)`; each upper zero is `Poseidon(zero, zero)`. `pathIndices[i] = 0` means the current node is left. Inputs are BN254 field elements; notes should use 31-byte random values.

Run `npm install --ignore-scripts`, `./build.sh`, then `npm test`. The build exports `build/withdraw.wasm`, `build/withdraw_final.zkey`, `build/verification_key.json`, and `../contracts/src/Groth16Verifier.sol`. The test generates a random note, builds a one-leaf tree, proves, and verifies it with snarkjs. `test/prove.mjs` uses fixed notes by default so Foundry can reproduce a proof fixture for a freshly deployed pool.

When flattening a snarkjs proof for `OxPayPool.claim`, use `[pi_a[0], pi_a[1], pi_b[0][1], pi_b[0][0], pi_b[1][1], pi_b[1][0], pi_c[0], pi_c[1]]`. The B coordinates are reversed within each pair for Solidity's verifier.
