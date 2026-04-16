// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPaymasterValidate {
    function validate(address sender) external view returns (bool);
}

contract InvoiceContract {

    IPaymasterValidate public paymaster;

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
    mapping(address => uint256) public deposits;
    mapping(uint256 => uint256) public escrowBalance;

    struct BuyerCondition {
        uint256 maxAutoApproveAmount;
        address allowedSupplier;
    }
    mapping(address => BuyerCondition) public buyerConditions;

    struct FinancierCondition {
        uint256 maxAutoFundAmount;
        address allowedBuyer;
    }
    mapping(address => FinancierCondition) public financierConditions;

    address[] public registeredFinanciers;
    mapping(address => bool) public isRegisteredFinancier;

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

    constructor(address _paymaster) {
        require(_paymaster != address(0), "Zero paymaster address");
        paymaster = IPaymasterValidate(_paymaster);
    }

    function depositFunds() external payable {
        require(msg.value > 0, "Zero deposit");
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, deposits[msg.sender]);
    }

    function depositFor(address beneficiary) external payable {
        require(msg.value > 0, "Zero deposit");
        require(beneficiary != address(0), "Zero address");
        deposits[beneficiary] += msg.value;
        emit Deposited(beneficiary, msg.value, deposits[beneficiary]);
    }

    function withdrawFunds(uint256 amount) external {
        require(deposits[msg.sender] >= amount, "Insufficient balance");
        deposits[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw transfer failed");
        emit Withdrawn(msg.sender, amount, deposits[msg.sender]);
    }

    function setBuyerCondition(uint256 maxAmount, address allowedSupplier) external {
        buyerConditions[msg.sender] = BuyerCondition({
            maxAutoApproveAmount: maxAmount,
            allowedSupplier:      allowedSupplier
        });
        emit BuyerConditionSet(msg.sender, maxAmount, allowedSupplier);
    }

    function setFinancierCondition(uint256 maxAmount, address allowedBuyer) external {

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

    function uploadInvoice(
        address buyer,
        uint256 amount,
        uint256 dueDate
    ) external {
        require(buyer   != address(0), "Zero buyer address");
        require(amount  > 0,           "Zero amount");

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

        _checkAutoApproval(counter);
    }

    function approveByBuyer(uint256 id) external {
        Invoice storage inv = invoices[id];
        if (msg.sender != inv.buyer) revert NotBuyer();
        if (inv.buyerVerified)       revert AlreadyApproved();

        inv.buyerVerified = true;
        inv.status        = "APPROVED";
        emit BuyerApproved(id);

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
        if (!inv.buyerVerified)              revert NotApproved();
        if (!inv.escrowLocked)               revert EscrowNotLocked();
        require(!inv.financierFunded, "Already financed");

        _executeFinancing(id, msg.sender);
    }

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

    function releaseDueDatePayment(uint256 id) external {
        Invoice storage inv = invoices[id];

        if (block.timestamp < inv.dueDate) revert TooEarly();
        if (!inv.financierFunded)          revert NotFunded();
        if (inv.isPaid)                    revert AlreadyPaid();

        inv.isPaid = true;
        inv.status = "PAID";

        uint256 financierPayout = escrowBalance[id];
        escrowBalance[id] = 0;

        if (financierPayout > 0) {
            (bool ok, ) = payable(inv.financier).call{value: financierPayout}("");
            require(ok, "Financier payout failed");
        }

        emit Paid(id, inv.financier, financierPayout);
    }

    function getRegisteredFinanciers() external view returns (address[] memory) {
        return registeredFinanciers;
    }

    function registeredFinancierCount() external view returns (uint256) {
        return registeredFinanciers.length;
    }

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
            _tryAutoEscrow(id);
        } else if (buyerConditionMet) {
            inv.buyerVerified = true;
            inv.status        = "APPROVED";
            emit AutoApproved(id, "buyer_condition_met");
            _tryAutoEscrow(id);
        } else {
            inv.status = "PENDING_BUYER";
        }
    }

    function _tryAutoEscrow(uint256 id) internal {
        Invoice storage inv = invoices[id];

        if (!inv.buyerVerified || inv.escrowLocked) return;

        if (deposits[inv.buyer] >= inv.amount) {
            deposits[inv.buyer] -= inv.amount;

            inv.escrowLocked = true;
            inv.status       = "ESCROWED";
            escrowBalance[id] = inv.amount;

            emit EscrowDeposited(id, inv.amount);

            _checkAutoFinancing(id);
        }
    }

    function _checkAutoFinancing(uint256 id) internal {
        Invoice storage inv = invoices[id];

        for (uint256 i = 0; i < registeredFinanciers.length; i++) {
            address fin = registeredFinanciers[i];
            FinancierCondition storage fc = financierConditions[fin];

            bool amountOk = fc.maxAutoFundAmount > 0 && inv.amount <= fc.maxAutoFundAmount;
            bool buyerOk  = fc.allowedBuyer == address(0) || fc.allowedBuyer == inv.buyer;
            bool hasBalance = deposits[fin] >= (inv.amount * 90) / 100;

            if (amountOk && buyerOk && hasBalance) {
                _executeFinancing(id, fin);
                return;
            }
        }
    }

    function _executeFinancing(uint256 id, address fin) internal {
        Invoice storage inv = invoices[id];

        uint256 supplierPayout = (inv.amount * 90) / 100;

        deposits[fin] -= supplierPayout;

        inv.financier       = fin;
        inv.financierFunded = true;
        inv.status          = "FINANCED";

        (bool ok, ) = payable(inv.supplier).call{value: supplierPayout}("");
        require(ok, "Supplier payout failed");

        emit AutoFinanced(id, fin, supplierPayout);
        emit Financed(id, fin, supplierPayout);
    }

    receive() external payable {}
}