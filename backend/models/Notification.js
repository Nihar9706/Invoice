const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ["success", "danger", "info", "warning"],
    default: "info"
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  // Tracks which user IDs have acknowledged/seen this notification
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }]
}, { timestamps: true });

module.exports = mongoose.model("Notification", notificationSchema);
