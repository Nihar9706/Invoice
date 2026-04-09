/**
 * scripts/bundler-relay.js — Off-chain ERC-4337 Bundler Relay
 *
 * This server receives UserOperations from the frontend, signs them
 * using the Hardhat default account private keys, and submits them
 * to the on-chain Bundler contract.
 *
 * Usage:  node scripts/bundler-relay.js
 *
 * Flow:
 *   Frontend → HTTP POST /submit-userop → Relay signs UserOp → Bundler.bundleOne() → EntryPoint → SmartWallet → Target
 */

const http = require("http");
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const PORT    = 3001;
const RPC_URL = "http://127.0.0.1:8545";

// ─── Hardhat default private keys (for signing UserOps on behalf of users) ───
const PRIVATE_KEYS = {
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906": "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65": "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc": "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};

// ─── ABIs ────────────────────────────────────────────────────────────────────
const SMART_WALLET_ABI = [
  "function owner() external view returns (address)",
];

const BUNDLER_ABI = [
  "function bundleOne(tuple(address sender, address target, bytes data, bytes signature, address paymaster) op) external",
];

// ─── State ───────────────────────────────────────────────────────────────────
let provider, relayerWallet, bundlerContract, config;

async function init() {
  // Load deployed config
  const configPath = path.join(__dirname, "..", "frontend", "deployed.json");
  if (!fs.existsSync(configPath)) {
    console.error("❌ deployed.json not found! Deploy contracts first.");
    process.exit(1);
  }
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // Connect to local node with Account #0 (deployer) as the relayer
  provider = new ethers.JsonRpcProvider(RPC_URL);
  const relayerKey = PRIVATE_KEYS["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"];
  relayerWallet = new ethers.Wallet(relayerKey, provider);

  bundlerContract = new ethers.Contract(config.contracts.Bundler, BUNDLER_ABI, relayerWallet);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  ERC-4337 Bundler Relay Server");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Relayer:   ${relayerWallet.address}`);
  console.log(`  Bundler:   ${config.contracts.Bundler}`);
  console.log(`  EntryPoint: ${config.contracts.EntryPoint}`);
  console.log(`  Paymaster:  ${config.contracts.Paymaster}`);
  console.log(`  Listening:  http://localhost:${PORT}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

// ─── Sign a UserOp ──────────────────────────────────────────────────────────
async function signUserOp(op) {
  // Get SmartWallet owner
  const smartWallet = new ethers.Contract(op.sender, SMART_WALLET_ABI, provider);
  const ownerAddr = (await smartWallet.owner()).toLowerCase();

  const privateKey = PRIVATE_KEYS[ownerAddr];
  if (!privateKey) {
    throw new Error(`No private key found for SmartWallet owner ${ownerAddr}`);
  }

  const signerWallet = new ethers.Wallet(privateKey);

  // Hash: keccak256(abi.encode(sender, target, data)) — matches EntryPoint._verify
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["address", "address", "bytes"],
    [op.sender, op.target, op.data]
  );
  const hash = ethers.keccak256(encoded);

  // signMessage auto-prepends "\x19Ethereum Signed Message:\n32" — matches EntryPoint
  const signature = await signerWallet.signMessage(ethers.getBytes(hash));
  return signature;
}

// ─── Handle UserOp submission ────────────────────────────────────────────────
async function handleSubmit(op) {
  console.log(`📥 Received UserOp:`);
  console.log(`   sender:    ${op.sender}`);
  console.log(`   target:    ${op.target}`);
  console.log(`   paymaster: ${op.paymaster}`);
  console.log(`   data:      ${op.data.slice(0, 20)}...`);

  // Step 1: Sign the UserOp
  const signature = await signUserOp(op);
  console.log(`   ✅ Signed by SmartWallet owner`);

  // Step 2: Build the full UserOp with signature
  const fullOp = {
    sender:    op.sender,
    target:    op.target,
    data:      op.data,
    signature: signature,
    paymaster: op.paymaster,
  };

  // Step 3: Submit via Bundler.bundleOne()
  console.log(`   📤 Submitting to Bundler.bundleOne()...`);
  const tx = await bundlerContract.bundleOne(fullOp);
  const receipt = await tx.wait();

  console.log(`   ✅ Executed! TX: ${tx.hash}`);
  console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}\n`);

  return { txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
function startServer() {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/submit-userop") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const op = JSON.parse(body);

          // Validate required fields
          if (!op.sender || !op.target || !op.data || !op.paymaster) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Missing fields: sender, target, data, paymaster" }));
            return;
          }

          const result = await handleSubmit(op);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
          console.error(`   ❌ Error: ${err.message}\n`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", relayer: relayerWallet.address }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`🚀 Bundler relay listening on http://localhost:${PORT}`);
    console.log(`   POST /submit-userop  — submit a UserOperation`);
    console.log(`   GET  /health         — health check\n`);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  await init();
  startServer();
})();
