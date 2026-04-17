const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ─── Hardcoded role addresses (Hardhat default accounts) ─────────────────────
const ROLES = {
  suppliers: [
    "0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199",
    "0xdd2fd4581271e230360230f9337d5c0430bf44c0",
  ],
  buyers: [
    "0xbda5747bfd65f08deb54cb465eb87d40e51b197e",
    "0xcd3b766ccdd6ae721141f452c550ca635964ce71",
  ],
  financiers: [
    "0x2546bcd3c84621e976d8185a91a922ae77ecec30",
    "0x71be63f3384f5fb98995898a86b02fb2426c5788",
  ],
};

async function main() {
  const [owner] = await ethers.getSigners();

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Invoice Finance — MULTI-ROLE AA Deployment");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Deployer (owner):", owner.address);
  console.log("───────────────────────────────────────────────────────\n");

  // 1. EntryPoint
  const EP = await ethers.getContractFactory("EntryPoint");
  const entryPoint = await EP.deploy();
  await entryPoint.waitForDeployment();
  console.log("✅ EntryPoint deployed:    ", entryPoint.target);

  // 2. Paymaster
  const PM = await ethers.getContractFactory("Paymaster");
  const paymaster = await PM.deploy(entryPoint.target);
  await paymaster.waitForDeployment();
  console.log("✅ Paymaster deployed:     ", paymaster.target);

  // 3. Fund Paymaster deposit inside EntryPoint
  const pmFund = ethers.parseEther("20"); // More gas for more users
  await paymaster.connect(owner).depositToEntryPoint({ value: pmFund });
  console.log("   └─ Paymaster funded with", ethers.formatEther(pmFund), "ETH");

  // 4. InvoiceContract
  const IC = await ethers.getContractFactory("InvoiceContract");
  const invoice = await IC.deploy(paymaster.target);
  await invoice.waitForDeployment();
  console.log("✅ InvoiceContract deployed:", invoice.target);

  // 5. AutoKeeper
  const AK = await ethers.getContractFactory("AutoKeeper");
  const autoKeeper = await AK.deploy(invoice.target);
  await autoKeeper.waitForDeployment();
  console.log("✅ AutoKeeper deployed:    ", autoKeeper.target);

  // 6. Bundler
  const BD = await ethers.getContractFactory("Bundler");
  const bundler = await BD.deploy(entryPoint.target);
  await bundler.waitForDeployment();
  console.log("✅ Bundler deployed:       ", bundler.target);

  // 7. SmartWallets (ERC-4337 AA)
  console.log("\n─── Deploying SmartWallets (2 per role) ───");
  const SW = await ethers.getContractFactory("SmartWallet");
  
  const deployedSmartWallets = {
    suppliers:  [],
    buyers:     [],
    financiers: [],
  };

  async function deployAndWhitelist(eoa, roleKey) {
    const sw = await SW.deploy(eoa, entryPoint.target, paymaster.target);
    await sw.waitForDeployment();
    console.log(`   ✅ ${roleKey} SW: ${sw.target} (Owner: ${eoa.slice(0,8)}...)`);
    
    // Whitelist BOTH EOA and SmartWallet
    await paymaster.connect(owner).addUser(eoa);
    await paymaster.connect(owner).addUser(sw.target);
    
    deployedSmartWallets[roleKey].push(sw.target);
  }

  for (const eoa of ROLES.suppliers)  await deployAndWhitelist(eoa, "suppliers");
  for (const eoa of ROLES.buyers)     await deployAndWhitelist(eoa, "buyers");
  for (const eoa of ROLES.financiers) await deployAndWhitelist(eoa, "financiers");

  // ─── Save addresses to frontend config ─────────────────────────────────────
  const config = {
    network: "localhost",
    rpcUrl: "http://127.0.0.1:8545",
    bundlerRelayUrl: "http://127.0.0.1:3001",
    chainId: 31337,
    deployedAt: new Date().toISOString(),
    contracts: {
      EntryPoint:           entryPoint.target,
      Paymaster:            paymaster.target,
      InvoiceContract:      invoice.target,
      AutoKeeper:           autoKeeper.target,
      Bundler:              bundler.target,
      SupplierWallets:      deployedSmartWallets.suppliers,
      BuyerWallets:         deployedSmartWallets.buyers,
      FinancierWallets:     deployedSmartWallets.financiers,
    },
    roles: {
      owner:      owner.address,
      suppliers:  ROLES.suppliers,
      buyers:     ROLES.buyers,
      financiers: ROLES.financiers,
    },
  };

  const frontendDir = path.join(__dirname, "..", "frontend");
  if (!fs.existsSync(frontendDir)) fs.mkdirSync(frontendDir, { recursive: true });

  const configPath = path.join(frontendDir, "deployed.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ All contracts deployed successfully!");
  console.log("  📄 Config saved to: frontend/deployed.json");
  console.log("═══════════════════════════════════════════════════════\n");

  console.log("Next steps:");
  console.log("  1. Keep this Hardhat node running");
  console.log("  2. Start bundler relay: node scripts/bundler-relay.js");
  console.log("  3. Start frontend: npx http-server frontend -p 3000");
  console.log("  4. Open: http://localhost:3000");
  console.log("\n  MetaMask private keys (Hardhat defaults):");
  console.log("     Supplier (#1): 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  console.log("     Buyer    (#2): 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
  console.log("     Financier(#5): 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Deployment failed:", err);
    process.exit(1);
  });
