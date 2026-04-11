const { ethers } = require("hardhat");

async function main() {
  const [owner, supp, buy, , , fin] = await ethers.getSigners();
  const cfg = require("../frontend/deployed.json");

  const abi = [
    "function uploadInvoice(address,uint256,uint256)",
    "function approveByBuyer(uint256)",
    "function fundInvoice(uint256)",
    "function releaseDueDatePayment(uint256)",
    "function counter() view returns (uint256)",
    "function escrowBalance(uint256) view returns (uint256)",
    "function depositFor(address) payable",
  ];
  const ic = new ethers.Contract(cfg.contracts.InvoiceContract, abi);

  const amt = ethers.parseEther("4");
  const block = await ethers.provider.getBlock("latest");
  const due = block.timestamp + 120;

  const [s0, b0, f0] = await Promise.all([
    ethers.provider.getBalance(supp.address),
    ethers.provider.getBalance(buy.address),
    ethers.provider.getBalance(fin.address),
  ]);

  console.log("=== 4 ETH ESCROW TEST ===\n");

  // 1. Upload
  let tx = await ic.connect(supp).uploadInvoice(buy.address, amt, due);
  await tx.wait();
  const id = await ic.connect(supp).counter();
  console.log(`1. Uploaded invoice #${id}`);

  // 2. Buyer deposits + approves
  tx = await ic.connect(buy).depositFor(buy.address, { value: amt });
  await tx.wait();
  console.log("2. Buyer deposited 4 ETH");

  tx = await ic.connect(buy).approveByBuyer(id);
  await tx.wait();
  const escAfterApprove = await ic.connect(buy).escrowBalance(id);
  console.log(`3. Approved. escrowBalance = ${ethers.formatEther(escAfterApprove)} ETH`);

  // 3. Financier deposits + funds
  const finDeposit = (amt * 90n) / 100n;
  tx = await ic.connect(fin).depositFor(fin.address, { value: finDeposit });
  await tx.wait();
  console.log(`4. Financier deposited ${ethers.formatEther(finDeposit)} ETH`);

  tx = await ic.connect(fin).fundInvoice(id);
  await tx.wait();
  const escAfterFund = await ic.connect(fin).escrowBalance(id);
  console.log(`5. Funded. escrowBalance = ${ethers.formatEther(escAfterFund)} ETH`);
  if (escAfterFund === amt) {
    console.log("   ✅ CORRECT: Full 4.0 ETH remains in escrow!");
  } else {
    console.log("   ❌ BUG: escrow was reduced!");
  }

  // 4. Time warp + release
  await ethers.provider.send("evm_increaseTime", [300]);
  await ethers.provider.send("evm_mine", []);

  const fBefore = await ethers.provider.getBalance(fin.address);
  tx = await ic.connect(fin).releaseDueDatePayment(id);
  const receipt = await tx.wait();
  const gasUsed = receipt.gasUsed * receipt.gasPrice;
  const fAfter = await ethers.provider.getBalance(fin.address);
  const received = fAfter - fBefore + gasUsed;
  console.log(`6. Released! Financier received: ${ethers.formatEther(received)} ETH`);
  if (received >= ethers.parseEther("3.9")) {
    console.log("   ✅ CORRECT: Financier got full escrow (~4.0 ETH)!");
  } else {
    console.log("   ❌ BUG: Financier only got " + ethers.formatEther(received));
  }

  // Final
  const [s2, b2, f2] = await Promise.all([
    ethers.provider.getBalance(supp.address),
    ethers.provider.getBalance(buy.address),
    ethers.provider.getBalance(fin.address),
  ]);
  console.log("\n=== FINAL NET ===");
  console.log(`Supplier:  ${ethers.formatEther(s2 - s0)} (expected +3.6)`);
  console.log(`Buyer:     ${ethers.formatEther(b2 - b0)} (expected ~-4.0)`);
  console.log(`Financier: ${ethers.formatEther(f2 - f0)} (expected ~+0.4 profit)`);
}

main().catch(console.error);
