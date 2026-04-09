// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * SmartWallet — ERC-4337 compatible
 *
 * Key upgrade: the wallet now also accepts calls from the registered Paymaster.
 * This allows the Paymaster's sponsorTransaction() to directly execute ops
 * on behalf of whitelisted users even outside the EntryPoint flow.
 *
 * Authorization hierarchy:
 *   owner       → can call execute / executeBatch directly (e.g. in tests)
 *   entryPoint  → calls execute after verifying the UserOperation signature
 *   paymaster   → can call execute for sponsored direct-relay flows
 */

contract SmartWallet {

    address public owner;
    address public entryPoint;
    address public paymaster;     // ← new: Paymaster is also trusted

    event PaymasterUpdated(address indexed oldPM, address indexed newPM);

    error NotAuthorized();
    error ZeroAddress();

    constructor(
        address _owner,
        address _entryPoint,
        address _paymaster      // ← new constructor parameter
    ) {
        if (_owner      == address(0)) revert ZeroAddress();
        if (_entryPoint == address(0)) revert ZeroAddress();
        // paymaster is optional at deploy time (can be address(0))

        owner      = _owner;
        entryPoint = _entryPoint;
        paymaster  = _paymaster;
    }

    // ─── Authorization ───────────────────────────────────────────────────────
    modifier onlyAuthorized() {
        if (
            msg.sender != owner       &&
            msg.sender != entryPoint  &&
            msg.sender != paymaster
        ) revert NotAuthorized();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    // =========================================================================
    //  EXECUTION
    // =========================================================================

    /**
     * @notice Execute a single call on behalf of the wallet.
     *         Called by EntryPoint (gasless) or owner (direct).
     */
    function execute(address target, bytes calldata data)
        external
        payable
        onlyAuthorized
    {
        (bool success, bytes memory result) = target.call{value: msg.value}(data);
        if (!success) {
            // Bubble up the revert reason
            if (result.length > 0) {
                assembly { revert(add(result, 32), mload(result)) }
            }
            revert("SmartWallet: execution failed");
        }
    }

    /**
     * @notice Execute multiple calls atomically.
     *         ETH value is forwarded only to the last call in the batch
     *         (same pattern as original).
     */
    function executeBatch(
        address[] calldata targets,
        bytes[]   calldata dataList
    )
        external
        payable
        onlyAuthorized
    {
        require(targets.length == dataList.length, "SmartWallet: length mismatch");

        for (uint256 i = 0; i < targets.length; i++) {
            uint256 val = (i == targets.length - 1) ? msg.value : 0;
            (bool success, bytes memory result) = targets[i].call{value: val}(dataList[i]);

            if (!success) {
                if (result.length > 0) {
                    assembly { revert(add(result, 32), mload(result)) }
                }
                revert("SmartWallet: batch call failed");
            }
        }
    }

    // =========================================================================
    //  ADMIN — owner can update the paymaster after deploy
    // =========================================================================

    function setPaymaster(address _paymaster) external onlyOwner {
        emit PaymasterUpdated(paymaster, _paymaster);
        paymaster = _paymaster;
    }

    // ─── Receive ETH — auto-forward to owner (EOA / MetaMask) ─────────────────
    receive() external payable {
        if (msg.value > 0) {
            (bool ok, ) = payable(owner).call{value: msg.value}("");
            require(ok, "SmartWallet: ETH forward failed");
        }
    }
}
