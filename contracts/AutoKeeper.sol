// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * AutoKeeper — Permissionless due-date payment releaser
 *
 * Anyone (a cron bot, another contract, or a user) can call checkAndRelease()
 * with a list of invoice IDs. For each ID whose due date has passed and is
 * fully financed but not yet paid, it triggers releaseDueDatePayment().
 *
 * This eliminates manual buyer/financier involvement on the due date entirely.
 *
 * In production you would replace this with:
 *  - Chainlink Automation (formerly Keepers)
 *  - Gelato Ops
 *  - A simple off-chain cron script (see scripts/keeper.js)
 */

interface IInvoiceContract {
    function releaseDueDatePayment(uint256 id) external;
    function counter() external view returns (uint256);

    struct Invoice {
        uint256 id;
        address supplier;
        address buyer;
        uint256 amount;
        uint256 dueDate;
        bool    buyerVerified;
        bool    escrowLocked;
        bool    financierFunded;
        bool    isPaid;
        string  status;
        address financier;
    }
    function invoices(uint256 id) external view returns (
        uint256, address, address, uint256, uint256,
        bool, bool, bool, bool, string memory, address
    );
}

contract AutoKeeper {

    IInvoiceContract public immutable invoiceContract;
    address public owner;

    event Released(uint256 indexed invoiceId, address indexed triggeredBy);
    event SkippedNotDue(uint256 indexed invoiceId);
    event SkippedAlreadyPaid(uint256 indexed invoiceId);
    event SkippedNotFinanced(uint256 indexed invoiceId);

    error ZeroAddress();

    constructor(address _invoiceContract) {
        if (_invoiceContract == address(0)) revert ZeroAddress();
        invoiceContract = IInvoiceContract(_invoiceContract);
        owner = msg.sender;
    }

    // =========================================================================
    //  CORE: checkAndRelease
    //
    //  Pass in the invoice IDs you want to check. The keeper will attempt to
    //  release each one. Reverts in releaseDueDatePayment() are silently
    //  swallowed (TooEarly, AlreadyPaid, NotFunded) — other invoices continue.
    //
    //  Usage:
    //    keeper.checkAndRelease([1, 2, 3, 4, 5])
    //    keeper.releaseAll()   ← auto-scans from 1 to counter
    // =========================================================================

    /**
     * @notice Try to release payment for the specified invoice IDs.
     *         Safe to call with any IDs — past, future, or already paid.
     */
    function checkAndRelease(uint256[] calldata invoiceIds) external {
        for (uint256 i = 0; i < invoiceIds.length; i++) {
            _tryRelease(invoiceIds[i]);
        }
    }

    /**
     * @notice Scan ALL invoices from ID 1 to the current counter and release
     *         any that are past due date, financed, and not yet paid.
     *         Useful for a simple cron job that calls this once per minute.
     */
    function releaseAll() external {
        uint256 total = invoiceContract.counter();
        for (uint256 id = 1; id <= total; id++) {
            _tryRelease(id);
        }
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _tryRelease(uint256 id) internal {
        // Read invoice state (positional decode)
        (
            ,          // id
            ,          // supplier
            ,          // buyer
            ,          // amount
            uint256 dueDate,
            ,          // buyerVerified
            ,          // escrowLocked
            bool financierFunded,
            bool isPaid,
            ,          // status
               // financier
        ) = invoiceContract.invoices(id);

        // Skip if not yet due
        if (block.timestamp < dueDate) {
            emit SkippedNotDue(id);
            return;
        }

        // Skip if already paid
        if (isPaid) {
            emit SkippedAlreadyPaid(id);
            return;
        }

        // Skip if not financed yet
        if (!financierFunded) {
            emit SkippedNotFinanced(id);
            return;
        }

        // Attempt release — catch any revert silently
        try invoiceContract.releaseDueDatePayment(id) {
            emit Released(id, msg.sender);
        } catch {
            // Already paid, not due, or not funded — ignore
        }
    }
}
