# Protocol contracts

`OxPayPool` uses the workshop Hegota helper opcodes. Deploy `Poseidon2.json` bytecode, `Groth16Verifier.json` bytecode, then the payable `OxPayPool` constructor with `(hasher, verifier, registry)` and at least 0.012 ETH CREATE value. The constructor stakes 0.012 ETH for 86400 seconds. The devnet registry is `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`; tests use `MockRegistry`.

The pool has no `receive()` entry. Fund its gas float through CREATE value or retained claim fees. Deposits are exactly 0.1 ETH. The latest 30 Merkle roots are accepted.

The VERIFY(PAYMENT) frame must call `claim` with the exact same encoded calldata as the next SENDER frame. The next frame must target this pool, have mode SENDER and value zero. The pool compares a hash of the next frame data with `msg.data`, checks the root and nullifier, requires fee at least `TXPARAM(MAX_COST)`, verifies the proof, and approves `Scope.PAYMENT`. The SENDER call rechecks the proof and state, marks the nullifier, then pays the recipient. `validateClaim` exposes the shared claim checks for tests; it does not approve payment.

Run `npm install --ignore-scripts`, `npm run build`, and `forge test -vv --gas-report`. Foundry cannot execute the devnet frame opcodes, so the frame binding and APPROVE branch require a live sidecar integration test. The tests do exercise the same proof and state validation core and a real claim. `foundry.toml` enables FFI because the test asks `../circuits/test/prove.mjs` to create a proof bound to the test pool address.

The snarkjs verifier export is postprocessed by `../circuits/patch-verifier.mjs` during `../circuits/build.sh`. It replaces dynamic `gas()` arguments on the three BN254 precompile calls with fixed limits, because the public sidecar bans the GAS opcode in payer validation. Rebuilding the verifier from the proving key without that patch restores the banned opcode.
