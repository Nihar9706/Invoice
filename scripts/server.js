/**
 * scripts/server.js — MongoDB-backed history server
 *
 * Listens to InvoiceContract blockchain events, stores them in MongoDB,
 * and serves a REST API for the frontend History tab.
 *
 * Usage:  node scripts/server.js
 * Port:   3002
 */

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const Event = require("./models/Event");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = 3002;
const MONGO_URI = "mongodb://localhost:27017/invoice-finance";
const RPC_URL = "http://127.0.0.1:8545";

// ─── Load deployed config ────────────────────────────────────────────────────
const configPath = path.join(__dirname, "..", "frontend", "deployed.json");
if (!fs.existsSync(configPath)) {
  console.error("❌ deployed.json not found! Deploy contracts first.");
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));

// ─── ABI ─────────────────────────────────────────────────────────────────────
const EVENT_ABI = [
  "event InvoiceUploaded(uint256 indexed id, address supplier, address buyer, uint256 amount)",
  "event AutoApproved(uint256 indexed id, string reason)",
  "event BuyerApproved(uint256 indexed id)",
  "event EscrowDeposited(uint256 indexed id, uint256 amount)",
  "event AutoFinanced(uint256 indexed id, address indexed financier, uint256 supplierPayout)",
  "event Financed(uint256 indexed id, address indexed financier, uint256 supplierPayout)",
  "event Paid(uint256 indexed id, address indexed financier, uint256 financierPayout)",
  "event BuyerConditionSet(address indexed buyer, uint256 maxAmount, address allowedSupplier)",
  "event FinancierConditionSet(address indexed financier, uint256 maxAmount, address allowedBuyer)",
  "event Deposited(address indexed user, uint256 amount, uint256 newBalance)",
  "event Withdrawn(address indexed user, uint256 amount, uint256 newBalance)",
  // Read functions to look up invoice details
  "function invoices(uint256) view returns (uint256 id, address supplier, address buyer, uint256 amount, uint256 dueDate, bool buyerVerified, bool escrowLocked, bool financierFunded, bool isPaid, string status, address financier)",
];

// ─── State ───────────────────────────────────────────────────────────────────
let provider, contract;

// ─── Address helpers ─────────────────────────────────────────────────────────
function resolveRole(addr) {
  if (!addr) return null;
  const a = addr.toLowerCase();
  const roles = CONFIG.roles || {};
  const contracts = CONFIG.contracts || {};

  if (a === roles.supplier?.toLowerCase() || a === contracts.SupplierSmartWallet?.toLowerCase()) return "Supplier";
  if (a === roles.buyer?.toLowerCase() || a === contracts.BuyerSmartWallet?.toLowerCase()) return "Buyer";
  if (a === roles.financier?.toLowerCase() || a === contracts.FinancierSmartWallet?.toLowerCase()) return "Financier";
  return null;
}

function truncate(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

// Look up invoice on-chain to get all three role addresses
async function getInvoiceParties(invoiceId) {
  try {
    const inv = await contract.invoices(invoiceId);
    return {
      supplier: inv.supplier || inv[1],
      buyer: inv.buyer || inv[2],
      financier: (inv.financier || inv[10]) !== ethers.ZeroAddress ? (inv.financier || inv[10]) : null,
    };
  } catch (err) {
    return { supplier: null, buyer: null, financier: null };
  }
}

// Determine which role field to use for a Deposited/Withdrawn address
function classifyAddress(addr) {
  const role = resolveRole(addr);
  if (role === "Supplier") return { supplier: addr };
  if (role === "Buyer") return { buyer: addr };
  if (role === "Financier") return { financier: addr };
  // Unknown address — store in all fields so it always appears
  return { supplier: addr, buyer: addr, financier: addr };
}

// ─── Parse events into DB records ────────────────────────────────────────────
async function parseEvent(log, block) {
  const name = log.eventName || log.fragment?.name;
  const args = log.args;
  const ts = new Date(Number(block.timestamp) * 1000);

  const base = {
    eventType: name,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.index ?? log.logIndex ?? 0,
    timestamp: ts,
  };

  switch (name) {
    case "InvoiceUploaded":
      return {
        ...base,
        invoiceId: Number(args[0]),
        supplier: args[1],
        buyer: args[2],
        amount: ethers.formatEther(args[3]),
        details: `Invoice #${args[0]} uploaded by ${resolveRole(args[1]) || truncate(args[1])} → ${resolveRole(args[2]) || truncate(args[2])} for ${ethers.formatEther(args[3])} ETH`,
      };

    case "BuyerApproved": {
      const parties = await getInvoiceParties(Number(args[0]));
      return {
        ...base,
        invoiceId: Number(args[0]),
        supplier: parties.supplier,
        buyer: parties.buyer,
        financier: parties.financier,
        details: `Invoice #${args[0]} approved by ${resolveRole(parties.buyer) || "Buyer"}`,
      };
    }

    case "AutoApproved": {
      const parties = await getInvoiceParties(Number(args[0]));
      return {
        ...base,
        invoiceId: Number(args[0]),
        supplier: parties.supplier,
        buyer: parties.buyer,
        financier: parties.financier,
        details: `Invoice #${args[0]} auto-approved (${args[1]})`,
      };
    }

    case "EscrowDeposited": {
      const parties = await getInvoiceParties(Number(args[0]));
      return {
        ...base,
        invoiceId: Number(args[0]),
        supplier: parties.supplier,
        buyer: parties.buyer,
        financier: parties.financier,
        amount: ethers.formatEther(args[1]),
        details: `${ethers.formatEther(args[1])} ETH escrowed for Invoice #${args[0]} by ${resolveRole(parties.buyer) || "Buyer"}`,
      };
    }

    case "AutoFinanced":
      // Contract emits BOTH AutoFinanced + Financed for the same action — skip this duplicate
      return null;

    case "Financed": {
      const parties = await getInvoiceParties(Number(args[0]));
      return {
        ...base,
        invoiceId: Number(args[0]),
        supplier: parties.supplier,
        buyer: parties.buyer,
        financier: args[1],
        amount: ethers.formatEther(args[2]),
        details: `Invoice #${args[0]} financed by ${resolveRole(args[1]) || truncate(args[1])} — ${resolveRole(parties.supplier) || "Supplier"} received ${ethers.formatEther(args[2])} ETH`,
      };
    }

    case "Paid": {
      const parties = await getInvoiceParties(Number(args[0]));
      return {
        ...base,
        invoiceId: Number(args[0]),
        supplier: parties.supplier,
        buyer: parties.buyer,
        financier: args[1],
        amount: ethers.formatEther(args[2]),
        details: `Invoice #${args[0]} paid — ${resolveRole(args[1]) || "Financier"} received ${ethers.formatEther(args[2])} ETH`,
      };
    }

    case "Deposited": {
      const addrFields = classifyAddress(args[0]);
      return {
        ...base,
        ...addrFields,
        amount: ethers.formatEther(args[1]),
        details: `${resolveRole(args[0]) || truncate(args[0])} deposited ${ethers.formatEther(args[1])} ETH (balance: ${ethers.formatEther(args[2])})`,
      };
    }

    case "Withdrawn": {
      const addrFields = classifyAddress(args[0]);
      return {
        ...base,
        ...addrFields,
        amount: ethers.formatEther(args[1]),
        details: `${resolveRole(args[0]) || truncate(args[0])} withdrew ${ethers.formatEther(args[1])} ETH (balance: ${ethers.formatEther(args[2])})`,
      };
    }

    case "BuyerConditionSet":
      return {
        ...base,
        buyer: args[0],
        amount: ethers.formatEther(args[1]),
        details: `${resolveRole(args[0]) || "Buyer"} set auto-approve: max ${ethers.formatEther(args[1])} ETH, supplier ${args[2] === ethers.ZeroAddress ? "any" : truncate(args[2])}`,
      };

    case "FinancierConditionSet":
      return {
        ...base,
        financier: args[0],
        amount: ethers.formatEther(args[1]),
        details: `${resolveRole(args[0]) || "Financier"} set auto-fund: max ${ethers.formatEther(args[1])} ETH, buyer ${args[2] === ethers.ZeroAddress ? "any" : truncate(args[2])}`,
      };

    default:
      return { ...base, details: `Unknown event: ${name}` };
  }
}

// ─── Sync: scan all past blocks for events ───────────────────────────────────
async function syncPastEvents() {
  console.log("🔄 Syncing past events from blockchain...");
  const currentBlock = await provider.getBlockNumber();

  const logs = await contract.queryFilter("*", 0, currentBlock);
  let inserted = 0;
  let skipped = 0;

  for (const log of logs) {
    try {
      const block = await provider.getBlock(log.blockNumber);
      const record = await parseEvent(log, block);
      if (record) {
        await Event.findOneAndUpdate(
          { txHash: record.txHash, logIndex: record.logIndex },
          record,
          { upsert: true }
        );
        inserted++;
      }
    } catch (err) {
      if (err.code === 11000) {
        skipped++;
      } else {
        console.error("  ⚠️  Error parsing event:", err.message);
      }
    }
  }

  console.log(`   ✅ Synced ${inserted} events (${skipped} duplicates skipped)`);
  return inserted;
}

// ─── Live listener: subscribe to new events ──────────────────────────────────
function startLiveListener() {
  console.log("👂 Listening for live events...\n");

  contract.on("*", async (event) => {
    try {
      const log = event.log || event;
      const block = await provider.getBlock(log.blockNumber);
      const record = await parseEvent(event, block);
      if (record) {
        await Event.findOneAndUpdate(
          { txHash: record.txHash, logIndex: record.logIndex },
          record,
          { upsert: true }
        );
        console.log(`   📝 Stored: ${record.details}`);
      }
    } catch (err) {
      if (err.code !== 11000) {
        console.error("   ⚠️  Live event error:", err.message);
      }
    }
  });
}

// ─── Express API ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// GET /api/history — all events
app.get("/api/history", async (req, res) => {
  try {
    const events = await Event.find().sort({ timestamp: -1, logIndex: -1 }).limit(200).lean();
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/history/:address — events for a specific address
app.get("/api/history/:address", async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    // Build list of ALL addresses this user is associated with (EOA + SmartWallet)
    const addresses = [addr];
    if (CONFIG.roles) {
      if (addr === CONFIG.roles.supplier?.toLowerCase() && CONFIG.contracts.SupplierSmartWallet) {
        addresses.push(CONFIG.contracts.SupplierSmartWallet.toLowerCase());
      }
      if (addr === CONFIG.roles.buyer?.toLowerCase() && CONFIG.contracts.BuyerSmartWallet) {
        addresses.push(CONFIG.contracts.BuyerSmartWallet.toLowerCase());
      }
      if (addr === CONFIG.roles.financier?.toLowerCase() && CONFIG.contracts.FinancierSmartWallet) {
        addresses.push(CONFIG.contracts.FinancierSmartWallet.toLowerCase());
      }
    }

    const regexes = addresses.map(a => new RegExp(`^${a}$`, "i"));

    const events = await Event.find({
      $or: [
        { supplier: { $in: regexes } },
        { buyer: { $in: regexes } },
        { financier: { $in: regexes } },
      ],
    })
      .sort({ timestamp: -1, logIndex: -1 })
      .limit(200)
      .lean();

    res.json({ success: true, events, address: addr });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/history/invoice/:id — events for a specific invoice
app.get("/api/history/invoice/:id", async (req, res) => {
  try {
    const events = await Event.find({ invoiceId: Number(req.params.id) })
      .sort({ timestamp: 1, logIndex: 1 })
      .lean();
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sync — trigger a full re-sync
app.post("/api/sync", async (req, res) => {
  try {
    const count = await syncPastEvents();
    res.json({ success: true, synced: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/stats — quick stats
app.get("/api/stats", async (req, res) => {
  try {
    const total = await Event.countDocuments();
    const byType = await Event.aggregate([
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ success: true, total, byType });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Invoice Finance — History Server");
  console.log("═══════════════════════════════════════════════════════");

  await mongoose.connect(MONGO_URI);
  console.log(`  ✅ MongoDB connected: ${MONGO_URI}`);

  provider = new ethers.JsonRpcProvider(RPC_URL);
  contract = new ethers.Contract(CONFIG.contracts.InvoiceContract, EVENT_ABI, provider);
  console.log(`  ✅ Blockchain: ${RPC_URL}`);
  console.log(`  ✅ InvoiceContract: ${CONFIG.contracts.InvoiceContract}`);

  await syncPastEvents();
  startLiveListener();

  app.listen(PORT, () => {
    console.log(`  ✅ API server: http://localhost:${PORT}`);
    console.log("═══════════════════════════════════════════════════════\n");
    console.log("  Endpoints:");
    console.log("    GET  /api/history           — all events");
    console.log("    GET  /api/history/:address   — events for address");
    console.log("    GET  /api/history/invoice/:id — events for invoice");
    console.log("    POST /api/sync              — re-sync blockchain");
    console.log("    GET  /api/stats             — event statistics\n");
  });
}

main().catch((err) => {
  console.error("❌ Server failed to start:", err);
  process.exit(1);
});
