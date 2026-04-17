const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// Models
const User = require("./models/User");
const Event = require("./models/Event");
const biddingService = require("./services/biddingService");

// Config
const PORT = process.env.PORT || 3003;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/invoice-finance-merged";
const RPC_URL = "http://127.0.0.1:8545";

// Init App
const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/voting", require("./routes/voting"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/invoices", require("./routes/invoices"));

// ─── Blockchain Sync Logic (Ported from friend's server.js) ───────────────────
const configPath = path.join(__dirname, "..", "frontend", "deployed.json");
let CONFIG = {};
if (fs.existsSync(configPath)) {
    CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));
}

const EVENT_ABI = [
  "event InvoiceUploaded(uint256 indexed id, address supplier, address buyer, uint256 amount)",
  "event AutoApproved(uint256 indexed id, string reason)",
  "event BuyerApproved(uint256 indexed id)",
  "event EscrowDeposited(uint256 indexed id, uint256 amount)",
  "event Financed(uint256 indexed id, address indexed financier, uint256 supplierPayout)",
  "event Paid(uint256 indexed id, address indexed financier, uint256 financierPayout)",
  "function invoices(uint256) view returns (uint256 id, address supplier, address buyer, uint256 amount, uint256 dueDate, bool buyerVerified, bool escrowLocked, bool financierFunded, bool isPaid, string status, address financier)",
];

async function startEventListener() {
    if (!CONFIG.contracts) return;
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(CONFIG.contracts.InvoiceContract, EVENT_ABI, provider);

    contract.on("*", async (event) => {
        try {
            const log = event.log || event;
            const block = await provider.getBlock(log.blockNumber);
            const ts = new Date(Number(block.timestamp) * 1000);
            
            const record = {
                eventType: log.eventName || log.fragment?.name,
                txHash: log.transactionHash,
                blockNumber: log.blockNumber,
                logIndex: log.index ?? log.logIndex ?? 0,
                timestamp: ts,
                invoiceId: log.args?.[0] ? Number(log.args[0]) : null,
                details: `Blockchain Event: ${log.eventName}`,
            };

            await Event.findOneAndUpdate(
                { txHash: record.txHash, logIndex: record.logIndex },
                record,
                { upsert: true }
            );
            console.log(`[BC] Event stored: ${record.eventType}`);
        } catch (err) {
            console.error("EventListener error:", err.message);
        }
    });

    console.log("✅ Listening for blockchain events...");
}

// ─── Boot ────────────────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log(`✅ MongoDB connected: ${MONGO_URI}`);
        startEventListener();
        biddingService.startAutoSelection();
        app.listen(PORT, () => {
            console.log(`✅ Backend server: http://localhost:${PORT}`);
        });
    })
    .catch(err => console.error("❌ MongoDB connection error:", err));
