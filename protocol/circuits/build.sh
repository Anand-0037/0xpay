#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
./node_modules/.bin/circom2 withdraw.circom -l node_modules --r1cs --wasm --sym -o build
# Development ceremony only. This local, single-contributor setup is unsafe for production.
SNARK=./node_modules/.bin/snarkjs
$SNARK powersoftau new bn128 15 build/pot_0000.ptau -v
$SNARK powersoftau contribute build/pot_0000.ptau build/pot_0001.ptau --name='0xPay dev contribution' -e='0xPay DEV ONLY random entropy'
$SNARK powersoftau prepare phase2 build/pot_0001.ptau build/pot_final.ptau -v
$SNARK groth16 setup build/withdraw.r1cs build/pot_final.ptau build/withdraw_0000.zkey
$SNARK zkey contribute build/withdraw_0000.zkey build/withdraw_final.zkey --name='0xPay dev phase2' -e='0xPay DEV ONLY phase2 entropy'
$SNARK zkey export verificationkey build/withdraw_final.zkey build/verification_key.json
$SNARK zkey export solidityverifier build/withdraw_final.zkey ../contracts/src/Groth16Verifier.sol
node ./patch-verifier.mjs
cp build/withdraw_js/withdraw.wasm build/withdraw.wasm
