const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const Notification = require("../models/Notification");

// GET: Fetch unread notifications for the user
router.get("/unread", protect, async (req, res) => {
    try {
        // Fetch notifications where readBy does NOT contain the user's ID
        const unread = await Notification.find({
            readBy: { $ne: req.user._id }
        }).sort({ timestamp: -1 });

        res.status(200).json({ success: true, notifications: unread });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error fetching notifications" });
    }
});

// PATCH: Mark notification as read for the user
router.patch("/:id/read", protect, async (req, res) => {
    try {
        const notification = await Notification.findById(req.params.id);
        if (!notification) {
            return res.status(404).json({ success: false, message: "Notification not found" });
        }

        // Add user to readBy array if not already there
        if (!notification.readBy.includes(req.user._id)) {
            notification.readBy.push(req.user._id);
            await notification.save();
        }

        res.status(200).json({ success: true, message: "Marked as read" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error marking as read" });
    }
});

module.exports = router;
