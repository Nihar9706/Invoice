const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ─── Hardcoded role addresses (Hardhat default accounts) ─────────────────────
const ROLES = {
  supplier:  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  buyer:     "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  financier: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
};

async function main() {
  const [owner] = await ethers.getSigners();

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Invoice Finance — ERC-4337 AA Deployment");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Deployer (owner):", owner.address);
  console.log("  Supplier:        ", ROLES.supplier);
  console.log("  Buyer:           ", ROLES.buyer);
  console.log("  Financier:       ", ROLES.financier);
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

  // 3. Fund Paymaster deposit inside EntryPoint (covers gas for sponsored ops)
  const pmFund = ethers.parseEther("10");
  await paymaster.connect(owner).depositToEntryPoint({ value: pmFund });
  console.log("   └─ Paymaster funded with", ethers.formatEther(pmFund), "ETH in EntryPoint");

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

  // 7. SmartWallets for ALL roles (ERC-4337 AA)
  console.log("\n─── Deploying SmartWallets (ERC-4337) ───");
  const SW = await ethers.getContractFactory("SmartWallet");

  const supplierWallet = await SW.deploy(ROLES.supplier, entryPoint.target, paymaster.target);
  await supplierWallet.waitForDeployment();
  console.log("   ✅ Supplier SmartWallet: ", supplierWallet.target);

  const buyerWallet = await SW.deploy(ROLES.buyer, entryPoint.target, paymaster.target);
  await buyerWallet.waitForDeployment();
  console.log("   ✅ Buyer SmartWallet:    ", buyerWallet.target);

  const financierWallet = await SW.deploy(ROLES.financier, entryPoint.target, paymaster.target);
  await financierWallet.waitForDeployment();
  console.log("   ✅ Financier SmartWallet:", financierWallet.target);

  // ─── Whitelist ALL users + SmartWallets in Paymaster ────────────────────────
  console.log("\n─── Whitelisting in Paymaster ───");
  // EOAs
  await paymaster.connect(owner).addUser(ROLES.supplier);
  console.log("   ✅ Supplier EOA whitelisted");
  await paymaster.connect(owner).addUser(ROLES.buyer);
  console.log("   ✅ Buyer EOA whitelisted");
  await paymaster.connect(owner).addUser(ROLES.financier);
  console.log("   ✅ Financier EOA whitelisted");
  // SmartWallets
  await paymaster.connect(owner).addUser(supplierWallet.target);
  console.log("   ✅ Supplier SmartWallet whitelisted");
  await paymaster.connect(owner).addUser(buyerWallet.target);
  console.log("   ✅ Buyer SmartWallet whitelisted");
  await paymaster.connect(owner).addUser(financierWallet.target);
  console.log("   ✅ Financier SmartWallet whitelisted");

  // ─── Pre-deposit ETH for Buyer & Financier SmartWallets ─────────────────────
  console.log("\n─── Pre-depositing ETH into InvoiceContract ───");
  const depositAmt = ethers.parseEther("100");

  // Owner deposits on behalf of buyer SmartWallet
  await invoice.connect(owner).depositFor(buyerWallet.target, { value: depositAmt });
  console.log(`   ✅ Buyer SmartWallet pre-deposited: 100 ETH`);

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
      SupplierSmartWallet:  supplierWallet.target,
      BuyerSmartWallet:     buyerWallet.target,
      FinancierSmartWallet: financierWallet.target,
    },
    roles: {
      owner:     owner.address,
      supplier:  ROLES.supplier,
      buyer:     ROLES.buyer,
      financier: ROLES.financier,
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
