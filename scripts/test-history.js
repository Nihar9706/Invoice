const mongoose = require("mongoose");
const Event = require("./models/Event");
const cfg = require("../frontend/deployed.json");

mongoose.connect("mongodb://localhost:27017/invoice-finance").then(async () => {
  console.log("=== ALL EVENTS ===");
  const all = await Event.find().sort({ timestamp: 1 }).lean();
  all.forEach(e => {
    console.log(
      e.eventType.padEnd(20),
      "S:", (e.supplier || "—").slice(0, 10).padEnd(12),
      "B:", (e.buyer || "—").slice(0, 10).padEnd(12),
      "F:", (e.financier || "—").slice(0, 10).padEnd(12)
    );
  });

  const suppSW = cfg.contracts.SupplierSmartWallet.toLowerCase();
  const buyerSW = cfg.contracts.BuyerSmartWallet.toLowerCase();
  const finSW = cfg.contracts.FinancierSmartWallet.toLowerCase();

  console.log("\n=== SUPPLIER HISTORY ===");
  const suppEvents = await Event.find({
    $or: [{ supplier: new RegExp(suppSW, "i") }],
  }).lean();
  console.log(suppEvents.length, "events");
  suppEvents.forEach(e => console.log("  ", e.eventType, "-", (e.details || "").slice(0, 70)));

  console.log("\n=== BUYER HISTORY ===");
  const buyerEvents = await Event.find({
    $or: [{ buyer: new RegExp(buyerSW, "i") }],
  }).lean();
  console.log(buyerEvents.length, "events");
  buyerEvents.forEach(e => console.log("  ", e.eventType, "-", (e.details || "").slice(0, 70)));

  console.log("\n=== FINANCIER HISTORY ===");
  const finEvents = await Event.find({
    $or: [{ financier: new RegExp(finSW, "i") }],
  }).lean();
  console.log(finEvents.length, "events");
  finEvents.forEach(e => console.log("  ", e.eventType, "-", (e.details || "").slice(0, 70)));

  process.exit(0);
});
