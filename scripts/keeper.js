/**
 * scripts/keeper.js — Off-chain AutoKeeper cron script
 *
 * This script connects to a running node (local Hardhat or GoChain testnet)
 * and automatically releases due-date payments every 60 seconds.
 *
 * Usage:
 *   node scripts/keeper.js
 *   node scripts/keeper.js --network gochain_testnet
 *
 * Environment variables (create a .env file in the project root):
 *   RPC_URL        — Node RPC endpoint (default: http://127.0.0.1:8545)
 *   PRIVATE_KEY    — Keeper wallet private key (this wallet pays keeper gas)
 *   INVOICE_ADDR   — Deployed InvoiceContract address
 *   KEEPER_ADDR    — Deployed AutoKeeper address (optional — uses direct calls if not set)
 *   POLL_INTERVAL  — Polling interval in milliseconds (default: 60000 = 1 min)
 */

const { ethers } = require("ethers");
require("dotenv").config();

// ─── Configuration ────────────────────────────────────────────────────────────
const RPC_URL       = process.env.RPC_URL       || "http://127.0.0.1:8545";
const PRIVATE_KEY   = process.env.PRIVATE_KEY;
const INVOICE_ADDR  = process.env.INVOICE_ADDR;
const KEEPER_ADDR   = process.env.KEEPER_ADDR;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "60000");

// Minimal ABIs — only the functions we need
const INVOICE_ABI = [
  "function counter() external view returns (uint256)",
  "function invoices(uint256 id) external view returns (uint256, address, address, uint256, uint256, bool, bool, bool, bool, string, address)",
  "function releaseDueDatePayment(uint256 id) external",
];

const KEEPER_ABI = [
  "function releaseAll() external",
  "function checkAndRelease(uint256[] calldata invoiceIds) external",
  "event Released(uint256 indexed invoiceId, address indexed triggeredBy)",
];

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🤖 AutoKeeper starting...");
  console.log(`   RPC:      ${RPC_URL}`);
  console.log(`   Interval: ${POLL_INTERVAL / 1000}s`);

  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY not set. Create a .env file with PRIVATE_KEY=0x...");
    process.exit(1);
  }
  if (!INVOICE_ADDR) {
    console.error("❌ INVOICE_ADDR not set. Deploy the contract first and set INVOICE_ADDR in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const keeper   = new ethers.Wallet(PRIVATE_KEY, provider);

  const invoiceContract = new ethers.Contract(INVOICE_ADDR, INVOICE_ABI, keeper);

  let keeperContract = null;
  if (KEEPER_ADDR) {
    keeperContract = new ethers.Contract(KEEPER_ADDR, KEEPER_ABI, keeper);
    console.log(`   AutoKeeper contract: ${KEEPER_ADDR}`);
  } else {
    console.log("   No AutoKeeper contract set → calling releaseDueDatePayment() directly");
  }

  console.log(`   Keeper wallet: ${keeper.address}`);
  console.log("   ─────────────────────────────────────\n");

  // Run immediately on start, then on interval
  await poll(invoiceContract, keeperContract);
  setInterval(() => poll(invoiceContract, keeperContract), POLL_INTERVAL);
}

// ─── Poll function ─────────────────────────────────────────────────────────────
async function poll(invoiceContract, keeperContract) {
  const now = Math.floor(Date.now() / 1000);
  console.log(`[${new Date().toISOString()}] 🔍 Checking invoices...`);

  try {
    if (keeperContract) {
      // Use AutoKeeper.releaseAll() — single tx, handles everything
      const tx = await keeperContract.releaseAll();
      await tx.wait();
      console.log(`  ✅ AutoKeeper.releaseAll() executed — tx: ${tx.hash}`);
      return;
    }

    // Fallback: iterate manually
    const count = Number(await invoiceContract.counter());
    if (count === 0) {
      console.log("  📭 No invoices yet.");
      return;
    }

    console.log(`  📋 Total invoices: ${count}`);
    let released = 0;

    for (let id = 1; id <= count; id++) {
      const inv = await invoiceContract.invoices(id);
      // Destructure positional return
      const [
        ,        // id
        ,        // supplier
        ,        // buyer
        amount,  // amount
        dueDate, // dueDate
        ,        // buyerVerified
        ,        // escrowLocked
        financierFunded,
        isPaid,
        status,
      ] = inv;

      const dueDateNum = Number(dueDate);

      if (isPaid) {
        console.log(`  Invoice #${id}: SKIP — already paid`);
        continue;
      }
      if (!financierFunded) {
        console.log(`  Invoice #${id}: SKIP — not financed yet (status: ${status})`);
        continue;
      }
      if (now < dueDateNum) {
        const secondsLeft = dueDateNum - now;
        console.log(`  Invoice #${id}: SKIP — due in ${secondsLeft}s`);
        continue;
      }

      // Past due date, financed, not paid → release!
      try {
        console.log(`  Invoice #${id}: 🚀 Releasing payment...`);
        const tx = await invoiceContract.releaseDueDatePayment(id);
        await tx.wait();
        console.log(`  Invoice #${id}: ✅ Released! amount=${ethers.formatEther(amount)} ETH | tx: ${tx.hash}`);
        released++;
      } catch (err) {
        console.log(`  Invoice #${id}: ⚠️  Release failed — ${err.message}`);
      }
    }

    console.log(`  Summary: ${released} invoice(s) released this round.\n`);

  } catch (err) {
    console.error(`  ❌ Poll error: ${err.message}\n`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
