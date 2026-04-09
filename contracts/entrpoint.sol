// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * EntryPoint — ERC-4337 compatible (simplified)
 *
 * Key upgrades over the original:
 *  1. UserOperation now carries an optional `paymaster` field
 *  2. handleOp() calls paymaster.validatePaymasterUserOp() BEFORE executing
 *     the op — if approved, gas is sponsored by the Paymaster's deposit
 *  3. handleOp() calls paymaster.postOp() AFTER execution for accounting
 *  4. Paymaster deposits are tracked on-chain (depositTo / withdrawTo)
 *  5. getDepositInfo() lets Paymaster query its own balance
 */

interface ISmartWallet {
    function execute(address target, bytes calldata data) external payable;
    function owner() external view returns (address);
}

interface IPaymaster {
    struct UserOperation {
        address sender;
        address target;
        bytes   data;
        bytes   signature;
        address paymaster;
    }

    function validatePaymasterUserOp(
        UserOperation calldata op,
        bytes32 userOpHash,
        uint256 maxCost
    ) external view returns (bytes memory context, uint256 validationData);

    function postOp(
        uint8          mode,
        bytes calldata context,
        uint256        actualGasCost
    ) external;
}

contract EntryPoint {

    // ─── UserOperation ───────────────────────────────────────────────────────
    // `paymaster` is optional — address(0) means the sender pays their own gas
    // (standard non-sponsored flow). Set it to a funded Paymaster for gasless.
    struct UserOperation {
        address sender;       // SmartWallet address
        address target;       // contract to call
        bytes   data;         // calldata
        bytes   signature;    // owner's signature over (sender, target, data)
        address paymaster;    // address(0) = user pays gas; else = gasless
    }

    // ─── Deposit ledger ──────────────────────────────────────────────────────
    // Paymasters deposit ETH here. EntryPoint deducts gas costs from their
    // balance so the actual sender doesn't need any ETH.
    mapping(address => uint256) public deposits;

    // ─── Events ──────────────────────────────────────────────────────────────
    event OperationExecuted(address indexed sender, address indexed target, bool sponsored);
    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    // =========================================================================
    //  DEPOSIT MANAGEMENT
    //  (Paymaster calls depositTo to fund gas; EntryPoint deducts from it)
    // =========================================================================

    /**
     * @notice Deposit ETH for `account` (usually called by the Paymaster
     *         via Paymaster.depositToEntryPoint()).
     */
    function depositTo(address account) external payable {
        require(account != address(0), "Zero address");
        require(msg.value > 0,         "Zero deposit");
        deposits[account] += msg.value;
        emit Deposited(account, msg.value);
    }

    /**
     * @notice Withdraw from deposit. Used by Paymaster owner to reclaim funds.
     */
    function withdrawTo(address payable withdrawAddress, uint256 amount) external {
        require(deposits[msg.sender] >= amount, "Insufficient deposit");
        deposits[msg.sender] -= amount;
        (bool ok,) = withdrawAddress.call{value: amount}("");
        require(ok, "Withdraw failed");
        emit Withdrawn(msg.sender, withdrawAddress, amount);
    }

    /**
     * @notice Returns deposit info for an account.
     *         Matches the interface Paymaster.getDeposit() calls.
     */
    function getDepositInfo(address account)
        external
        view
        returns (
            uint112 deposit,
            bool    staked,
            uint112 stake,
            uint32  unstakeDelaySec,
            uint48  withdrawTime
        )
    {
        deposit = uint112(deposits[account]);
        // Simplified: no staking distinction in this educational implementation
        staked          = deposits[account] > 0;
        stake           = 0;
        unstakeDelaySec = 0;
        withdrawTime    = 0;
    }

    // =========================================================================
    //  CORE: handleOp
    //
    //  Flow for GASLESS op (op.paymaster != address(0)):
    //   1. Verify signature
    //   2. Ask Paymaster: validatePaymasterUserOp → must not revert
    //   3. Snapshot gas before execution
    //   4. Execute the op via SmartWallet
    //   5. Calculate actual gas cost
    //   6. Deduct gas cost from Paymaster's deposit
    //   7. Call Paymaster.postOp() for accounting / events
    //
    //  Flow for NORMAL op (op.paymaster == address(0)):
    //   1. Verify signature
    //   2. Execute the op via SmartWallet
    //   (caller pays gas the normal Ethereum way)
    // =========================================================================

    function handleOp(UserOperation calldata op) external {

        // ── Step 1: Signature verification (unchanged from original) ─────────
        require(_verify(op), "EntryPoint: invalid signature");

        bool sponsored = op.paymaster != address(0);
        bytes memory pmContext;

        // ── Step 2: Paymaster pre-validation (gasless path only) ──────────────
        if (sponsored) {
            // Gas estimate for this op — used by Paymaster for risk assessment.
            // In a real ERC-4337 implementation this would be the preVerificationGas
            // + verificationGasLimit. We use a simple upper-bound here.
            uint256 maxCost = tx.gasprice * 300_000;

            require(
                deposits[op.paymaster] >= maxCost,
                "EntryPoint: paymaster deposit too low"
            );

            bytes32 opHash = _hashOp(op);

            // This will revert if the Paymaster rejects the op
            uint256 validationData;
            (pmContext, validationData) = IPaymaster(op.paymaster)
                .validatePaymasterUserOp(
                    IPaymaster.UserOperation({
                        sender:    op.sender,
                        target:    op.target,
                        data:      op.data,
                        signature: op.signature,
                        paymaster: op.paymaster
                    }),
                    opHash,
                    maxCost
                );

            require(validationData == 0, "EntryPoint: paymaster rejected op");
        }

        // ── Step 3: Execute ───────────────────────────────────────────────────
        uint256 gasBefore = gasleft();

        ISmartWallet(op.sender).execute(op.target, op.data);

        uint256 gasUsed = gasBefore - gasleft();

        // ── Step 4: Deduct gas cost from Paymaster deposit ────────────────────
        if (sponsored) {
            uint256 actualGasCost = gasUsed * tx.gasprice;

            // Cap deduction to available deposit (don't revert on underflow)
            if (deposits[op.paymaster] >= actualGasCost) {
                deposits[op.paymaster] -= actualGasCost;
            } else {
                deposits[op.paymaster] = 0;
            }

            // ── Step 5: Notify Paymaster ──────────────────────────────────────
            // mode 0 = success
            try IPaymaster(op.paymaster).postOp(0, pmContext, actualGasCost) {}
            catch {
                // postOp failure does NOT revert the main op (ERC-4337 spec)
                // mode 2 = postOp reverted
            }
        }

        emit OperationExecuted(op.sender, op.target, sponsored);
    }

    // =========================================================================
    //  INTERNALS
    // =========================================================================

    function _verify(UserOperation calldata op) internal view returns (bool) {
        bytes32 hash = keccak256(
            abi.encode(op.sender, op.target, op.data)
        );

        bytes32 ethSigned = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)
        );

        (bytes32 r, bytes32 s, uint8 v) = _split(op.signature);
        address signer = ecrecover(ethSigned, v, r, s);

        return signer == ISmartWallet(op.sender).owner();
    }

    function _hashOp(UserOperation calldata op) internal pure returns (bytes32) {
        return keccak256(abi.encode(op.sender, op.target, op.data, op.paymaster));
    }

    function _split(bytes memory sig)
        internal
        pure
        returns (bytes32 r, bytes32 s, uint8 v)
    {
        require(sig.length == 65, "EntryPoint: bad signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    receive() external payable {}
}
