// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, Scope, TxParam, FrameParam, FrameMode} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

interface IPoseidon2 {
    function poseidon(uint256[2] calldata input) external pure returns (uint256);
}

interface IGroth16Verifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata input) external view returns (bool);
}

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
}

/// DEV ONLY: locally generated proving key and one contributor. Fixed 0.1 ETH notes.
contract OxPayPool is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    uint256 public constant DENOMINATION = 0.1 ether;
    uint256 public constant STAKE = 0.012 ether;
    uint256 public constant DEPTH = 16;
    uint256 public constant ROOT_HISTORY = 30;
    IPoseidon2 public immutable hasher;
    IGroth16Verifier public immutable verifier;

    uint32 public nextIndex;
    bytes32[16] public filledSubtrees;
    bytes32[16] public zeros;
    bytes32[30] public roots;
    uint256 public rootIndex;
    mapping(bytes32 => bool) public nullifierSpent;

    event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp);
    event Claim(address indexed recipient, bytes32 indexed nullifierHash, uint256 fee);

    error InvalidAmount();
    error TreeFull();
    error InvalidClaim();
    error BadFrame();
    error InsufficientConstructionValue();

    constructor(address hasher_, address verifier_, address registry_) payable {
        if (msg.value < STAKE) revert InsufficientConstructionValue();
        hasher = IPoseidon2(hasher_);
        verifier = IGroth16Verifier(verifier_);
        uint256 zero = _hash(0, 0);
        for (uint256 i; i < DEPTH; ++i) {
            zeros[i] = bytes32(zero);
            filledSubtrees[i] = bytes32(zero);
            zero = _hash(zero, zero);
        }
        roots[0] = bytes32(zero);
        IStakingRegistry(registry_).addStake{value: STAKE}(86400);
    }

    function _hash(uint256 left, uint256 right) internal view returns (uint256) {
        uint256[2] memory values = [left, right];
        return hasher.poseidon(values);
    }

    function deposit(bytes32 commitment) external payable {
        if (msg.value != DENOMINATION) revert InvalidAmount();
        uint32 index = nextIndex;
        if (index >= uint32(1 << DEPTH)) revert TreeFull();
        nextIndex = index + 1;
        uint256 current = uint256(commitment);
        uint256 cursor = index;
        for (uint256 level; level < DEPTH; ++level) {
            if ((cursor & 1) == 0) {
                filledSubtrees[level] = bytes32(current);
                current = _hash(current, uint256(zeros[level]));
            } else {
                current = _hash(uint256(filledSubtrees[level]), current);
            }
            cursor >>= 1;
        }
        rootIndex = (rootIndex + 1) % ROOT_HISTORY;
        roots[rootIndex] = bytes32(current);
        emit Deposit(commitment, index, block.timestamp);
    }

    function isKnownRoot(bytes32 root) public view returns (bool) {
        if (root == 0) return false;
        for (uint256 i; i < ROOT_HISTORY; ++i) if (roots[i] == root) return true;
        return false;
    }

    function _validClaim(uint256[8] memory proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee, uint256 minimumFee)
        internal view returns (bool)
    {
        if (!isKnownRoot(root) || nullifierSpent[nullifierHash] || recipient == address(0) || fee > DENOMINATION || fee < minimumFee) return false;
        uint256[2] memory a = [proof[0], proof[1]];
        uint256[2][2] memory b = [[proof[2], proof[3]], [proof[4], proof[5]]];
        uint256[2] memory c = [proof[6], proof[7]];
        uint256[6] memory input = [uint256(root), uint256(nullifierHash), uint256(uint160(recipient)), fee, block.chainid, uint256(uint160(address(this)))];
        return verifier.verifyProof(a, b, c, input);
    }

    /// Forge-callable validation core. The frame checks remain in the claim VERIFY branch.
    function validateClaim(uint256[8] calldata proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee, uint256 minimumFee)
        external view returns (bool)
    {
        return _validClaim(proof, root, nullifierHash, recipient, fee, minimumFee);
    }

    function claim(uint256[8] calldata proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee) external {
        // The live devnet calls this selector in both VERIFY and SENDER frames. Forge uses
        // another chain id, allowing direct execution of the SENDER branch in unit tests.
        if (block.chainid == 1337) {
            uint256 currentFrame = txparam(TxParam.CURRENT_FRAME_INDEX);
            if (frameparam(currentFrame, FrameParam.MODE) == uint256(FrameMode.VERIFY)) {
                uint256 nextFrame = currentFrame + 1;
                if (nextFrame >= txparam(TxParam.FRAME_COUNT)
                    || frameparam(nextFrame, FrameParam.MODE) != uint256(FrameMode.SENDER)
                    || frameparam(nextFrame, FrameParam.RESOLVED_TARGET) != uint256(uint160(address(this)))
                    || frameparam(nextFrame, FrameParam.VALUE) != 0
                    || frameparam(nextFrame, FrameParam.DATA_LENGTH) != msg.data.length
                    || keccak256(framedatacopy(0, msg.data.length, nextFrame)) != keccak256(msg.data)) revert BadFrame();
                if (!_validClaim(proof, root, nullifierHash, recipient, fee, txparam(TxParam.MAX_COST))) revert InvalidClaim();
                approve(Scope.PAYMENT);
                return;
            }
        }
        if (!_validClaim(proof, root, nullifierHash, recipient, fee, 0)) revert InvalidClaim();
        nullifierSpent[nullifierHash] = true;
        (bool sent,) = recipient.call{value: DENOMINATION - fee}("");
        if (!sent) revert InvalidClaim();
        emit Claim(recipient, nullifierHash, fee);
    }
}
