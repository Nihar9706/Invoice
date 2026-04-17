const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
    const deployed = JSON.parse(fs.readFileSync("./frontend/deployed.json", "utf8"));
    const abi = [
        "function deposits(address) view returns (uint256)",
        "function invoices(uint256) view returns (uint256 id, address supplier, address buyer, uint256 amount, uint256 dueDate, bool buyerVerified, bool escrowLocked, bool financierFunded, bool isPaid, string status, address financier)"
    ];
    
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const contract = new ethers.Contract(deployed.contracts.InvoiceContract, abi, provider);

    console.log("--- Contract State ---");
    const invoice1 = await contract.invoices(1);
    console.log(`Invoice #1 Amount: ${ethers.formatEther(invoice1.amount)} ETH`);
    
    for (let i = 0; i < deployed.contracts.FinancierWallets.length; i++) {
        const sw = deployed.contracts.FinancierWallets[i];
        const bal = await contract.deposits(sw);
        console.log(`Financier SW ${sw}: ${ethers.formatEther(bal)} ETH`);
    }
    
    // Also check the EOAs just in case
    for (let i = 0; i < deployed.roles.financiers.length; i++) {
        const eoa = deployed.roles.financiers[i];
        const bal = await contract.deposits(eoa);
        console.log(`Financier EOA ${eoa}: ${ethers.formatEther(bal)} ETH`);
    }
}

main().catch(console.error);
