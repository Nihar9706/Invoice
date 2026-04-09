const { expect }       = require("chai");
const { ethers, network } = require("hardhat");

// =============================================================================
//  TEST SUITE: Invoice Finance — ERC-4337 Account Abstraction
//
//  Roles:
//    owner     — deploys contracts, manages Paymaster whitelist
//    supplier  — uploads invoices
//    buyer     — has a SmartWallet; approves & deposits escrow (gasless)
//    financier — whitelisted in Paymaster; funds invoices (gasless)
//    keeper    — triggers due-date release (permissionless)
//
//  AA Flow per invoice:
//    1. [Optional] buyer.setBuyerCondition()
//    2. [Optional] financier.setFinancierCondition()
//    3. supplier.uploadInvoice() → auto-approve check
//    4. [If not auto-approved] buyer signs UserOp → Bundler → EntryPoint → SmartWallet
//    5. buyer deposits escrow via SmartWallet.execute() → auto-finance check
//    6. [If not auto-financed] financier.fundInvoice()
//    7. On/after dueDate → AutoKeeper.releaseAll() or releaseDueDatePayment()
// =============================================================================

// ─── Helper: Build a signed ERC-4337 UserOperation ───────────────────────────
// EntryPoint._verify() reconstructs: keccak256(abi.encode(sender, target, data))
// then signs with the Ethereum prefix via signMessage().
async function buildGaslessOp(signer, wallet, targetContract, callData, paymasterAddress) {
    const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "bytes"],
            [wallet.target, targetContract.target, callData]
        )
    );
    const signature = await signer.signMessage(ethers.getBytes(hash));
    return {
        sender:    wallet.target,
        target:    targetContract.target,
        data:      callData,
        signature: signature,
        paymaster: paymasterAddress,
    };
}

// ─── Deploy helper ────────────────────────────────────────────────────────────
async function deploy(signers) {
    const [owner, supplier, buyer, financier] = signers;

    // 1. EntryPoint
    const EP    = await ethers.getContractFactory("EntryPoint");
    const entry = await EP.deploy();
    await entry.waitForDeployment();

    // 2. Paymaster → fund its deposit inside EntryPoint
    const PM      = await ethers.getContractFactory("Paymaster");
    const paymaster = await PM.deploy(entry.target);
    await paymaster.waitForDeployment();

    await paymaster.connect(owner).depositToEntryPoint({
        value: ethers.parseEther("5"),   // plenty for many ops
    });

    // 3. InvoiceContract
    const IC      = await ethers.getContractFactory("InvoiceContract");
    const invoice = await IC.deploy(paymaster.target);
    await invoice.waitForDeployment();

    // 4. AutoKeeper
    const AK     = await ethers.getContractFactory("AutoKeeper");
    const keeper = await AK.deploy(invoice.target);
    await keeper.waitForDeployment();

    // 5. Bundler
    const BD     = await ethers.getContractFactory("Bundler");
    const bundler = await BD.deploy(entry.target);
    await bundler.waitForDeployment();

    // 6. Buyer's SmartWallet (buyer is the owner, entryPoint + paymaster are trusted)
    const SW    = await ethers.getContractFactory("SmartWallet");
    const wallet = await SW.deploy(buyer.address, entry.target, paymaster.target);
    await wallet.waitForDeployment();

    return { entry, paymaster, invoice, keeper, bundler, wallet };
}

// =============================================================================
//  TEST GROUPS
// =============================================================================

describe("Invoice Finance — Full AA System", function () {

    // ─────────────────────────────────────────────────────────────────────────
    // 1. FULL MANUAL FLOW (baseline — no auto conditions)
    // ─────────────────────────────────────────────────────────────────────────
    describe("A. Full Manual Flow (baseline)", function () {

        it("Full lifecycle: upload → gasless approve → escrow → finance → keeper release", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { entry, paymaster, invoice, keeper, bundler, wallet } =
                await deploy([owner, supplier, buyer, financier]);

            // Whitelist financier and buyer wallet in Paymaster
            await paymaster.connect(owner).addUser(financier.address);
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 120;

            // ── STEP 1: Supplier uploads invoice ──────────────────────────────
            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            let inv = await invoice.invoices(1);
            expect(inv.status).to.equal("PENDING_BUYER");
            console.log("  ✅ Step 1 — Uploaded:", inv.status);

            // ── STEP 2: Buyer approves via gasless Bundler → EntryPoint ───────
            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            const approveOp   = await buildGaslessOp(buyer, wallet, invoice, approveData, paymaster.target);
            await bundler.bundle([approveOp]);

            inv = await invoice.invoices(1);
            expect(inv.buyerVerified).to.equal(true);
            expect(inv.status).to.equal("APPROVED");
            console.log("  ✅ Step 2 — Gasless approve:", inv.status);

            // ── STEP 3: Buyer deposits escrow via SmartWallet ─────────────────
            await buyer.sendTransaction({ to: wallet.target, value: amount });

            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            inv = await invoice.invoices(1);
            expect(inv.escrowLocked).to.equal(true);
            expect(inv.status).to.equal("ESCROWED");
            console.log("  ✅ Step 3 — Escrow deposited:", inv.status);

            // ── STEP 4: Financier manually funds invoice ───────────────────────
            const supplierBefore = await ethers.provider.getBalance(supplier.address);
            await invoice.connect(financier).fundInvoice(1);
            const supplierAfter = await ethers.provider.getBalance(supplier.address);

            inv = await invoice.invoices(1);
            expect(inv.financierFunded).to.equal(true);
            expect(inv.status).to.equal("FINANCED");
            expect(supplierAfter - supplierBefore).to.equal((amount * 90n) / 100n);
            console.log("  ✅ Step 4 — Financed. Supplier received 90%");

            // ── STEP 5: Time travel past due date ─────────────────────────────
            await network.provider.send("evm_increaseTime", [150]);
            await network.provider.send("evm_mine");

            // ── STEP 6: AutoKeeper releases payment ────────────────────────────
            const financierBefore = await ethers.provider.getBalance(financier.address);
            await keeper.connect(owner).releaseAll();
            const financierAfter = await ethers.provider.getBalance(financier.address);

            inv = await invoice.invoices(1);
            expect(inv.isPaid).to.equal(true);
            expect(inv.status).to.equal("PAID");
            expect(financierAfter - financierBefore).to.equal((amount * 10n) / 100n);
            console.log("  ✅ Step 5 — AutoKeeper released 10% to financier");
            console.log("  🎉 Full flow complete!\n");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. AUTO-APPROVAL — Buyer pre-registers condition
    // ─────────────────────────────────────────────────────────────────────────
    describe("B. Buyer Auto-Approve Conditions", function () {

        it("Global threshold: amounts < 3 ETH are auto-approved on upload", async function () {
            const [owner, supplier, buyer] = await ethers.getSigners();
            const { paymaster, invoice } = await deploy([owner, supplier, buyer, owner]);

            const amount  = ethers.parseEther("2");   // below 3 ETH threshold
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(supplier).uploadInvoice(buyer.address, amount, dueDate);

            const inv = await invoice.invoices(1);
            expect(inv.buyerVerified).to.equal(true);
            expect(inv.status).to.equal("APPROVED");
            console.log("  ✅ Global threshold: 2 ETH invoice auto-approved. No buyer action needed.");
        });

        it("Buyer custom condition: invoice from specific supplier auto-approved", async function () {
            const [owner, supplier, buyer] = await ethers.getSigners();
            const { paymaster, invoice } = await deploy([owner, supplier, buyer, owner]);

            // Buyer pre-registers condition under buyer.address (EOA).
            // The invoice must also use buyer.address as the buyer field
            // so that buyerConditions[inv.buyer] lookup succeeds.
            await invoice.connect(buyer).setBuyerCondition(
                ethers.parseEther("20"),   // maxAutoApproveAmount
                supplier.address           // allowedSupplier — must be this supplier
            );
            console.log("  Buyer condition set: auto-approve ≤ 20 ETH from supplier");

            const amount  = ethers.parseEther("15");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            // Use buyer.address (EOA) as the buyer field so condition lookup matches
            await invoice.connect(supplier).uploadInvoice(buyer.address, amount, dueDate);

            const inv = await invoice.invoices(1);
            expect(inv.buyerVerified).to.equal(true);
            expect(inv.status).to.equal("APPROVED");
            console.log("  ✅ Buyer condition: 15 ETH from supplier auto-approved. No buyer signature!");
        });

        it("Buyer condition does NOT apply to different supplier → stays PENDING_BUYER", async function () {
            const [owner, supplier, buyer, financier, otherSupplier] = await ethers.getSigners();
            const { paymaster, invoice } = await deploy([owner, supplier, buyer, financier]);

            // Buyer only trusts 'supplier', not 'otherSupplier'
            await invoice.connect(buyer).setBuyerCondition(
                ethers.parseEther("20"),
                supplier.address
            );

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            // Invoice from otherSupplier — supplier check fails, stays PENDING_BUYER
            await invoice.connect(otherSupplier).uploadInvoice(buyer.address, amount, dueDate);

            const inv = await invoice.invoices(1);
            expect(inv.status).to.equal("PENDING_BUYER");
            console.log("  ✅ Invoice from unknown supplier correctly stayed PENDING_BUYER.");
        });

        it("Buyer condition with address(0) supplier: any supplier auto-approved", async function () {
            const [owner, supplier, buyer, financier, anySupplier] = await ethers.getSigners();
            const { paymaster, invoice } = await deploy([owner, supplier, buyer, financier]);

            // address(0) means "accept any supplier"
            // Invoice buyer field = buyer.address (EOA) so lookup matches
            await invoice.connect(buyer).setBuyerCondition(
                ethers.parseEther("50"),
                ethers.ZeroAddress
            );

            const amount  = ethers.parseEther("30");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(anySupplier).uploadInvoice(buyer.address, amount, dueDate);

            const inv = await invoice.invoices(1);
            expect(inv.status).to.equal("APPROVED");
            expect(inv.buyerVerified).to.equal(true);
            console.log("  ✅ Open buyer condition: 30 ETH from ANY supplier auto-approved.");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. AUTO-FINANCING — Financier pre-registers condition
    // ─────────────────────────────────────────────────────────────────────────
    describe("C. Financier Auto-Fund Conditions", function () {

        it("Financier condition met → escrow deposit triggers auto-financing instantly", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, wallet } =
                await deploy([owner, supplier, buyer, financier]);

            // Whitelist financier in Paymaster
            await paymaster.connect(owner).addUser(financier.address);
            // Whitelist buyer wallet for gasless ops
            await paymaster.connect(owner).addUser(wallet.target);

            // Financier pre-registers: "auto-fund ≤ 20 ETH for buyer's wallet"
            await invoice.connect(financier).setFinancierCondition(
                ethers.parseEther("20"),   // maxAutoFundAmount
                wallet.target              // allowedBuyer (buyer's SmartWallet)
            );
            console.log("  Financier condition set: auto-fund ≤ 20 ETH for buyer wallet");

            const amount  = ethers.parseEther("15");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 120;

            // Step 1: Upload (already approved via buyer condition or small amount)
            // Use buyer.address directly for simplicity in this test
            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            // Manually approve (since amount > 3 ETH and no buyer condition set)
            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            // Step 2: Deposit escrow — this AUTOMATICALLY triggers auto-financing
            await buyer.sendTransaction({ to: wallet.target, value: amount });

            const supplierBefore = await ethers.provider.getBalance(supplier.address);
            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });
            const supplierAfter = await ethers.provider.getBalance(supplier.address);

            const inv = await invoice.invoices(1);
            expect(inv.financierFunded).to.equal(true);
            expect(inv.status).to.equal("FINANCED");
            expect(inv.financier).to.equal(financier.address);

            const supplierGot = supplierAfter - supplierBefore;
            expect(supplierGot).to.equal((amount * 90n) / 100n);

            console.log("  ✅ Auto-financed on escrow deposit! Supplier instantly got 90%");
            console.log("  Financier recorded:", inv.financier);
        });

        it("Financier condition: any buyer (address(0)) → auto-funds any invoice in range", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, wallet } =
                await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);

            // Financier accepts any buyer up to 100 ETH
            await invoice.connect(financier).setFinancierCondition(
                ethers.parseEther("100"),
                ethers.ZeroAddress   // any buyer
            );

            // 2 ETH → auto-approved by global threshold (< 3 ETH)
            const amount  = ethers.parseEther("2");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            // Global threshold auto-approves (amount < 3 ETH)
            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const inv0 = await invoice.invoices(1);
            expect(inv0.status).to.equal("APPROVED");  // confirmed auto-approved

            await buyer.sendTransaction({ to: wallet.target, value: amount });
            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);

            const supplierBefore = await ethers.provider.getBalance(supplier.address);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });
            const supplierAfter = await ethers.provider.getBalance(supplier.address);

            const inv = await invoice.invoices(1);
            expect(inv.status).to.equal("FINANCED");
            expect(supplierAfter - supplierBefore).to.equal((amount * 90n) / 100n);
            console.log("  ✅ Financier with open condition auto-funded any buyer's invoice.");
        });

        it("Financier condition NOT met → stays ESCROWED (manual fundInvoice needed)", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, wallet } =
                await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);

            // Financier only funds ≤ 5 ETH
            await invoice.connect(financier).setFinancierCondition(
                ethers.parseEther("5"),
                ethers.ZeroAddress
            );

            const amount  = ethers.parseEther("20");   // > 5 ETH ← won't auto-fund
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            await buyer.sendTransaction({ to: wallet.target, value: amount });
            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            const inv = await invoice.invoices(1);
            expect(inv.status).to.equal("ESCROWED");   // NOT auto-financed
            expect(inv.financierFunded).to.equal(false);
            console.log("  ✅ 20 ETH invoice stayed ESCROWED — financier condition cap was 5 ETH.");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. FULLY AUTOMATED END-TO-END
    //    Buyer + Financier both set conditions → no human needed after upload
    // ─────────────────────────────────────────────────────────────────────────
    describe("D. Fully Automated End-to-End", function () {

        it("Both conditions pre-set: upload + escrow deposit = full lifecycle (no manual steps)", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, keeper } =
                await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);

            // 🔑 Buyer pre-registers condition under buyer.address (EOA)
            //    Invoice buyer field will also be buyer.address so lookup matches
            await invoice.connect(buyer).setBuyerCondition(
                ethers.parseEther("20"),
                supplier.address
            );

            // 🔑 Financier pre-registers condition; allowedBuyer = buyer.address (EOA)
            await invoice.connect(financier).setFinancierCondition(
                ethers.parseEther("20"),
                buyer.address   // ← must match the invoice buyer field
            );

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 90;

            // ── Step 1: Supplier uploads with buyer.address as buyer ──────────
            //    → auto-approved (buyerConditions[buyer.address] matches)
            await invoice.connect(supplier).uploadInvoice(buyer.address, amount, dueDate);

            let inv = await invoice.invoices(1);
            expect(inv.status).to.equal("APPROVED");
            console.log("  ✅ Auto-approved on upload:", inv.status);

            // ── Step 2: Buyer deposits escrow directly (EOA) ─────────────────
            //    → auto-financed (financierConditions[financier].allowedBuyer matches buyer.address)
            const supplierBefore = await ethers.provider.getBalance(supplier.address);
            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            // buyer EOA is the buyer on the invoice, so depositEscrow succeeds from buyer directly
            await invoice.connect(buyer).depositEscrow(1, { value: amount });
            const supplierAfter = await ethers.provider.getBalance(supplier.address);

            inv = await invoice.invoices(1);
            expect(inv.status).to.equal("FINANCED");
            expect(supplierAfter - supplierBefore).to.equal((amount * 90n) / 100n);
            console.log("  ✅ Auto-financed on escrow deposit. Supplier got 90% instantly.");

            // ── Step 3: Time travel past due date ─────────────────────────────
            await network.provider.send("evm_increaseTime", [120]);
            await network.provider.send("evm_mine");

            // ── Step 4: Anyone triggers AutoKeeper → financier gets 10% ───────
            const financierBefore = await ethers.provider.getBalance(financier.address);
            await keeper.connect(owner).releaseAll();
            const financierAfter = await ethers.provider.getBalance(financier.address);

            inv = await invoice.invoices(1);
            expect(inv.isPaid).to.equal(true);
            expect(inv.status).to.equal("PAID");
            expect(financierAfter - financierBefore).to.equal((amount * 10n) / 100n);

            console.log("  ✅ AutoKeeper released 10% to financier on due date.");
            console.log("  🎉 FULLY AUTOMATED — zero manual steps after initial setup!\n");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. AUTOKEEPER — permissionless due-date release
    // ─────────────────────────────────────────────────────────────────────────
    describe("E. AutoKeeper", function () {

        it("keeper.checkAndRelease(ids) releases specific past-due invoices", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, keeper, wallet } =
                await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            await buyer.sendTransaction({ to: wallet.target, value: amount });
            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            await invoice.connect(financier).fundInvoice(1);

            await network.provider.send("evm_increaseTime", [90]);
            await network.provider.send("evm_mine");

            await keeper.connect(supplier).checkAndRelease([1]);   // supplier triggers keeper

            const inv = await invoice.invoices(1);
            expect(inv.isPaid).to.equal(true);
            console.log("  ✅ checkAndRelease([1]) released invoice #1 — called by supplier (permissionless)");
        });

        it("keeper.releaseAll() skips not-due invoices silently", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, keeper, wallet } =
                await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 3600;   // 1 hour in future — don't travel

            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            await buyer.sendTransaction({ to: wallet.target, value: amount });
            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            await invoice.connect(financier).fundInvoice(1);

            // Call keeper WITHOUT time travel — should NOT release
            await keeper.releaseAll();   // should not revert

            const inv = await invoice.invoices(1);
            expect(inv.isPaid).to.equal(false);
            console.log("  ✅ releaseAll() skipped future-due invoice silently (no revert).");
        });

        it("keeper.releaseAll() skips already-paid invoices silently", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, keeper, wallet } =
                await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            await buyer.sendTransaction({ to: wallet.target, value: amount });
            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            await invoice.connect(financier).fundInvoice(1);

            await network.provider.send("evm_increaseTime", [90]);
            await network.provider.send("evm_mine");

            // First release — succeeds
            await invoice.releaseDueDatePayment(1);

            // Second releaseAll() — should silently skip the already-paid invoice
            await keeper.releaseAll();   // must NOT revert

            const inv = await invoice.invoices(1);
            expect(inv.isPaid).to.equal(true);
            console.log("  ✅ releaseAll() silently skipped already-paid invoice.");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. GASLESS PROOF — buyer with 0 ETH can still approve
    // ─────────────────────────────────────────────────────────────────────────
    describe("F. Gasless Proof", function () {

        it("Buyer wallet with 0 ETH can approve invoice via Bundler → EntryPoint → Paymaster", async function () {
            const [owner, supplier, , financier, gaslessBuyer] = await ethers.getSigners();
            const { entry, paymaster, invoice, bundler, wallet } =
                await deploy([owner, supplier, gaslessBuyer, financier]);

            // Whitelist buyer wallet
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            // Supplier uploads using buyer wallet as buyer
            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            // gaslessBuyer signs off-chain — spends 0 ETH on gas
            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            const op = await buildGaslessOp(gaslessBuyer, wallet, invoice, approveData, paymaster.target);

            const pmDepositBefore = await paymaster.getDeposit();

            // Bundler submits on-chain — Paymaster covers gas
            await bundler.connect(owner).bundle([op]);

            const pmDepositAfter = await paymaster.getDeposit();
            const inv = await invoice.invoices(1);

            expect(inv.buyerVerified).to.equal(true);
            expect(inv.status).to.equal("APPROVED");
            expect(pmDepositAfter).to.be.lessThan(pmDepositBefore);   // gas was deducted from PM

            console.log("  ✅ gaslessBuyer paid 0 gas. Paymaster deposit reduced by:",
                ethers.formatEther(pmDepositBefore - pmDepositAfter), "ETH");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. SECURITY / EDGE CASES
    // ─────────────────────────────────────────────────────────────────────────
    describe("G. Security & Edge Cases", function () {

        it("Rejects non-whitelisted financier calling fundInvoice()", async function () {
            const [owner, supplier, buyer, financier, stranger] = await ethers.getSigners();
            const { paymaster, invoice, wallet } = await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            await expect(
                invoice.connect(stranger).fundInvoice(1)
            ).to.be.revertedWithCustomError(invoice, "NotWhitelistedFinancier");
            console.log("  ✅ Stranger rejected by NotWhitelistedFinancier.");
        });

        it("Rejects setFinancierCondition() from non-whitelisted address", async function () {
            const [owner, supplier, buyer, , rogue] = await ethers.getSigners();
            const { invoice } = await deploy([owner, supplier, buyer, owner]);

            await expect(
                invoice.connect(rogue).setFinancierCondition(ethers.parseEther("10"), ethers.ZeroAddress)
            ).to.be.revertedWith("Not a whitelisted financier");
            console.log("  ✅ Non-whitelisted rogue cannot register financier condition.");
        });

        it("Paymaster rejects gasless ops from non-whitelisted wallets", async function () {
            const [owner, supplier, buyer, financier, rogue] = await ethers.getSigners();
            const { entry, paymaster, invoice, bundler } = await deploy([owner, supplier, buyer, financier]);

            const SW = await ethers.getContractFactory("SmartWallet");
            const rogueWallet = await SW.deploy(rogue.address, entry.target, paymaster.target);
            await rogueWallet.waitForDeployment();

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(supplier).uploadInvoice(rogueWallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            const op = await buildGaslessOp(rogue, rogueWallet, invoice, approveData, paymaster.target);

            await expect(bundler.bundle([op])).to.be.reverted;
            console.log("  ✅ Rogue wallet correctly rejected by EntryPoint/Paymaster.");
        });

        it("Cannot release payment before due date", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, wallet } = await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 3600;   // 1 hour away

            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            await invoice.connect(financier).fundInvoice(1);

            await expect(
                invoice.releaseDueDatePayment(1)
            ).to.be.revertedWithCustomError(invoice, "TooEarly");
            console.log("  ✅ TooEarly error thrown before due date.");
        });

        it("Cannot double-pay the same invoice", async function () {
            const [owner, supplier, buyer, financier] = await ethers.getSigners();
            const { paymaster, invoice, wallet } = await deploy([owner, supplier, buyer, financier]);

            await paymaster.connect(owner).addUser(financier.address);
            await paymaster.connect(owner).addUser(wallet.target);

            const amount  = ethers.parseEther("10");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await invoice.connect(supplier).uploadInvoice(wallet.target, amount, dueDate);

            const approveData = invoice.interface.encodeFunctionData("approveByBuyer", [1]);
            await wallet.connect(buyer).execute(invoice.target, approveData);

            const escrowData = invoice.interface.encodeFunctionData("depositEscrow", [1]);
            await wallet.connect(buyer).execute(invoice.target, escrowData, { value: amount });

            await invoice.connect(financier).fundInvoice(1);

            await network.provider.send("evm_increaseTime", [90]);
            await network.provider.send("evm_mine");

            await invoice.releaseDueDatePayment(1);

            await expect(
                invoice.releaseDueDatePayment(1)
            ).to.be.revertedWithCustomError(invoice, "AlreadyPaid");
            console.log("  ✅ AlreadyPaid error prevents double-payment.");
        });

        it("Buyer condition event is emitted correctly", async function () {
            const [owner, supplier, buyer] = await ethers.getSigners();
            const { invoice } = await deploy([owner, supplier, buyer, owner]);

            await expect(
                invoice.connect(buyer).setBuyerCondition(ethers.parseEther("10"), supplier.address)
            ).to.emit(invoice, "BuyerConditionSet")
                .withArgs(buyer.address, ethers.parseEther("10"), supplier.address);
            console.log("  ✅ BuyerConditionSet event emitted correctly.");
        });

        it("AutoApproved event is emitted when global threshold triggers", async function () {
            const [owner, supplier, buyer] = await ethers.getSigners();
            const { invoice } = await deploy([owner, supplier, buyer, owner]);

            const amount  = ethers.parseEther("1");
            const block   = await ethers.provider.getBlock("latest");
            const dueDate = block.timestamp + 60;

            await expect(
                invoice.connect(supplier).uploadInvoice(buyer.address, amount, dueDate)
            ).to.emit(invoice, "AutoApproved")
                .withArgs(1, "global_threshold_below_3eth");
            console.log("  ✅ AutoApproved event emitted with correct reason.");
        });
    });
});
