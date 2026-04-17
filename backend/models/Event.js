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
      "BiddingStarted", // Added for new flow
      "BidAccepted",    // Added for new flow
    ],
    index: true,
  },
  invoiceId: { type: Number, default: null, index: true },
  supplier: { type: String, default: null },
  buyer: { type: String, default: null },
  financier: { type: String, default: null },
  amount: { type: String, default: null },
  txHash: { type: String, required: true, index: true },
  blockNumber: { type: Number, required: true },
  logIndex: { type: Number, required: true },
  timestamp: { type: Date, required: true },
  details: { type: String, default: "" },
});

eventSchema.index({ txHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model("Event", eventSchema);
