/**
 * scripts/sync-whitelist-to-mongo.js
 * 
 * Seeding MongoDB with whitelisted addresses.
 */

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const User = require("./models/User");

const MONGO_URI = "mongodb://localhost:27017/invoice-finance";
const configPath = path.join(__dirname, "..", "frontend", "deployed.json");

async function main() {
  if (!fs.existsSync(configPath)) {
    console.error("❌ deployed.json not found!");
    process.exit(1);
  }

  const CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const whitelist = CONFIG.backendOracle?.whitelistedAddresses || [];

  console.log(`📡 Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URI);
  
  // Drop collection to clear old incompatible indices (like wallet_1)
  try {
    await mongoose.connection.db.dropCollection("users");
    console.log("🧹 Dropped old users collection.");
  } catch (e) {
    // Collection might not exist, that's fine
  }

  console.log(`🔄 Syncing ${whitelist.length} addresses...`);

  for (const addr of whitelist) {
    const lowerAddr = addr.toLowerCase();
    
    let role = "User";
    if (lowerAddr === CONFIG.roles?.supplier?.toLowerCase()) role = "Supplier";
    if (lowerAddr === CONFIG.roles?.buyer?.toLowerCase()) role = "Buyer";
    if (lowerAddr === CONFIG.roles?.financier?.toLowerCase()) role = "Financier";
    if (lowerAddr === CONFIG.roles?.owner?.toLowerCase()) role = "Admin";
    
    if (lowerAddr === CONFIG.contracts?.SupplierSmartWallet?.toLowerCase()) role = "Supplier";
    if (lowerAddr === CONFIG.contracts?.BuyerSmartWallet?.toLowerCase()) role = "Buyer";
    if (lowerAddr === CONFIG.contracts?.FinancierSmartWallet?.toLowerCase()) role = "Financier";

    await User.create({ address: lowerAddr, role, isWhitelisted: true });
    console.log(`   + Registered ${lowerAddr} as ${role}`);
  }

  console.log("\n✅ MongoDB Whitelist seeded!");
  process.exit(0);
}

main().catch(err => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
