// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OxPayPool, IPoseidon2} from "../src/OxPayPool.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";

interface Vm {
    function deal(address account, uint256 newBalance) external;
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function ffi(string[] calldata commandInput) external returns (bytes memory);
    function toString(address value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function expectRevert(bytes4 errorSelector) external;
}

contract MockRegistry {
    uint256 public received;
    uint32 public delay;

    function addStake(uint32 delay_) external payable {
        received += msg.value;
        delay = delay_;
    }
}

contract OxPayPoolTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant FEE = 0.005 ether;
    address private constant RECIPIENT = address(0xB0B0);

    IPoseidon2 private hasher;
    Groth16Verifier private verifier;
    MockRegistry private registry;
    OxPayPool private pool;

    event log_named_uint(string key, uint256 value);

    function setUp() public {
        vm.deal(address(this), 1 ether);
        string memory json = vm.readFile("artifacts/Poseidon2.json");
        bytes memory code = vm.parseJsonBytes(json, ".bytecode");
        address deployed;
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "poseidon deploy failed");
        hasher = IPoseidon2(deployed);
        verifier = new Groth16Verifier();
        registry = new MockRegistry();
        pool = new OxPayPool{value: 0.02 ether}(deployed, address(verifier), address(registry));
        require(registry.received() == 0.012 ether, "stake amount");
        require(registry.delay() == 86400, "stake delay");
    }

    function _fixture() internal returns (uint256[8] memory proof, bytes32 root, bytes32 nullifierHash) {
        uint256[2] memory note = [uint256(123456789), uint256(987654321)];
        bytes32 commitment = bytes32(hasher.poseidon(note));
        pool.deposit{value: 0.1 ether}(commitment);
        string[] memory cmd = new string[](6);
        cmd[0] = "node";
        cmd[1] = "../circuits/test/prove.mjs";
        cmd[2] = vm.toString(RECIPIENT);
        cmd[3] = vm.toString(address(pool));
        cmd[4] = vm.toString(block.chainid);
        cmd[5] = vm.toString(FEE);
        string memory json = string(vm.ffi(cmd));
        root = bytes32(vm.parseJsonUint(json, ".root"));
        nullifierHash = bytes32(vm.parseJsonUint(json, ".nullifierHash"));
        require(root == pool.roots(1), "tree root differs from circomlibjs");
        for (uint256 i; i < 8; ++i) {
            proof[i] = vm.parseJsonUint(json, string.concat(".proof[", vm.toString(i), "]"));
        }
    }

    function testDepositTreeAndStake() public {
        _fixture();
        require(pool.nextIndex() == 1, "index");
        require(address(pool).balance == 0.108 ether, "gas float + deposit");
    }

    function testProofClaimAndRejections() public {
        (uint256[8] memory proof, bytes32 root, bytes32 nullifierHash) = _fixture();
        require(pool.validateClaim(proof, root, nullifierHash, RECIPIENT, FEE, FEE), "valid proof rejected");
        require(!pool.validateClaim(proof, bytes32(uint256(9)), nullifierHash, RECIPIENT, FEE, 0), "bad root");
        require(!pool.validateClaim(proof, root, nullifierHash, address(0x1234), FEE, 0), "wrong recipient");
        require(!pool.validateClaim(proof, root, nullifierHash, address(0), FEE, 0), "zero recipient");
        require(!pool.validateClaim(proof, root, nullifierHash, RECIPIENT, FEE + 1, 0), "wrong fee");
        require(!pool.validateClaim(proof, root, nullifierHash, RECIPIENT, 0.1 ether + 1, 0), "fee above deposit");
        require(!pool.validateClaim(proof, root, nullifierHash, RECIPIENT, FEE, FEE + 1), "fee too low");

        uint256 start = gasleft();
        uint256[2] memory a = [proof[0], proof[1]];
        uint256[2][2] memory b = [[proof[2], proof[3]], [proof[4], proof[5]]];
        uint256[2] memory c = [proof[6], proof[7]];
        uint256[6] memory signals = [uint256(root), uint256(nullifierHash), uint256(uint160(RECIPIENT)), FEE, block.chainid, uint256(uint160(address(pool)))];
        require(verifier.verifyProof(a, b, c, signals), "verifier rejected");
        emit log_named_uint("verifier_gas", start - gasleft());
        start = gasleft();
        require(pool.validateClaim(proof, root, nullifierHash, RECIPIENT, FEE, FEE), "validation rejected");
        emit log_named_uint("validation_core_gas", start - gasleft());

        uint256 beforeBalance = RECIPIENT.balance;
        pool.claim(proof, root, nullifierHash, RECIPIENT, FEE);
        require(RECIPIENT.balance - beforeBalance == 0.095 ether, "claim payout");
        require(pool.nullifierSpent(nullifierHash), "nullifier not spent");
        vm.expectRevert(OxPayPool.InvalidClaim.selector);
        pool.claim(proof, root, nullifierHash, RECIPIENT, FEE);
    }
}
