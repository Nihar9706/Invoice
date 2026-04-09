// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * Paymaster — ERC-4337 compliant
 *
 * Responsibilities:
 *  1. Whitelist financiers (same as before)
 *  2. Accept ETH deposits staked inside EntryPoint so it can cover gas
 *  3. Implement validatePaymasterUserOp() so EntryPoint can ask
 *     "will you pay for this op?" before executing it
 *  4. Implement postOp() so EntryPoint can notify us after execution
 *     (we log it; in production you'd do accounting here)
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

    // ─── State ──────────────────────────────────────────────────────────────
    address public owner;
    address public entryPoint;                         // the EntryPoint we're staked in

    mapping(address => bool) public allowed;           // whitelisted wallets / financiers

    // ─── Events ─────────────────────────────────────────────────────────────
    event UserAdded(address indexed user);
    event UserRemoved(address indexed user);
    event GasSponsored(address indexed sender, address indexed target);
    event Deposited(uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────────
    error NotOwner();
    error AlreadyAllowed();
    error NotAllowed();
    error NotEntryPoint();
    error ZeroAddress();

    // ─── Constructor ────────────────────────────────────────────────────────
    constructor(address _entryPoint) {
        if (_entryPoint == address(0)) revert ZeroAddress();
        owner       = msg.sender;
        entryPoint  = _entryPoint;
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
    //  WHITELIST MANAGEMENT (unchanged logic, same as before)
    // =========================================================================

    function addUser(address user) external onlyOwner {
        if (allowed[user]) revert AlreadyAllowed();
        allowed[user] = true;
        emit UserAdded(user);
    }

    function removeUser(address user) external onlyOwner {
        if (!allowed[user]) revert NotAllowed();
        allowed[user] = false;
        emit UserRemoved(user);
    }

    /// @notice Used by InvoiceContract to check if a financier is whitelisted
    function validate(address sender) external view returns (bool) {
        return allowed[sender];
    }

    // =========================================================================
    //  ERC-4337 — GASLESS CORE
    //
    //  How it works:
    //   EntryPoint calls validatePaymasterUserOp() BEFORE executing the op.
    //   If we return validationData == 0 (success), EntryPoint will deduct
    //   the gas cost from our staked deposit instead of the sender's wallet.
    //   postOp() is called AFTER execution so we can do any post-processing.
    // =========================================================================

    struct UserOperation {
        address sender;
        address target;
        bytes   data;
        bytes   signature;
        address paymaster;
    }

    /**
     * @notice EntryPoint calls this to ask: "will you sponsor this op?"
     * @dev    Return (context, 0)  → approved, gas comes from our deposit
     *         Revert               → rejected, op fails
     *
     * We approve if the sender wallet is whitelisted.
     * `context` is passed back into postOp() — we encode the sender so we
     * can emit a useful event there.
     */
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
        // Only sponsor ops from whitelisted senders
        require(allowed[op.sender], "Paymaster: sender not whitelisted");

        // Encode sender + target into context so postOp can log them
        context        = abi.encode(op.sender, op.target);
        validationData = 0;   // 0 = valid, no expiry
    }

    /**
     * @notice EntryPoint calls this after the op executes (or if it reverts).
     * @param  mode     0 = success, 1 = reverted (but we still pay), 2 = postOp itself reverted
     * @param  context  whatever we returned from validatePaymasterUserOp
     * @param  actualGasCost  actual gas used (in wei) — deducted from our deposit
     */
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

        // actualGasCost has already been deducted from our EntryPoint deposit
        // by the time postOp is called. Nothing extra to do here for basic use.
        // In production: track per-user spend, enforce limits, etc.
        // (actualGasCost is intentionally unused in this basic implementation)
    }

    // =========================================================================
    //  DEPOSIT / STAKE MANAGEMENT
    //
    //  The Paymaster must have ETH sitting inside EntryPoint.
    //  The owner calls depositToEntryPoint() to fund it.
    //  Without this, validatePaymasterUserOp will pass but EntryPoint will
    //  revert because there's nothing to pay gas from.
    // =========================================================================

    /**
     * @notice Fund this Paymaster's gas deposit inside EntryPoint.
     *         Anyone can top it up, but typically the owner does.
     */
    function depositToEntryPoint() external payable {
        require(msg.value > 0, "Send ETH to deposit");
        IEntryPoint(entryPoint).depositTo{value: msg.value}(address(this));
        emit Deposited(msg.value);
    }

    /**
     * @notice Withdraw from EntryPoint deposit back to this contract.
     *         Only owner can do this.
     */
    function withdrawFromEntryPoint(uint256 amount) external onlyOwner {
        IEntryPoint(entryPoint).withdrawTo(payable(address(this)), amount);
        emit Withdrawn(address(this), amount);
    }

    /**
     * @notice Check how much ETH this Paymaster has deposited in EntryPoint.
     */
    function getDeposit() external view returns (uint256) {
        (uint112 deposit,,,,) = IEntryPoint(entryPoint).getDepositInfo(address(this));
        return uint256(deposit);
    }

    // ─── Receive ETH (for withdrawFromEntryPoint to land) ───────────────────
    receive() external payable {}
}
