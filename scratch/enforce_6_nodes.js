const mongoose = require("mongoose");
const User = require("../backend/models/User");

const ALLOWED_NODES = [
  '0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199',
  '0xdd2fd4581271e230360230f9337d5c0430bf44c0',
  '0xbda5747bfd65f08deb54cb465eb87d40e51b197e',
  '0xcd3b766ccdd6ae721141f452c550ca635964ce71',
  '0x2546bcd3c84621e976d8185a91a922ae77ecec30',
  '0x71be63f3384f5fb98995898a86b02fb2426c5788'
].map(a => a.toLowerCase());

async function enforce() {
  await mongoose.connect('mongodb://127.0.0.1:27017/invoice-finance-merged');
  console.log("Connected for Strict Enforcement...");

  const result = await User.deleteMany({ 
    walletAddress: { $nin: ALLOWED_NODES } 
  });
  
  console.log(`✅ Database Sanitized: Removed ${result.deletedCount} un-authorized nodes.`);
  
  const remaining = await User.find({});
  console.log("Remaining Nodes:", remaining.length);
  remaining.forEach(u => console.log(` - ${u.walletAddress} (${u.role})`));

  process.exit(0);
}

enforce().catch(e => { console.error(e); process.exit(1); });
