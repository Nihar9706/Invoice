const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  address: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true, 
    index: true 
  },
  role: { 
    type: String, 
    required: true, 
    enum: ["Supplier", "Buyer", "Financier", "Admin"] 
  },
  smartWallet: { 
    type: String, 
    lowercase: true 
  },
  isWhitelisted: { 
    type: Boolean, 
    default: true 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model("User", userSchema);
