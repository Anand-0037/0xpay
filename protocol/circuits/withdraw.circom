pragma circom 2.2.2;

include "circomlib/circuits/poseidon.circom";

template Withdraw() {
    signal input nullifier;
    signal input secret;
    signal input pathElements[16];
    signal input pathIndices[16];
    signal input root;
    signal input nullifierHash;
    signal input recipient;
    signal input fee;
    signal input chainId;
    signal input pool;

    component commitment = Poseidon(2);
    commitment.inputs[0] <== nullifier;
    commitment.inputs[1] <== secret;
    component hash = Poseidon(1);
    hash.inputs[0] <== nullifier;
    nullifierHash === hash.out;

    signal nodes[17];
    nodes[0] <== commitment.out;
    component level[16];
    for (var i = 0; i < 16; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        level[i] = Poseidon(2);
        level[i].inputs[0] <== nodes[i] + pathIndices[i] * (pathElements[i] - nodes[i]);
        level[i].inputs[1] <== pathElements[i] + pathIndices[i] * (nodes[i] - pathElements[i]);
        nodes[i + 1] <== level[i].out;
    }
    root === nodes[16];

    // Public signals remain in the verification key even when not used in the hash path.
    signal recipientSquare;
    signal feeSquare;
    signal chainIdSquare;
    signal poolSquare;
    recipientSquare <== recipient * recipient;
    feeSquare <== fee * fee;
    chainIdSquare <== chainId * chainId;
    poolSquare <== pool * pool;
}

component main {public [root, nullifierHash, recipient, fee, chainId, pool]} = Withdraw();
