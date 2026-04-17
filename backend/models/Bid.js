const mongoose = require("mongoose");

const bidSchema = new mongoose.Schema(
    {
        invoiceId: {
            type: Number, // Matches friend's contract counter
            required: true,
            index: true,
        },
        financer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        financerAddress: {
            type: String,
            required: true,
            lowercase: true,
        },
        advanceRate: {
            type: Number,
            required: true,
        },
        interestRate: {
            type: Number,
            required: true,
        },
        status: {
            type: String,
            enum: ["Pending", "Accepted", "Rejected", "Withdrawn"],
            default: "Pending",
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Bid", bidSchema);
