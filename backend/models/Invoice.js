const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
    {
        invoiceId: {
            type: Number, // On-chain ID
            required: true,
            unique: true,
            index: true
        },
        supplier: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        status: {
            type: String,
            default: "PENDING"
        },
        biddingTimeout: {
            type: Date,
            default: null
        },
        // Meta-data for auto-election
        advanceRate: Number,
        interestRate: Number,
        financer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        },
        financerAddress: String
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Invoice", invoiceSchema);
