const User = require("../models/User");
const fs = require("fs");
const path = require("path");

// Load roles from deployed.json
const configPath = path.join(__dirname, "..", "..", "frontend", "deployed.json");
let rolesConfig = { suppliers: [], buyers: [], financiers: [] };

if (fs.existsSync(configPath)) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (config.roles) {
            rolesConfig = config.roles;
        }
    } catch (err) {
        console.error("Failed to load roles from deployed.json:", err.message);
    }
}

function detectRole(address) {
    const addr = address.toLowerCase();
    if (rolesConfig.suppliers?.map(a => a.toLowerCase()).includes(addr)) return "supplier";
    if (rolesConfig.buyers?.map(a => a.toLowerCase()).includes(addr))    return "buyer";
    if (rolesConfig.financiers?.map(a => a.toLowerCase()).includes(addr)) return "financer";
    return "supplier"; // Default fallback
}

// Simple wallet-based protection. 
// Expects 'x-wallet-address' header for simplicity in this dev stage.
const protect = async (req, res, next) => {
    let walletAddress = req.headers["x-wallet-address"];

    if (!walletAddress) {
        return res.status(401).json({ success: false, message: "Not authorized, no wallet address" });
    }

    try {
        walletAddress = walletAddress.toLowerCase();
        let user = await User.findOne({ walletAddress });

        const role = detectRole(walletAddress);

        if (!user) {
            user = await User.create({ walletAddress, role }); 
        } else if (user.role !== role) {
            // Auto-update role if it changed in deployed.json
            user.role = role;
            await user.save();
        }

        if (user.isSlashed) {
            return res.status(403).json({ success: false, message: "This account has been slashed by consensus." });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error(error);
        res.status(401).json({ success: false, message: "Not authorized" });
    }
};

const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: `User role ${req.user.role} is not authorized to access this route`,
            });
        }
        next();
    };
};

module.exports = { protect, authorize };
