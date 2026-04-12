const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  eventType: {
    type: String,
    required: true,
    enum: [
      "InvoiceUploaded",
      "BuyerApproved",
      "AutoApproved",
      "EscrowDeposited",
      "Financed",
      "AutoFinanced",
      "Paid",
      "Deposited",
      "Withdrawn",
      "BuyerConditionSet",
      "FinancierConditionSet",
    ],
    index: true,
  },
  invoiceId: { type: Number, default: null, index: true },
  supplier: { type: String, default: null },
  buyer: { type: String, default: null },
  financier: { type: String, default: null },
  amount: { type: String, default: null }, // ETH as string to preserve precision
  txHash: { type: String, required: true, index: true },
  blockNumber: { type: Number, required: true },
  logIndex: { type: Number, required: true },
  timestamp: { type: Date, required: true },
  details: { type: String, default: "" }, // human-readable summary
});

// Prevent duplicate entries: unique on txHash + logIndex
eventSchema.index({ txHash: 1, logIndex: 1 }, { unique: true });

// Query indices
eventSchema.index({ supplier: 1, timestamp: -1 });
eventSchema.index({ buyer: 1, timestamp: -1 });
eventSchema.index({ financier: 1, timestamp: -1 });

module.exports = mongoose.model("Event", eventSchema);
