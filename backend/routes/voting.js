const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const VoteSession = require("../models/VoteSession");
const User = require("../models/User");
const Notification = require("../models/Notification");

// GET: Get List of all users/nodes
router.get("/network-nodes", protect, async (req, res) => {
    try {
        const users = await User.find({}).select("_id walletAddress role isSlashed name");
        res.status(200).json({ success: true, nodes: users });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error fetching network nodes" });
    }
});

// GET: Get active votes
router.get("/active", protect, async (req, res) => {
    try {
        const now = new Date();
        // First, expire any old sessions
        await VoteSession.updateMany(
            { status: "Active", timeoutDate: { $lt: now } },
            { status: "Expired" }
        );

        const activeVotes = await VoteSession.find({
            status: "Active",
            targetUserId: { $ne: req.user._id }
        }).populate("targetUserId", "walletAddress role name")
          .populate("initiatorId", "walletAddress role");

        // Strictly count voters: Suppliers, Buyers, Financiers (EXCLUDE Admin)
        const activeVoters = await User.find({ 
            isSlashed: false, 
            isActive: true,
            role: { $ne: "admin" } 
        });
        
        // Final sanity check: If we have 6 nodes, quorum MUST be 5.
        const totalVotersCount = activeVoters.length;
        const quorum = Math.max(1, totalVotersCount - 1);

        const mappedVotes = activeVotes.map(vote => {
            const hasVoted = vote.votes.some(v => v.voterId.toString() === req.user._id.toString());
            
            return {
                ...vote.toObject(), 
                votes: undefined,
                totalVotesCast: vote.votes.length,
                requiredVotes: quorum, // This will show 5
                hasVoted
            };
        });

        res.status(200).json({ success: true, votes: mappedVotes });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error fetching active votes" });
    }
});

// POST: Initiate a Vote
router.post("/initiate", protect, async (req, res) => {
    try {
        const { targetUserId, reason, timeoutMinutes } = req.body;
        const duration = parseInt(timeoutMinutes) || 60;

        const target = await User.findById(targetUserId);
        if (!target || target.isSlashed) {
            return res.status(400).json({ success: false, message: "Target user not found or already slashed." });
        }

        const existingActive = await VoteSession.findOne({ targetUserId, status: "Active" });
        if (existingActive) {
            return res.status(400).json({ success: false, message: "A vote is already active for this user." });
        }

        const timeoutDate = new Date(Date.now() + duration * 60000);

        const newVote = await VoteSession.create({
            targetUserId,
            initiatorId: req.user._id,
            reason,
            timeoutDate
        });

        res.status(201).json({ success: true, vote: newVote });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error initiating vote" });
    }
});

// POST: Cast Vote
router.post("/:id/vote", protect, async (req, res) => {
    try {
        const { decision } = req.body;
        const voteSession = await VoteSession.findById(req.params.id).populate("targetUserId", "walletAddress");
        
        if (!voteSession || voteSession.status !== "Active") {
            return res.status(400).json({ success: false, message: "Session already finalized or inactive" });
        }

        if (new Date() > voteSession.timeoutDate) {
            voteSession.status = "Expired";
            await voteSession.save();
            return res.status(400).json({ success: false, message: "Voting session has expired." });
        }

        if (voteSession.hasVoted(req.user._id)) {
            return res.status(400).json({ success: false, message: "Already voted" });
        }

        voteSession.votes.push({ voterId: req.user._id, decision });
        await voteSession.save();

        // ─── CONSENSUS CALCULATION ───────────────────────────────────────────
        const activeVoters = await User.find({ 
            isSlashed: false, 
            isActive: true,
            role: { $ne: "admin" } 
        });
        
        const quorum      = Math.max(1, activeVoters.length - 1); 
        const threshold   = Math.ceil((quorum * 2) / 3);  
        
        const slashVotes  = voteSession.votes.filter(v => v.decision === "slash").length;
        const keepVotes   = voteSession.votes.filter(v => v.decision === "keep").length;
        const totalCast   = voteSession.votes.length;

        let resultMessage = "";
        let finished = false;

        // 1. Immediate 2/3 Slash reached
        if (slashVotes >= threshold) {
            voteSession.status = "Slashed";
            const target = await User.findById(voteSession.targetUserId);
            if (target) {
                target.isSlashed = true;
                target.isActive  = false;
                await target.save();
            }
            resultMessage = `⚖️ Governance Result: Node ${voteSession.targetUserId.walletAddress.slice(0, 8)} Slashed by 2/3 supermajority!`;
            finished = true;
        } 
        // 2. Immediate 2/3 Keep reached
        else if (keepVotes >= threshold) {
            voteSession.status = "Dismissed";
            resultMessage = `⚖️ Governance Result: Node ${voteSession.targetUserId.walletAddress.slice(0, 8)} Kept by 2/3 supermajority!`;
            finished = true;
        }
        // 3. Participation Complete (Everyone has voted)
        else if (totalCast >= quorum) {
            voteSession.status = "Dismissed"; 
            resultMessage = `⚖️ Governance Result: 100% participation reached for ${voteSession.targetUserId.walletAddress.slice(0, 8)}. Session Closed.`;
            finished = true;
        }

        if (finished) {
            await voteSession.save();
            await Notification.create({
                message: resultMessage,
                type: voteSession.status === "Slashed" ? "danger" : "success"
            });
            return res.status(200).json({ success: true, message: resultMessage });
        }

        res.status(200).json({ success: true, message: "Vote cast successfully" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error submitting vote" });
    }
});

module.exports = router;
