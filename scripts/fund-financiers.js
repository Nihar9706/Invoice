const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const configPath = path.join(__dirname, "../frontend/deployed.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const [owner] = await ethers.getSigners();
  console.log("Using account:", owner.address);

  const InvoiceContract = await ethers.getContractAt("InvoiceContract", config.contracts.InvoiceContract);
  
  const financiers = config.roles.financiers;
  const financierWallets = config.contracts.FinancierWallets;

  const targets = [...financiers, ...financierWallets];
  const amount = ethers.parseEther("1000");

  console.log("Depositing 1000 ETH for each financier address...");

  for (const target of targets) {
    if (!target) continue;
    console.log(`⏳ Depositing for ${target}...`);
    try {
      const tx = await InvoiceContract.depositFor(target, { value: amount });
      await tx.wait();
      const bal = await InvoiceContract.deposits(target);
      console.log(`✅ Success! New balance for ${target}: ${ethers.formatEther(bal)} ETH`);
    } catch (e) {
      console.error(`❌ Failed to deposit for ${target}:`, e.message);
    }
  }

  console.log("\n🚀 All financiers funded with 1000 ETH in deposits!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
