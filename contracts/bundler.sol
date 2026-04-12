// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * Bundler — ERC-4337 compatible
 *
 * Key upgrade: UserOp struct now carries `paymaster` so gasless ops can be
 * forwarded to EntryPoint.handleOp() correctly.
 *
 * In production a Bundler is an off-chain node that:
 *  - Receives UserOperations via a JSON-RPC endpoint (eth_sendUserOperation)
 *  - Simulates them to check validity
 *  - Batches multiple ops into one on-chain transaction
 * This on-chain contract is the last hop that actually calls EntryPoint.
 */

interface IEntryPoint {
    struct UserOperation {
        address sender;
        address target;
        bytes   data;
        bytes   signature;
        address paymaster;   // ← new field
        uint256 nonce;       // ← replay protection
    }

    function handleOp(UserOperation calldata op) external;
    function nonces(address) external view returns (uint256);
}

contract Bundler {

    // ─── Public UserOp struct (used by callers / tests) ─────────────────────
    // Mirrors IEntryPoint.UserOperation exactly.
    struct UserOp {
        address sender;
        address target;
        bytes   data;
        bytes   signature;
        address paymaster;   // address(0) = user pays gas; else = gasless
        uint256 nonce;       // replay protection
    }

    address public entryPoint;
    address public owner;

    event Bundled(uint256 opsCount);

    error NotOwner();
    error ZeroAddress();

    constructor(address _entryPoint) {
        if (_entryPoint == address(0)) revert ZeroAddress();
        entryPoint = _entryPoint;
        owner      = msg.sender;
    }

    // =========================================================================
    //  BUNDLE — submit a batch of UserOps to EntryPoint
    //
    //  Each op is forwarded individually. EntryPoint handles the gasless logic
    //  (paymaster validation, deposit deduction, postOp) for each one.
    //
    //  Why loop individually instead of a true batch?
    //  - Simpler error isolation: one bad op doesn't block others
    //  - Sufficient for this invoice use-case
    //  - Production bundlers do aggregate + revert-on-failure gas simulation
    // =========================================================================

    function bundle(UserOp[] calldata ops) external {
        for (uint256 i = 0; i < ops.length; i++) {
            IEntryPoint.UserOperation memory op = IEntryPoint.UserOperation({
                sender:    ops[i].sender,
                target:    ops[i].target,
                data:      ops[i].data,
                signature: ops[i].signature,
                paymaster: ops[i].paymaster,
                nonce:     ops[i].nonce
            });

            IEntryPoint(entryPoint).handleOp(op);
        }

        emit Bundled(ops.length);
    }

    /**
     * @notice Convenience: bundle a single op without wrapping in an array.
     *         Useful in tests.
     */
    function bundleOne(UserOp calldata op) external {
        IEntryPoint.UserOperation memory epOp = IEntryPoint.UserOperation({
            sender:    op.sender,
            target:    op.target,
            data:      op.data,
            signature: op.signature,
            paymaster: op.paymaster,
            nonce:     op.nonce
        });

        IEntryPoint(entryPoint).handleOp(epOp);
        emit Bundled(1);
    }
}
