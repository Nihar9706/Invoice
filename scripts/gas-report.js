const { ethers } = require("hardhat");

async function main() {
  const [owner, supplier, buyer, , , financier] = await ethers.getSigners();

  console.log("\nGAS COST REPORT\n");

  const results = [];

  function record(name, receipt) {
    const gas = Number(receipt.gasUsed);
    results.push({ name, gas });
    console.log(name + " : " + gas + " gas");
  }

  // Deploy Contracts
  console.log("\nDEPLOYMENT GAS\n");

  const EP = await ethers.getContractFactory("EntryPoint");
  const entryPoint = await EP.deploy();
  let r = await entryPoint.deploymentTransaction().wait();
  record("Deploy EntryPoint", r);

  const backendSigner = ethers.Wallet.createRandom();
  const PM = await ethers.getContractFactory("Paymaster");
  const paymaster = await PM.deploy(entryPoint.target, backendSigner.address);
  r = await paymaster.deploymentTransaction().wait();
  record("Deploy Paymaster (Verifying Oracle)", r);

  const IC = await ethers.getContractFactory("InvoiceContract");
  const invoice = await IC.deploy(paymaster.target);
  r = await invoice.deploymentTransaction().wait();
  record("Deploy InvoiceContract", r);

  const AK = await ethers.getContractFactory("AutoKeeper");
  const autoKeeper = await AK.deploy(invoice.target);
  r = await autoKeeper.deploymentTransaction().wait();
  record("Deploy AutoKeeper", r);

  const BD = await ethers.getContractFactory("Bundler");
  const bundler = await BD.deploy(entryPoint.target);
  r = await bundler.deploymentTransaction().wait();
  record("Deploy Bundler", r);

  const SW = await ethers.getContractFactory("SmartWallet");
  const supplierWallet = await SW.deploy(
    supplier.address,
    entryPoint.target,
    paymaster.target
  );
  r = await supplierWallet.deploymentTransaction().wait();
  record("Deploy SmartWallet", r);

  // Setup
  console.log("\nSETUP GAS\n");

  let tx = await paymaster
    .connect(owner)
    .depositToEntryPoint({ value: ethers.parseEther("10") });
  r = await tx.wait();
  record("Paymaster.depositToEntryPoint", r);

  // Off-chain whitelisting doesn't cost any gas!
  // Removed paymaster.connect(owner).addUser calls entirely!
  console.log("   (On-Chain Whitelisting has been eliminated)");

  // Manual Flow
  console.log("\nMANUAL FLOW\n");

  const amount = ethers.parseEther("3");
  const dueDate = Math.floor(Date.now() / 1000) + 60;

  tx = await invoice
    .connect(supplier)
    .uploadInvoice(buyer.address, amount, dueDate);
  r = await tx.wait();
  record("uploadInvoice", r);

  tx = await invoice.connect(buyer).approveByBuyer(1);
  r = await tx.wait();
  record("approveByBuyer", r);

  tx = await invoice
    .connect(buyer)
    .depositEscrow(1, { value: amount });
  r = await tx.wait();
  record("depositEscrow", r);

  tx = await invoice
    .connect(financier)
    .setFinancierCondition(ethers.parseEther("10"), ethers.ZeroAddress);
  r = await tx.wait();
  record("setFinancierCondition", r);

  tx = await invoice
    .connect(financier)
    .depositFunds({ value: ethers.parseEther("5") });
  r = await tx.wait();
  record("depositFunds (financier)", r);

  tx = await invoice.connect(financier).fundInvoice(1);
  r = await tx.wait();
  record("fundInvoice", r);

  await ethers.provider.send("evm_increaseTime", [120]);
  await ethers.provider.send("evm_mine");

  tx = await invoice.connect(owner).releaseDueDatePayment(1);
  r = await tx.wait();
  record("releaseDueDatePayment", r);

  // Full Auto Flow
  console.log("\nFULL AUTO FLOW\n");

  tx = await invoice
    .connect(buyer)
    .depositFunds({ value: ethers.parseEther("5") });
  r = await tx.wait();
  record("depositFunds (buyer)", r);

  tx = await invoice
    .connect(buyer)
    .setBuyerCondition(ethers.parseEther("10"), ethers.ZeroAddress);
  r = await tx.wait();
  record("setBuyerCondition", r);

  tx = await invoice
    .connect(financier)
    .depositFunds({ value: ethers.parseEther("5") });
  r = await tx.wait();
  record("depositFunds (financier topup)", r);

  const dueDate2 = Math.floor(Date.now() / 1000) + 300;

  tx = await invoice
    .connect(supplier)
    .uploadInvoice(buyer.address, ethers.parseEther("2"), dueDate2);
  r = await tx.wait();
  record("uploadInvoice (auto flow)", r);

  // Utility
  console.log("\nUTILITY\n");

  tx = await invoice
    .connect(buyer)
    .depositFunds({ value: ethers.parseEther("1") });
  r = await tx.wait();
  record("depositFunds", r);

  tx = await invoice
    .connect(buyer)
    .withdrawFunds(ethers.parseEther("0.5"));
  r = await tx.wait();
  record("withdrawFunds", r);

  tx = await autoKeeper.connect(owner).releaseAll();
  r = await tx.wait();
  record("releaseAll", r);

  // Summary
  console.log("\nSUMMARY\n");

  let totalGas = 0;
  results.forEach(({ name, gas }) => {
    totalGas += gas;
    console.log(name + " : " + gas);
  });

  console.log("\nTOTAL GAS USED: " + totalGas + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });