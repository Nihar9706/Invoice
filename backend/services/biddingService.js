const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const Bid = require("../models/Bid");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

class BiddingService {
    constructor() {
        this.RPC_URL = "http://127.0.0.1:8545";
        this.configPath = path.join(__dirname, "..", "..", "frontend", "deployed.json");
    }

    startAutoSelection() {
        console.log("⏱️  Bidding Auto-Selection Service started (checking every 10 seconds)");
        setInterval(async () => {
            try {
                await this.processExpiredBiddings();
            } catch (error) {
                console.error("❌ Error in bidding auto-selection job:", error);
            }
        }, 10 * 1000); 
    }

    async processExpiredBiddings() {
        const now = new Date();
        // Find invoices in BIDDING status that have passed their timeout
        const expiredInvoices = await Invoice.find({
            status: "BIDDING",
            biddingTimeout: { $lte: now, $ne: null }
        }).populate("supplier");

        for (const invoice of expiredInvoices) {
            console.log(`⏱️  Bidding timeout reached for Invoice #${invoice.invoiceId}. Finalizing...`);
            
            const bids = await Bid.find({ invoiceId: invoice.invoiceId, status: "Pending" }).populate("financer");
            
            if (bids.length === 0) {
                console.log(`ℹ️  No bids for Invoice #${invoice.invoiceId}. Extending auction.`);
                invoice.biddingTimeout = new Date(Date.now() + 5 * 60 * 1000); // Give 5 more mins
                await invoice.save();
                continue;
            }

            // Best Bid Logic: Lowest Interest, then Highest Advance
            bids.sort((a, b) => {
                if (a.interestRate !== b.interestRate) {
                    return a.interestRate - b.interestRate; // Ascending interest (lowest wins)
                }
                return b.advanceRate - a.advanceRate; // Descending advance (highest wins)
            });

            const winner = bids[0];
            const losers = bids.slice(1);

            console.log(`\n💎 ELECTING WINNER for Invoice #${invoice.invoiceId}`);
            console.log(`   Criteria: Lowest Interest (Primary), Highest Advance (Secondary)`);
            console.log(`   🏆 Winner: ${winner.financerAddress}`);
            console.log(`      Interest: ${winner.interestRate}% (Ranked #1)`);
            console.log(`      Advance:  ${winner.advanceRate}%`);
            if (losers.length > 0) {
                console.log(`   ❌ Rejected: ${losers.length} other bid(s)`);
            }
            console.log("");

            try {
                const success = await this.executeOnChainAcceptance(invoice, winner);
                if (success) {
                    winner.status = "Accepted";
                    await winner.save();
                    
                    await Bid.updateMany(
                        { invoiceId: invoice.invoiceId, _id: { $ne: winner._id } },
                        { status: "Rejected" }
                    );

                    invoice.status = "FINANCED";
                    invoice.financer = winner.financer;
                    invoice.financerAddress = winner.financerAddress;
                    invoice.advanceRate = winner.advanceRate;
                    invoice.interestRate = winner.interestRate;
                    invoice.biddingTimeout = null;
                    await invoice.save();
                    
                    console.log(`✅ Auto-Elect complete for Invoice #${invoice.invoiceId}`);
                }
            } catch (err) {
                console.error(`❌ Auto-Elect failed for #${invoice.invoiceId}:`, err.message);
            }
        }
    }

    async executeOnChainAcceptance(invoice, winner) {
        if (!fs.existsSync(this.configPath)) return false;
        const CONFIG = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        
        const provider = new ethers.JsonRpcProvider(this.RPC_URL);

        // Use the deployer/owner account (Hardhat Account #0) to call acceptBid
        // The contract now allows owner OR supplier to accept bids
        const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        const signer = new ethers.Wallet(DEPLOYER_KEY, provider);

        console.log(`   🔑 Using owner account: ${signer.address}`);

        const contract = new ethers.Contract(
            CONFIG.contracts.InvoiceContract,
            ["function acceptBid(uint256 id, address winningFinancier, uint256 _advanceRate, uint256 _interestRate) external"],
            signer
        );

        const tx = await contract.acceptBid(
            invoice.invoiceId, 
            winner.financerAddress,
            winner.advanceRate,
            winner.interestRate
        );
        await tx.wait();
        
        console.log(`   ✅ On-chain acceptBid TX confirmed for Invoice #${invoice.invoiceId}`);
        return true;
    }
}

module.exports = new BiddingService();
