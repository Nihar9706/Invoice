// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * InvoiceContract — FULLY AUTOMATED Invoice Financing
 *
 * How it works:
 *   1. Buyer pre-deposits ETH into the contract (one-time MetaMask confirm)
 *   2. Financier pre-deposits ETH into the contract (one-time MetaMask confirm)
 *   3. Buyer sets auto-approve condition (e.g. "auto-approve ≤ 5 ETH from any supplier")
 *   4. Financier sets auto-fund condition (e.g. "auto-fund ≤ 10 ETH for any buyer")
 *   5. Supplier uploads invoice → EVERYTHING happens automatically in ONE tx:
 *      - Auto-approve check → locks escrow from buyer's deposit → auto-finance
 *      - Supplier receives 90% instantly, no clicks from buyer or financier
 *   6. On due date → keeper script auto-releases escrow to financier
 *
 * Zero MetaMask popups after initial setup!
 */

interface IPaymasterValidate {
    function validate(address sender) external view returns (bool);
}

contract InvoiceContract {

    address public owner;
    IPaymasterValidate public paymaster;

    // ─── Invoice ─────────────────────────────────────────────────────────────
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

    uint256 public counter;
    mapping(uint256 => Invoice) public invoices;

    // ─── Pre-Deposited Balances ──────────────────────────────────────────────
    // Buyers and financiers deposit ETH here ONCE. The contract then uses
    // these balances to auto-lock escrow and auto-fund without any MetaMask popups.
    mapping(address => uint256) public deposits;

    // ─── Escrow Tracking ─────────────────────────────────────────────────────
    // ETH locked in escrow per invoice (held by contract, released on due date)
    mapping(uint256 => uint256) public escrowBalance;

    // ─── Buyer Auto-Approve Conditions ───────────────────────────────────────
    struct BuyerCondition {
        uint256 maxAutoApproveAmount;
        address allowedSupplier;      // address(0) = accept any supplier
    }
    mapping(address => BuyerCondition) public buyerConditions;

    // ─── Financier Auto-Fund Conditions ──────────────────────────────────────
    struct FinancierCondition {
        uint256 maxAutoFundAmount;
        address allowedBuyer;         // address(0) = accept any buyer
    }
    mapping(address => FinancierCondition) public financierConditions;

    address[] public registeredFinanciers;
    mapping(address => bool) public isRegisteredFinancier;

    // ─── Events ──────────────────────────────────────────────────────────────
    event InvoiceUploaded(uint256 indexed id, address supplier, address buyer, uint256 amount);
    event AutoApproved(uint256 indexed id, string reason);
    event BuyerApproved(uint256 indexed id);
    event EscrowDeposited(uint256 indexed id, uint256 amount);
    event AutoFinanced(uint256 indexed id, address indexed financier, uint256 supplierPayout);
    event Financed(uint256 indexed id, address indexed financier, uint256 supplierPayout);
    event Paid(uint256 indexed id, address indexed financier, uint256 financierPayout);
    event BuyerConditionSet(address indexed buyer, uint256 maxAmount, address allowedSupplier);
    event FinancierConditionSet(address indexed financier, uint256 maxAmount, address allowedBuyer);
    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed user, uint256 amount, uint256 newBalance);

    // ─── Errors ──────────────────────────────────────────────────────────────
    error NotBuyer();
    error AlreadyApproved();
    error NotApproved();
    error IncorrectAmount();
    error EscrowNotLocked();
    error TooEarly();
    error NotFunded();
    error AlreadyPaid();
    error NotWhitelistedFinancier();
    error InsufficientDeposit();

    // ─── Constructor ─────────────────────────────────────────────────────────
    constructor(address _paymaster) {
        require(_paymaster != address(0), "Zero paymaster address");
        owner = msg.sender;
        paymaster = IPaymasterValidate(_paymaster);
    }

    // =========================================================================
    //  DEPOSIT / WITHDRAW — Buyers and Financiers pre-load ETH
    // =========================================================================

    /**
     * @notice Deposit ETH into the contract. This balance will be used
     *         automatically for escrow (buyers) or funding (financiers).
     *         Only requires ONE MetaMask confirmation.
     */
    function depositFunds() external payable {
        require(msg.value > 0, "Zero deposit");
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, deposits[msg.sender]);
    }

    /**
     * @notice Deposit ETH on behalf of another address (e.g. a SmartWallet).
     *         Used in ERC-4337 flow: EOA deposits for their SmartWallet address.
     */
    function depositFor(address beneficiary) external payable {
        require(msg.value > 0, "Zero deposit");
        require(beneficiary != address(0), "Zero address");
        deposits[beneficiary] += msg.value;
        emit Deposited(beneficiary, msg.value, deposits[beneficiary]);
    }

    /**
     * @notice Withdraw unused deposited ETH back to your wallet.
     */
    function withdrawFunds(uint256 amount) external {
        require(deposits[msg.sender] >= amount, "Insufficient balance");
        deposits[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw transfer failed");
        emit Withdrawn(msg.sender, amount, deposits[msg.sender]);
    }

    // =========================================================================
    //  BUYER CONDITION — Set auto-approve rule
    // =========================================================================

    function setBuyerCondition(uint256 maxAmount, address allowedSupplier) external {
        buyerConditions[msg.sender] = BuyerCondition({
            maxAutoApproveAmount: maxAmount,
            allowedSupplier:      allowedSupplier
        });
        emit BuyerConditionSet(msg.sender, maxAmount, allowedSupplier);
    }

    // =========================================================================
    //  FINANCIER CONDITION — Set auto-fund rule
    // =========================================================================

    function setFinancierCondition(uint256 maxAmount, address allowedBuyer) external {
        require(paymaster.validate(msg.sender), "Not a whitelisted financier");

        if (!isRegisteredFinancier[msg.sender]) {
            registeredFinanciers.push(msg.sender);
            isRegisteredFinancier[msg.sender] = true;
        }

        financierConditions[msg.sender] = FinancierCondition({
            maxAutoFundAmount: maxAmount,
            allowedBuyer:      allowedBuyer
        });
        emit FinancierConditionSet(msg.sender, maxAmount, allowedBuyer);
    }

    // =========================================================================
    //  STEP 1 — Supplier uploads invoice → FULL AUTO FLOW
    //
    //  If buyer condition is met AND buyer has enough deposit AND financier
    //  condition is met AND financier has enough deposit:
    //    → Auto-approve → Auto-escrow → Auto-finance → Supplier gets 90%
    //  ALL IN ONE TRANSACTION, ZERO METAMASK POPUPS
    // =========================================================================

    function uploadInvoice(
        address buyer,
        uint256 amount,
        uint256 dueDate
    ) external {
        require(buyer   != address(0), "Zero buyer address");
        require(amount  > 0,           "Zero amount");
        // dueDate validation handled by frontend (1-30 min slider)

        counter++;

        invoices[counter] = Invoice({
            id:               counter,
            supplier:         msg.sender,
            buyer:            buyer,
            amount:           amount,
            dueDate:          dueDate,
            buyerVerified:    false,
            escrowLocked:     false,
            financierFunded:  false,
            isPaid:           false,
            status:           "PENDING",
            financier:        address(0)
        });

        emit InvoiceUploaded(counter, msg.sender, buyer, amount);

        // DEFAULT: Run the full auto chain: approve → escrow → finance
        _checkAutoApproval(counter);
    }

    // =========================================================================
    //  BIDDING SYSTEM — 경쟁 입찰 (Competitive Bidding)
    // =========================================================================

    /**
     * @notice Manually start bidding for an invoice. 
     *         Overrides the auto-financing flow.
     */
    function startBidding(uint256 id) external {
        Invoice storage inv = invoices[id];
        require(msg.sender == inv.supplier, "Only supplier can start bidding");
        require(inv.buyerVerified, "Invoice must be approved first");
        
        inv.status = "BIDDING";
    }

    /**
     * @notice Accept a specific bid (called by supplier or backend authorized)
     */
    function acceptBid(uint256 id, address winningFinancier) external {
        Invoice storage inv = invoices[id];
        require(msg.sender == inv.supplier || msg.sender == owner, "Only supplier or owner can accept bids");
        require(keccak256(bytes(inv.status)) == keccak256(bytes("BIDDING")), "Not in bidding status");
        require(inv.escrowLocked, "Escrow must be locked first");
        require(!inv.financierFunded, "Already funded");

        _executeFinancing(id, winningFinancier);
    }

    // =========================================================================
    //  MANUAL FALLBACKS (if auto doesn't trigger)
    // =========================================================================

    function approveByBuyer(uint256 id) external {
        Invoice storage inv = invoices[id];
        if (msg.sender != inv.buyer) revert NotBuyer();
        if (inv.buyerVerified)       revert AlreadyApproved();

        inv.buyerVerified = true;
        inv.status        = "APPROVED";
        emit BuyerApproved(id);

        // After manual approve, try auto-escrow from deposit
        _tryAutoEscrow(id);
    }

    function depositEscrow(uint256 id) external payable {
        Invoice storage inv = invoices[id];
        if (msg.sender != inv.buyer) revert NotBuyer();
        if (!inv.buyerVerified)      revert NotApproved();
        if (msg.value != inv.amount) revert IncorrectAmount();

        inv.escrowLocked = true;
        inv.status       = "ESCROWED";
        escrowBalance[id] = msg.value;

        emit EscrowDeposited(id, msg.value);
        _checkAutoFinancing(id);
    }

    function fundInvoice(uint256 id) external {
        Invoice storage inv = invoices[id];
        if (!paymaster.validate(msg.sender)) revert NotWhitelistedFinancier();
        if (!inv.buyerVerified)              revert NotApproved();
        if (!inv.escrowLocked)               revert EscrowNotLocked();
        require(!inv.financierFunded, "Already financed");

        _executeFinancing(id, msg.sender);
    }

    /**
     * @notice Escrow from buyer's pre-deposited balance — GASLESS via AA.
     *         No ETH transfer needed; deducts from deposits[msg.sender].
     */
    function escrowFromDeposit(uint256 id) external {
        Invoice storage inv = invoices[id];
        if (msg.sender != inv.buyer) revert NotBuyer();
        if (!inv.buyerVerified)      revert NotApproved();
        require(!inv.escrowLocked,   "Already escrowed");
        require(deposits[msg.sender] >= inv.amount, "Insufficient deposit balance");

        deposits[msg.sender] -= inv.amount;
        inv.escrowLocked = true;
        inv.status       = "ESCROWED";
        escrowBalance[id] = inv.amount;

        emit EscrowDeposited(id, inv.amount);
        _checkAutoFinancing(id);
    }

    // =========================================================================
    //  STEP 5 — Release due-date payment to financier
    // =========================================================================

    function releaseDueDatePayment(uint256 id) external {
        Invoice storage inv = invoices[id];

        if (block.timestamp < inv.dueDate) revert TooEarly();
        if (!inv.financierFunded)          revert NotFunded();
        if (inv.isPaid)                    revert AlreadyPaid();

        inv.isPaid = true;
        inv.status = "PAID";

        // Release the escrowed amount to financier (they get the 10% profit)
        uint256 financierPayout = escrowBalance[id];
        escrowBalance[id] = 0;

        if (financierPayout > 0) {
            (bool ok, ) = payable(inv.financier).call{value: financierPayout}("");
            require(ok, "Financier payout failed");
        }

        emit Paid(id, inv.financier, financierPayout);
    }

    // =========================================================================
    //  VIEW HELPERS
    // =========================================================================

    function getRegisteredFinanciers() external view returns (address[] memory) {
        return registeredFinanciers;
    }

    function registeredFinancierCount() external view returns (uint256) {
        return registeredFinanciers.length;
    }

    // =========================================================================
    //  INTERNAL — The Auto Chain
    // =========================================================================

    /**
     * @dev Step A: Check if buyer's condition allows auto-approve
     */
    function _checkAutoApproval(uint256 id) internal {
        Invoice storage inv = invoices[id];
        BuyerCondition storage cond = buyerConditions[inv.buyer];

        bool globalThreshold = inv.amount < 3 ether;

        bool buyerConditionMet = (
            cond.maxAutoApproveAmount > 0 &&
            inv.amount <= cond.maxAutoApproveAmount &&
            (cond.allowedSupplier == address(0) || cond.allowedSupplier == inv.supplier)
        );

        if (globalThreshold) {
            inv.buyerVerified = true;
            inv.status        = "APPROVED";
            emit AutoApproved(id, "global_threshold_below_3eth");
            // Chain: try auto-escrow next
            _tryAutoEscrow(id);
        } else if (buyerConditionMet) {
            inv.buyerVerified = true;
            inv.status        = "APPROVED";
            emit AutoApproved(id, "buyer_condition_met");
            // Chain: try auto-escrow next
            _tryAutoEscrow(id);
        } else {
            inv.status = "PENDING_BUYER";
        }
    }

    /**
     * @dev Step B: Auto-lock escrow from buyer's pre-deposited balance
     *      This is the KEY new piece — no MetaMask popup needed!
     */
    function _tryAutoEscrow(uint256 id) internal {
        Invoice storage inv = invoices[id];

        // Only proceed if approved but not yet escrowed
        if (!inv.buyerVerified || inv.escrowLocked) return;

        // Check if buyer has enough pre-deposited ETH
        if (deposits[inv.buyer] >= inv.amount) {
            // Deduct from buyer's deposit balance
            deposits[inv.buyer] -= inv.amount;

            // Lock in escrow
            inv.escrowLocked = true;
            inv.status       = "ESCROWED";
            escrowBalance[id] = inv.amount;

            emit EscrowDeposited(id, inv.amount);

            // Chain: try auto-financing next
            _checkAutoFinancing(id);
        }
        // If insufficient deposit, stays APPROVED — buyer can manually depositEscrow()
    }

    /**
     * @dev Step C: Auto-finance from financier's pre-deposited balance
     */
    function _checkAutoFinancing(uint256 id) internal {
        Invoice storage inv = invoices[id];

        for (uint256 i = 0; i < registeredFinanciers.length; i++) {
            address fin = registeredFinanciers[i];
            FinancierCondition storage fc = financierConditions[fin];

            bool amountOk = fc.maxAutoFundAmount > 0 && inv.amount <= fc.maxAutoFundAmount;
            bool buyerOk  = fc.allowedBuyer == address(0) || fc.allowedBuyer == inv.buyer;
            bool stillWhitelisted = paymaster.validate(fin);
            bool hasBalance = deposits[fin] >= (inv.amount * 90) / 100;
            bool isBidding = keccak256(bytes(inv.status)) == keccak256(bytes("BIDDING"));

            if (amountOk && buyerOk && stillWhitelisted && hasBalance && !isBidding) {
                _executeFinancing(id, fin);
                return;
            }
        }
        // No matching financier → stays ESCROWED
    }

    /**
     * @dev Core financing: deduct from financier's deposit, pay supplier 90%
     */
    function _executeFinancing(uint256 id, address fin) internal {
        Invoice storage inv = invoices[id];

        uint256 supplierPayout = (inv.amount * 90) / 100;
        require(deposits[fin] >= supplierPayout, "Financier has insufficient deposit");

        // Deduct from financier's pre-deposited balance
        deposits[fin] -= supplierPayout;

        // The FULL escrow (buyer's money) stays locked.
        // On due date, releaseDueDatePayment sends ALL of it to the financier.
        // (Financier gets back their 90% investment + 10% profit = full invoice amount)
        // escrowBalance[id] stays at inv.amount — DO NOT reduce it.

        inv.financier       = fin;
        inv.financierFunded = true;
        inv.status          = "FINANCED";

        // Pay supplier 90% immediately
        (bool ok, ) = payable(inv.supplier).call{value: supplierPayout}("");
        require(ok, "Supplier payout failed");

        emit AutoFinanced(id, fin, supplierPayout);
        emit Financed(id, fin, supplierPayout);
    }

    // Accept ETH
    receive() external payable {}
}
