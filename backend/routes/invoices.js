const express = require("express");
const router = express.Router();
const Bid = require("../models/Bid");
const User = require("../models/User");
const Invoice = require("../models/Invoice");
const { protect, authorize } = require("../middleware/auth");

// SUBMIT BID (Financer)
router.post("/:id/bids", protect, authorize("financer"), async (req, res) => {
    try {
        const invoiceId = parseInt(req.params.id);
        const { advanceRate, interestRate } = req.body;

        // Check if bidding session is active
        const invoice = await Invoice.findOne({ invoiceId });
        if (invoice && invoice.biddingTimeout && new Date() > invoice.biddingTimeout) {
            return res.status(400).json({ success: false, message: "Bidding for this invoice has expired." });
        }
        
        // One bid per financier per invoice
        const existingBid = await Bid.findOne({ invoiceId, financer: req.user._id });
        if (existingBid) {
            return res.status(400).json({ 
                success: false, 
                message: "You have already submitted a bid for this invoice. Bidders are restricted to one bid per invoice." 
            });
        }

        const bid = await Bid.create({
            invoiceId,
            financer: req.user._id,
            financerAddress: req.user.walletAddress,
            advanceRate,
            interestRate
        });

        res.status(201).json({ success: true, bid });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET BIDS FOR INVOICE
router.get("/:id/bids", protect, async (req, res) => {
    try {
        const bids = await Bid.find({ invoiceId: parseInt(req.params.id) })
            .populate("financer", "walletAddress role name");
        res.json({ success: true, bids });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ACCEPT BID (Supplier)
router.patch("/:id/bids/:bidId/accept", protect, authorize("supplier", "admin"), async (req, res) => {
    try {
        const bid = await Bid.findById(req.params.bidId);
        if (!bid) return res.status(404).json({ success: false, message: "Bid not found" });

        // Accept this bid, reject others for this invoice
        bid.status = "Accepted";
        await bid.save();
        await Bid.updateMany({ invoiceId: bid.invoiceId, _id: { $ne: bid._id } }, { status: 'Rejected' });

        res.json({ success: true, bid });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET INVOICE METADATA (Public or Protected)
router.get("/metadata", protect, async (req, res) => {
    try {
        const metadata = await Invoice.find({});
        res.json({ success: true, metadata });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// START BIDDING WITH TIMEOUT (Supplier)
router.post("/:id/start-bidding", protect, authorize("supplier"), async (req, res) => {
    try {
        const invoiceId = parseInt(req.params.id);
        const { timeoutMinutes } = req.body;

        const timeout = new Date(Date.now() + timeoutMinutes * 60 * 1000);

        const invoice = await Invoice.findOneAndUpdate(
            { invoiceId },
            { 
                supplier: req.user._id, 
                status: "BIDDING", 
                biddingTimeout: timeout 
            },
            { upsert: true, new: true }
        );

        res.json({ success: true, invoice, message: `Bidding started. Expires in ${timeoutMinutes} minutes.` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
