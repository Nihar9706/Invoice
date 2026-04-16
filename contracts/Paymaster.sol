// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/*
 * Paymaster — ERC-4337 compliant Verifying Paymaster
 *
 * Responsibilities:
 *  1. Verify backend oracle signature to whitelist financiers dynamically
 *  2. Accept ETH deposits staked inside EntryPoint so it can cover gas
 *  3. Implement validatePaymasterUserOp() so EntryPoint can ask
 *     "will you pay for this op?" before executing it
 *  4. Implement postOp() so EntryPoint can notify us after execution
 */

interface IEntryPoint {
    function depositTo(address account) external payable;
    function getDepositInfo(address account) external view returns (
        uint112 deposit,
        bool staked,
        uint112 stake,
        uint32 unstakeDelaySec,
        uint48 withdrawTime
    );
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
}

contract Paymaster {
    using ECDSA for bytes32;

    // ─── State ──────────────────────────────────────────────────────────────
    address public owner;
    address public entryPoint;
    address public verifyingSigner; // Backend Oracle Signer

    // ─── Events ─────────────────────────────────────────────────────────────
    event VerifyingSignerChanged(address indexed newSigner);
    event GasSponsored(address indexed sender, address indexed target);
    event Deposited(uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────────
    error NotOwner();
    error NotEntryPoint();
    error ZeroAddress();

    // ─── Constructor ────────────────────────────────────────────────────────
    constructor(address _entryPoint, address _verifyingSigner) {
        if (_entryPoint == address(0)) revert ZeroAddress();
        if (_verifyingSigner == address(0)) revert ZeroAddress();
        owner       = msg.sender;
        entryPoint  = _entryPoint;
        verifyingSigner = _verifyingSigner;
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    // =========================================================================
    //  ORACLE MANAGEMENT 
    // =========================================================================

    function setVerifyingSigner(address _verifyingSigner) external onlyOwner {
        if (_verifyingSigner == address(0)) revert ZeroAddress();
        verifyingSigner = _verifyingSigner;
        emit VerifyingSignerChanged(_verifyingSigner);
    }

    // =========================================================================
    //  ERC-4337 — GASLESS CORE
    // =========================================================================

    struct UserOperation {
        address sender;
        address target;
        bytes   data;
        bytes   signature; 
        address paymaster;
        bytes   paymasterData; // This will now contain the Backend Oracle Signature!
        uint256 nonce;
    }

    function validatePaymasterUserOp(
        UserOperation calldata op,
        bytes32  /*userOpHash*/,
        uint256  /*maxCost*/
    )
        external
        view
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        // 1. Reconstruct the hash that the backend signed
        // We hash (sender, target, data, nonce) to ensure this specific action is approved.
        bytes32 hash = keccak256(abi.encode(
            op.sender,
            op.target,
            keccak256(op.data),
            op.nonce
        ));

        // 2. Recover the signer from op.paymasterData
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(hash);
        address recoveredSigner = ECDSA.recover(ethSignedMessageHash, op.paymasterData);

        // 3. Ensure the recovered signer is our trusted backend oracle
        require(recoveredSigner == verifyingSigner, "Paymaster: backend signature invalid or unauthorized");

        // Encode sender + target into context so postOp can log them
        context        = abi.encode(op.sender, op.target);
        validationData = 0;   // 0 = valid, no expiry
    }

    function postOp(
        uint8         mode,
        bytes calldata context,
        uint256        actualGasCost
    )
        external
        onlyEntryPoint
    {
        (address sender, address target) = abi.decode(context, (address, address));

        if (mode == 0) {
            emit GasSponsored(sender, target);
        }
    }

    // =========================================================================
    //  DEPOSIT MANAGEMENT
    // =========================================================================

    function depositToEntryPoint() external payable {
        require(msg.value > 0, "Send ETH to deposit");
        IEntryPoint(entryPoint).depositTo{value: msg.value}(address(this));
        emit Deposited(msg.value);
    }

    function withdrawFromEntryPoint(uint256 amount) external onlyOwner {
        IEntryPoint(entryPoint).withdrawTo(payable(address(this)), amount);
        emit Withdrawn(address(this), amount);
    }

    function getDeposit() external view returns (uint256) {
        (uint112 deposit,,,,) = IEntryPoint(entryPoint).getDepositInfo(address(this));
        return uint256(deposit);
    }

    receive() external payable {}
}
