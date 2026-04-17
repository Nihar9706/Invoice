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
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906": "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65": "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc": "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
  "0x976ea74026e726554db657fa54763abd0c3a0aa9": "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // #6
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955": "0x4bb51fa870f986ea304ed508753c31a899c49722b5711b47ad2e6c5264620b2d", // #7
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f": "0xdbda1821b80551c9d65939329250298aa3472ba22fe6b2a2b095496103b44b82", // #8
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720": "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // #9
  "0xb273216c05a810e122643c96cb21303e3f847427": "0xf214f2b2cd398c806f84e317254e0f0b801d064303bb58a87585afde3e159932", // #10
  "0x71be63f3384f5fb98995898a86b02fb2426c5788": "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82", // #11
  "0xf9477ac44498308ce7a641a3b0f65c90a865b4f8": "0xbad81c3e34a7065050f2278b171f11c7987823e595e8697c11f7c5155f309995", // #12
  "0xf556d11ea8d59E53896cca20e9f00f3Be5eEef1B": "0x247a329d40b4ee3f2df6ba22b07d6aa42013145da589b25a2872bc97d8c471c6", // #13
  "0xe056db3B28A2518eA4339e145A6417f73B7aA9e4": "0x6e2c076e00185e92150a4ced9fb551a3160a28f73f62cb535fd2a7229505a415", // #14
  "0x2546bcd3c84621e976d8185a91a922ae77ecec30": "0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0", // #15
  "0xcd3b766ccdd6ae721141f452c550ca635964ce71": "0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61", // #16
  "0xbda5747bfd65f08deb54cb465eb87d40e51b197e": "0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd", // #17
  "0xdd2fd4581271e230360230f9337d5c0430bf44c0": "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0", // #18
  "0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199": "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e", // #19
};

// ─── ABIs ────────────────────────────────────────────────────────────────────
const SMART_WALLET_ABI = [
  "function owner() external view returns (address)",
];

const BUNDLER_ABI = [
  "function bundleOne(tuple(address sender, address target, bytes data, bytes signature, address paymaster, uint256 nonce) op) external",
];

const ENTRYPOINT_ABI = [
  "function nonces(address) view returns (uint256)",
];

// ─── State ───────────────────────────────────────────────────────────────────
let provider, relayerWallet, bundlerContract, entryPointContract, config;

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
  entryPointContract = new ethers.Contract(config.contracts.EntryPoint, ENTRYPOINT_ABI, provider);

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
async function signUserOp(op, nonce) {
  // Get SmartWallet owner
  const smartWallet = new ethers.Contract(op.sender, SMART_WALLET_ABI, provider);
  const ownerAddr = (await smartWallet.owner()).toLowerCase();

  const privateKey = PRIVATE_KEYS[ownerAddr];
  if (!privateKey) {
    throw new Error(`No private key found for SmartWallet owner ${ownerAddr}`);
  }

  const signerWallet = new ethers.Wallet(privateKey);

  // Hash: keccak256(abi.encode(sender, target, data, nonce)) — matches EntryPoint._verify
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["address", "address", "bytes", "uint256"],
    [op.sender, op.target, op.data, nonce]
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

  // Step 1: Get nonce from EntryPoint and sign the UserOp
  const nonce = await entryPointContract.nonces(op.sender);
  console.log(`   nonce:     ${nonce}`);
  const signature = await signUserOp(op, nonce);
  console.log(`   ✅ Signed by SmartWallet owner (with nonce ${nonce})`);

  // ─── AUTO-DEPOSIT INTERCEPTOR ───────────────────────────────────────────────
  // In our UserOp schema: op.target = contract address, op.data = raw calldata
  // (NOT wrapped in SmartWallet.execute — the bundler does that on-chain)
  //
  // We intercept TWO functions:
  //   1. approveByBuyer(id) → pull invoice amount from Buyer's MetaMask (for escrow)
  //   2. fundInvoice(id)    → pull 90% of amount from Financier's MetaMask (for funding)
  // ────────────────────────────────────────────────────────────────────────────
  try {
    const iface = new ethers.Interface([
      "function approveByBuyer(uint256 id)",
      "function fundInvoice(uint256 id)",
      "function acceptBid(uint256 id, address winningFinancier)",
    ]);
    const decoded = iface.parseTransaction({ data: op.data });

    if (decoded && (decoded.name === "approveByBuyer" || decoded.name === "fundInvoice" || decoded.name === "acceptBid")) {
      const id = decoded.args[0];
      const fnName = decoded.name;
      console.log(`   💡 Auto-Deposit intercepted ${fnName}(#${id})`);

      // Determine who needs the deposit
      let swToDepositFor = op.sender; // Default: the sender of the UserOp
      if (fnName === "acceptBid") {
          // In acceptBid, the SUPPLIER is op.sender, but the FINANCIER needs the deposit
          // We need to find the financier's SmartWallet address
          swToDepositFor = decoded.args[1]; 
      }

      // Read invoice details and current deposit
      const invContract = new ethers.Contract(
        op.target,
        [
          "function invoices(uint256) view returns (uint256,address,address,uint256,uint256,bool,bool,bool,bool,string,address)",
          "function depositFor(address) payable",
          "function deposits(address) view returns (uint256)",
        ],
        provider
      );

      const inv = await invContract.invoices(id);
      const invoiceAmount = inv[3];

      let requiredDeposit;
      if (fnName === "approveByBuyer") {
        requiredDeposit = invoiceAmount;
      } else {
        requiredDeposit = (invoiceAmount * 90n) / 100n;
      }

      const currentDeposit = await invContract.deposits(swToDepositFor);

      if (currentDeposit < requiredDeposit) {
        const needed = requiredDeposit - currentDeposit;
        
        // Resolve EOA of the target SmartWallet
        const targetSW = new ethers.Contract(swToDepositFor, SMART_WALLET_ABI, provider);
        const ownerAddr = (await targetSW.owner()).toLowerCase();

        const roleName = fnName === "approveByBuyer" ? "Buyer" : "Financier";
        console.log(`   ⚡ Pulling ${ethers.formatEther(needed)} ETH from ${roleName}'s MetaMask EOA (${ownerAddr})...`);

        const privateKey = PRIVATE_KEYS[ownerAddr];
        if (privateKey) {
          const eoaWallet = new ethers.Wallet(privateKey, provider);
          const depTx = await invContract.connect(eoaWallet).depositFor(swToDepositFor, { value: needed });
          await depTx.wait();
          console.log(`   ✅ Deposited ${ethers.formatEther(needed)} ETH from ${roleName}'s EOA → contract deposit`);
        } else {
          console.log(`   ⚠️  No private key for ${ownerAddr}, skipping auto-deposit`);
        }
      } else {
        console.log(`   ✅ Sufficient deposit already (${ethers.formatEther(currentDeposit)} ETH)`);
      }
    }
  } catch (_) {
    // Not an interceptable call — nothing to do
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Step 2: Build the full UserOp with signature
  const fullOp = {
    sender:    op.sender,
    target:    op.target,
    data:      op.data,
    signature: signature,
    paymaster: op.paymaster,
    nonce:     nonce,
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
