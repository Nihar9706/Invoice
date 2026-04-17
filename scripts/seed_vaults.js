const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    const configPath = path.join(__dirname, "..", "frontend", "deployed.json");
    const deployed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const [owner] = await ethers.getSigners();

    const abi = [
        "function depositFor(address beneficiary) external payable",
        "function deposits(address) view returns (uint256)"
    ];
    
    const contract = new ethers.Contract(deployed.contracts.InvoiceContract, abi, owner);
    const amount = ethers.parseEther("100");

    console.log("─── Seeding Contract Deposits (100 ETH each) ───");

    // Seed Suppliers, Buyers, and Financiers (both EOA and SmartWallet)
    const groups = [
        { name: "Suppliers", addrs: [...deployed.roles.suppliers, ...deployed.contracts.SupplierWallets] },
        { name: "Buyers",    addrs: [...deployed.roles.buyers,    ...deployed.contracts.BuyerWallets] },
        { name: "Financiers",addrs: [...deployed.roles.financiers, ...deployed.contracts.FinancierWallets] }
    ];

    for (const group of groups) {
        console.log(`\n🔹 Seeding ${group.name}:`);
        for (const addr of group.addrs) {
            const currentBal = await contract.deposits(addr);
            if (currentBal < amount) {
                const diff = amount - currentBal;
                console.log(`   ⬆️ Depositing ${ethers.formatEther(diff)} ETH for ${addr}...`);
                const tx = await contract.depositFor(addr, { value: diff });
                await tx.wait();
            } else {
                console.log(`   ✅ ${addr} already has sufficient balance.`);
            }
        }
    }

    console.log("\n✅ All accounts seeded successfully!");
}

main().catch(console.error);
