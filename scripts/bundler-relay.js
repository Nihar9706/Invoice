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
const mongoose = require("mongoose");
const User = require("./models/User");

const PORT    = 3001;
const MONGO_URI = "mongodb://localhost:27017/invoice-finance";
const RPC_URL = "http://127.0.0.1:8545";

// ─── Hardhat default private keys (dynamically mapped) ─────────────
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
for (let i = 0; i < 20; i++) {
  const wallet = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", null, "m/44'/60'/0'/0/" + i);
  PRIVATE_KEYS[wallet.address.toLowerCase()] = wallet.privateKey;
}

// ─── Load previously saved dynamic keys ──────────────────────────────────────
const dynamicKeysPath = path.join(__dirname, "dynamic_keys.json");
if (fs.existsSync(dynamicKeysPath)) {
  const savedKeys = JSON.parse(fs.readFileSync(dynamicKeysPath, "utf8"));
  for (const [addr, pk] of Object.entries(savedKeys)) {
    PRIVATE_KEYS[addr.toLowerCase()] = pk;
  }
}

// ─── ABIs ────────────────────────────────────────────────────────────────────
const SMART_WALLET_ABI = [
  "function owner() external view returns (address)",
];

const BUNDLER_ABI = [
  "function bundleOne(tuple(address sender, address target, bytes data, bytes signature, address paymaster, bytes paymasterData, uint256 nonce) op) external",
];

const ENTRYPOINT_ABI = [
  "function nonces(address) view returns (uint256)",
];

// ─── State ───────────────────────────────────────────────────────────────────
let provider, relayerWallet, bundlerContract, entryPointContract, config;
let pendingRequests = []; // For manual admin approval flow

// ─── Mutex for serializing ALL blockchain transactions ───────────────────────
// Hardhat automining mode mines each tx instantly. If two txs are sent
// concurrently from the same wallet, the second gets a stale nonce.
// This mutex ensures only one tx flies at a time.
class Mutex {
  constructor() { this._queue = []; this._locked = false; }
  async acquire() {
    return new Promise(resolve => {
      if (!this._locked) { this._locked = true; resolve(); }
      else { this._queue.push(resolve); }
    });
  }
  release() {
    if (this._queue.length > 0) { this._queue.shift()(); }
    else { this._locked = false; }
  }
}
const txMutex = new Mutex();

async function withMutex(fn) {
  await txMutex.acquire();
  try { return await fn(); }
  finally { txMutex.release(); }
}

async function init() {
  console.log(`📡 Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB Connected.");

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
  const baseWallet = new ethers.Wallet(relayerKey, provider);
  relayerWallet = new ethers.NonceManager(baseWallet);

  bundlerContract = new ethers.Contract(config.contracts.Bundler, BUNDLER_ABI, relayerWallet);
  entryPointContract = new ethers.Contract(config.contracts.EntryPoint, ENTRYPOINT_ABI, provider);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  ERC-4337 Bundler Relay Server");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Relayer:    ${relayerWallet.address}`);
  console.log(`  Bundler:    ${config.contracts.Bundler}`);
  console.log(`  EntryPoint: ${config.contracts.EntryPoint}`);
  console.log(`  Paymaster:  ${config.contracts.Paymaster}`);
  console.log(`  Listening:  http://localhost:${PORT}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

async function signUserOp(op, nonce) {
  // Check if contract exists
  const code = await provider.getCode(op.sender);
  if (code === "0x") {
    throw new Error(`SmartWallet ${op.sender} not found on current chain. Did you reset the node? Please refresh the browser.`);
  }

  // Get SmartWallet owner
  const smartWallet = new ethers.Contract(op.sender, SMART_WALLET_ABI, provider);
  let ownerAddr;
  try {
     ownerAddr = (await smartWallet.owner()).toLowerCase();
  } catch (e) {
     throw new Error(`Failed to read owner of SmartWallet ${op.sender}. Address might not be a valid SmartWallet on this chain.`);
  }

  const privateKey = PRIVATE_KEYS[ownerAddr];
  if (!privateKey) {
    throw new Error(`No private key found for SmartWallet owner ${ownerAddr}. Are you using a custom wallet?`);
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

/**
 * Sign UserOp for Paymaster validation (Backend Oracle Signature)
 */
async function signPaymasterOp(op, nonce) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["address", "address", "bytes32", "uint256"],
    [op.sender, op.target, ethers.keccak256(op.data), nonce]
  );
  const hash = ethers.keccak256(encoded);
  
  // Use the RELAYER's wallet to sign (this is the verifyingSigner in the contract)
  const signature = await relayerWallet.signMessage(ethers.getBytes(hash));
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
  try {
    const iface = new ethers.Interface([
      "function approveByBuyer(uint256 id)",
      "function fundInvoice(uint256 id)",
      "function acceptBid(uint256 id, address winningFinancier)",
    ]);
    
    // We wrap the interceptor in an awaitable block so we can early-return safely
    await (async () => {
      let decoded;
      try {
        decoded = iface.parseTransaction({ data: op.data });
      } catch (e) { return; } // Not an interceptable call

      if (decoded && (decoded.name === "approveByBuyer" || decoded.name === "fundInvoice" || decoded.name === "acceptBid")) {
        const id = decoded.args[0];
        const fnName = decoded.name;
        console.log(`   💡 Auto-Deposit intercepted ${fnName}(#${id})`);

        let swToDepositFor = op.sender; 
        if (fnName === "acceptBid") {
            swToDepositFor = decoded.args[1]; 
        }

        const invContract = new ethers.Contract(
          op.target,
          ["function invoices(uint256) view returns (uint256,address,address,uint256,uint256,bool,bool,bool,bool,string,address)", "function depositFor(address) payable", "function deposits(address) view returns (uint256)"],
          provider
        );

        const inv = await invContract.invoices(id);
        const invoiceAmount = inv[3];
        let requiredDeposit = (fnName === "approveByBuyer") ? invoiceAmount : (invoiceAmount * 90n) / 100n;

        const currentDeposit = await invContract.deposits(swToDepositFor);

        if (currentDeposit < requiredDeposit) {
          const needed = requiredDeposit - currentDeposit;
          
          const code = await provider.getCode(swToDepositFor);
          if (code === "0x") {
            console.log(`   ⚠️  SmartWallet ${swToDepositFor} not found, skipping deposit`);
            return;
          }

          const targetSW = new ethers.Contract(swToDepositFor, SMART_WALLET_ABI, provider);
          let ownerAddr;
          try {
            ownerAddr = (await targetSW.owner()).toLowerCase();
          } catch (e) {
            console.log(`   ⚠️  Failed to read owner of ${swToDepositFor}`);
            return;
          }

          console.log(`   ⚡ Pulling ${ethers.formatEther(needed)} ETH from EOA (${ownerAddr})...`);
          const privateKey = PRIVATE_KEYS[ownerAddr];
          if (privateKey) {
            const eoaWallet = new ethers.Wallet(privateKey, provider);
            const depTx = await invContract.connect(eoaWallet).depositFor(swToDepositFor, { value: needed });
            await depTx.wait();
            console.log(`   ✅ Deposited ${ethers.formatEther(needed)} ETH`);
          }
        }
      }
    })();
  } catch (e) {
    console.warn(`   ⚠️  Interceptor failed: ${e.message}`);
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Step 2: Generate Paymaster signature (Oracle)
  let paymasterData = "0x";
  if (op.paymaster && op.paymaster !== ethers.ZeroAddress) {
    paymasterData = await signPaymasterOp(op, nonce);
    console.log(`   ✅ Signed by Paymaster Oracle (Relayer)`);
  }

  const fullOp = {
    sender:        op.sender,
    target:        op.target,
    data:          op.data,
    signature:     signature,
    paymaster:     op.paymaster,
    paymasterData: paymasterData,
    nonce:         nonce,
  };

  try {
    const tx = await bundlerContract.bundleOne(fullOp);
    const receipt = await tx.wait();
    console.log(`   ✅ Executed! TX: ${tx.hash}`);
    return { txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
  } catch (err) {
    let revertReason = err.message;
    if (err.data && err.data.startsWith("0x08c379a0")) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + err.data.slice(10));
      revertReason = `Reverted: ${decoded[0]}`;
    }
    console.error(`   ❌ Revert: ${revertReason}`);
    throw new Error(revertReason);
  }
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

          const result = await withMutex(() => handleSubmit(op));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
          console.error(`   ❌ Error: ${err.message}\n`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else if (req.method === "POST" && req.url === "/api/sign-paymaster-ticket") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const op = JSON.parse(body);
          if (!op.sender || !op.target || !op.data) throw new Error("Missing operation fields");

          // 🔥 LEVEL 1 OPTIMIZATION: Check MongoDB instead of JSON file!
          const senderLower = op.sender.toLowerCase();
          const userDoc = await User.findOne({ 
            $or: [
              { address: senderLower },
              { smartWallet: senderLower }
            ],
            isWhitelisted: true 
          });
          
          if (!userDoc) {
             throw new Error("Paymaster Oracle: User is NOT whitelisted in MongoDB.");
          }

          // Step 1: Reconstruct the exact hash that the Paymaster will verify
          const nonce = await entryPointContract.nonces(op.sender);
          const hashToSign = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "bytes32", "uint256"],
            [op.sender, op.target, ethers.keccak256(op.data), nonce]
          ));

          // Step 2: Sign it with the Backend Oracle Key
          const oracleWallet = new ethers.Wallet(config.backendOracle.privateKey);
          const oracleSignature = await oracleWallet.signMessage(ethers.getBytes(hashToSign));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, signature: oracleSignature }));
        } catch (err) {
          console.error("   ❌ Oracle Error:", err.message);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else if (req.method === "POST" && req.url === "/api/request-join") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { wallet, role, pk } = JSON.parse(body);
          if (!wallet || !role || !pk) throw new Error("Missing wallet, role, or private key (pk)");
          
          if (!pendingRequests.find(r => r.wallet.toLowerCase() === wallet.toLowerCase())) {
            pendingRequests.push({ wallet, role, timestamp: Date.now() });
            
            // Save PK securely so we can do zero-popup auto-signing for them
            const wl = wallet.toLowerCase();
            PRIVATE_KEYS[wl] = pk;
            
            // Persist to dynamic_keys.json
            let savedKeys = {};
            if (fs.existsSync(dynamicKeysPath)) savedKeys = JSON.parse(fs.readFileSync(dynamicKeysPath, "utf8"));
            savedKeys[wl] = pk;
            fs.writeFileSync(dynamicKeysPath, JSON.stringify(savedKeys, null, 2));

            console.log(`   📝 New registration request from ${wallet} for role ${role}. (Private key stored)`);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else if (req.method === "GET" && req.url === "/api/pending-requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, pendingRequests }));
    } else if (req.method === "POST" && req.url === "/api/approve-join") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { wallet } = JSON.parse(body);
          const reqItem = pendingRequests.find(r => r.wallet.toLowerCase() === wallet.toLowerCase());
          if (!reqItem) throw new Error("Request not found");

          // Enqueue ALL blockchain transactions through the serial queue
          const result = await withMutex(async () => {
            console.log(`   🚀 Approving ${wallet} (Role: ${reqItem.role})...`);
            
            // 1. Deploy SmartWallet
            const swArtifact = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/SmartWallet.sol/SmartWallet.json"), "utf8"));
            const swFactory = new ethers.ContractFactory(swArtifact.abi, swArtifact.bytecode, relayerWallet);
            console.log(`      Deploying SmartWallet...`);
            const sw = await swFactory.deploy(wallet, config.contracts.EntryPoint, config.contracts.Paymaster);
            await sw.waitForDeployment();
            console.log(`      ✅ SmartWallet deployed at: ${sw.target}`);

            // 2. Off-chain database validation logic goes here
            // 🔥 LEVEL 1 OPTIMIZATION: Save to MongoDB!
            await User.findOneAndUpdate(
              { address: wallet.toLowerCase() },
              { address: wallet.toLowerCase(), role: reqItem.role, smartWallet: sw.target, isWhitelisted: true },
              { upsert: true }
            );
            console.log(`      ✅ Added to MongoDB whitelist!`);

            // 3. Update deployed.json (we still keep this for frontend config, but logic uses Mongo)
            const configPath = path.join(__dirname, "..", "frontend", "deployed.json");
            const curConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
            curConfig.dynamicUsers = curConfig.dynamicUsers || {};
            curConfig.dynamicUsers[wallet.toLowerCase()] = { role: reqItem.role, smartWallet: sw.target };
            fs.writeFileSync(configPath, JSON.stringify(curConfig, null, 2));

            return sw.target;
          });

          // 4. Remove from pending queue
          pendingRequests = pendingRequests.filter(r => r.wallet.toLowerCase() !== wallet.toLowerCase());

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, smartWallet: result }));
        } catch (err) {
          console.error("   ❌ Error approving join:", err.message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else if (req.method === "GET" && req.url === "/api/admin/users") {
      // 🔥 LEVEL 1 OPTIMIZATION: Return all users from MongoDB
      try {
        const users = await User.find({ isWhitelisted: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, users }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    } else if (req.method === "POST" && req.url === "/api/admin/remove-user") {
      // 🔥 LEVEL 1 OPTIMIZATION: Remove from MongoDB off-chain
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { wallet } = JSON.parse(body);
          if (!wallet) throw new Error("Missing wallet address");
          
          await User.findOneAndUpdate(
            { address: wallet.toLowerCase() },
            { isWhitelisted: false }
          );
          
          console.log(`   ⛔ Admin removed user ${wallet} from MongoDB.`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    } else if (req.method === "POST" && req.url === "/api/admin/add-user") {
      // 🔥 LEVEL 1 OPTIMIZATION: Add to MongoDB off-chain
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { wallet, role } = JSON.parse(body);
          if (!wallet || !role) throw new Error("Missing wallet or role");
          
          await User.findOneAndUpdate(
            { address: wallet.toLowerCase() },
            { address: wallet.toLowerCase(), role, isWhitelisted: true },
            { upsert: true }
          );
          
          console.log(`   ✅ Admin whitelisted user ${wallet} (${role}) in MongoDB.`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
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
