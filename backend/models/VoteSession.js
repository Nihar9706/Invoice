const mongoose = require("mongoose");

const voteSessionSchema = new mongoose.Schema(
    {
        targetUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        initiatorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        reason: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: ["Active", "Slashed", "Dismissed", "Expired"],
            default: "Active",
        },
        votes: [
            {
                voterId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
                decision: {
                    type: String,
                    enum: ["slash", "keep"],
                },
                timestamp: {
                    type: Date,
                    default: Date.now,
                },
            },
        ],
        timeoutDate: {
            type: Date,
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

voteSessionSchema.methods.hasVoted = function (userId) {
    return this.votes.some((v) => v.voterId.toString() === userId.toString());
};

module.exports = mongoose.model("VoteSession", voteSessionSchema);
