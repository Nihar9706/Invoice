const ethers = require("ethers");
const fs = require("fs");

async function main() {
    const CONFIG = JSON.parse(fs.readFileSync("frontend/deployed.json", "utf8"));
    const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
    
    // Hardhat Account #1 (Supplier)
    const privKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const wallet = new ethers.Wallet(privKey, provider);
    
    const invoiceContract = new ethers.Contract(
        CONFIG.contracts.InvoiceContract,
        [
            "function uploadInvoice(address,uint256,uint256) external",
            "error NotBuyer()",
            "error AlreadyApproved()",
            "error NotApproved()",
            "error IncorrectAmount()",
            "error EscrowNotLocked()",
            "error TooEarly()",
            "error NotFunded()",
            "error AlreadyPaid()",
            "error NotWhitelistedFinancier()",
            "error InsufficientDeposit()"
        ],
        wallet
    );

    console.log("Attempting uploadInvoice...");
    try {
        const buyer = CONFIG.roles.buyers[0];
        const amount = ethers.parseEther("1");
        const dueDate = Math.floor(Date.now() / 1000) + 3600;
        
        // This won't use AA, just direct call to get the revert reason clearly
        const tx = await invoiceContract.uploadInvoice(buyer, amount, dueDate);
        await tx.wait();
        console.log("Upload successful!");
    } catch (err) {
        console.log("-----------------------------------------");
        console.log("REVERT REASON DETECTED:");
        console.log(err);
        if (err.data) {
            console.log("Hex Data:", err.data);
        }
        console.log("-----------------------------------------");
    }
}

main();
