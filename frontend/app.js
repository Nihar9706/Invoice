/* ═══════════════════════════════════════════════════════════════════════════
   Invoice Finance DApp — Frontend Logic (ERC-4337 Account Abstraction)
   ═══════════════════════════════════════════════════════════════════════════
   
   All contract-mutating operations go through the ERC-4337 AA flow:
     Frontend → Bundler Relay → Bundler Contract → EntryPoint → SmartWallet → InvoiceContract
   
   Only ETH deposits use MetaMask directly (payable calls require ETH transfer).
   Everything else is GASLESS with ZERO MetaMask popups.
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Globals ──────────────────────────────────────────────────────────────────
let provider, readProvider, signer, connectedAddr;
let invoiceContract, invoiceReadContract, paymasterContract, paymasterReadContract;
let autoKeeperContract, smartWalletContract;
let CONFIG = null;
let ROLE = null;
let userSmartWallet = null;   // SmartWallet address for the connected user
let allInvoices = [];
const API_URL = "http://localhost:3003/api";
let _refreshTimer = null;

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const INVOICE_ABI = [
  "function uploadInvoice(address buyer, uint256 amount, uint256 dueDate) external",
  "function approveByBuyer(uint256 id) external",
  "function depositEscrow(uint256 id) external payable",
  "function escrowFromDeposit(uint256 id) external",
  "function fundInvoice(uint256 id) external",
  "function releaseDueDatePayment(uint256 id) external",
  "function setBuyerCondition(uint256 maxAmount, address allowedSupplier) external",
  "function setFinancierCondition(uint256 maxAmount, address allowedBuyer) external",
  "function startBidding(uint256 id) external",
  "function acceptBid(uint256 id, address winningFinancier, uint256 _advanceRate, uint256 _interestRate) external",
  "function depositFunds() external payable",
  "function depositFor(address beneficiary) external payable",
  "function withdrawFunds(uint256 amount) external",
  "function invoices(uint256) external view returns (uint256, address, address, uint256, uint256, bool, bool, bool, bool, string, address)",
  "function counter() external view returns (uint256)",
  "function deposits(address) external view returns (uint256)",
  "function buyerConditions(address) external view returns (uint256, address)",
  "function financierConditions(address) external view returns (uint256, address)",

  "event InvoiceUploaded(uint256 indexed id, address supplier, address buyer, uint256 amount)",
  "event AutoApproved(uint256 indexed id, string reason)",
  "event BuyerApproved(uint256 indexed id)",
  "event EscrowDeposited(uint256 indexed id, uint256 amount)",
  "event AutoFinanced(uint256 indexed id, address indexed financier, uint256 supplierPayout)",
  "event Financed(uint256 indexed id, address indexed financier, uint256 supplierPayout)",
  "event Paid(uint256 indexed id, address indexed financier, uint256 financierPayout)",
  "event BuyerConditionSet(address indexed buyer, uint256 maxAmount, address allowedSupplier)",
  "event FinancierConditionSet(address indexed financier, uint256 maxAmount, address allowedBuyer)",
  "event Deposited(address indexed user, uint256 amount, uint256 newBalance)",
  "event Withdrawn(address indexed user, uint256 amount, uint256 newBalance)",
];

const PAYMASTER_ABI = [
  "function addUser(address user) external",
  "function removeUser(address user) external",
  "function validate(address sender) external view returns (bool)",
  "function allowed(address) external view returns (bool)",
  "function getDeposit() external view returns (uint256)",
  "function owner() external view returns (address)",
];

const AUTOKEEPER_ABI = [
  "function releaseAll() external",
  "function checkAndRelease(uint256[] calldata invoiceIds) external",
];

const SMART_WALLET_ABI = [
  "function execute(address target, bytes calldata data) external payable",
  "function owner() external view returns (address)",
];

// ═════════════════════════════════════════════════════════════════════════════
//  INIT — Load deployed config
// ═════════════════════════════════════════════════════════════════════════════

async function loadConfig() {
  try {
    const resp = await fetch("deployed.json");
    if (!resp.ok) throw new Error("deployed.json not found");
    CONFIG = await resp.json();
    console.log("✅ Config loaded:", CONFIG);
    return true;
  } catch (err) {
    console.error("❌ Failed to load deployed.json:", err);
    showToast("Deploy contracts first: npx hardhat run scripts/deploy.js --network localhost", "error");
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ERC-4337 — Send UserOperation (GASLESS, ZERO MetaMask POPUP)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Send a UserOperation through the ERC-4337 AA flow.
 * The bundler-relay server handles signing and on-chain submission.
 * NO MetaMask popup — completely gasless for the user.
 *
 * @param {string} targetAddr - Contract address to call
 * @param {string} calldata   - ABI-encoded function call data
 * @returns {object}          - { success, txHash, gasUsed }
 */
async function sendUserOp(targetAddr, calldata) {
  if (!userSmartWallet) {
    throw new Error("No SmartWallet found for your role. Are you connected with a known address?");
  }

  const relayUrl = CONFIG.bundlerRelayUrl || "http://localhost:3001";

  const response = await fetch(`${relayUrl}/submit-userop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: userSmartWallet,
      target: targetAddr,
      data: calldata,
      paymaster: CONFIG.contracts.Paymaster,
    }),
  });

  const result = await response.json();

  if (!result.success) {
    throw new Error(result.error || "UserOp failed");
  }

  console.log(`✅ UserOp executed via AA — TX: ${result.txHash}, Gas: ${result.gasUsed}`);
  return result;
}

/**
 * Helper: encode a contract function call and send as UserOp
 */
async function sendAACall(abi, targetAddr, functionName, args = []) {
  const iface = new ethers.Interface(abi);
  const calldata = iface.encodeFunctionData(functionName, args);
  return sendUserOp(targetAddr, calldata);
}

// ═════════════════════════════════════════════════════════════════════════════
//  CONNECT WALLET
// ═════════════════════════════════════════════════════════════════════════════

async function connectWallet() {
  if (!window.ethereum) {
    showToast("MetaMask not detected! Install MetaMask extension.", "error");
    return;
  }

  const ok = await loadConfig();
  if (!ok) return;

  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    connectedAddr = accounts[0].toLowerCase();

    // Direct JSON-RPC provider for READ calls — bypasses MetaMask cache entirely
    readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);

    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();

    // We MUST check MetaMask's active chain, not the direct node's chain
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);

    if (chainId !== CONFIG.chainId) {
      await switchToHardhat();
      return;
    }

    // Read contracts — use readProvider (no MetaMask cache issues)
    invoiceReadContract = new ethers.Contract(CONFIG.contracts.InvoiceContract, INVOICE_ABI, readProvider);
    paymasterReadContract = new ethers.Contract(CONFIG.contracts.Paymaster, PAYMASTER_ABI, readProvider);

    // Write contracts — use signer (for direct payable calls)
    invoiceContract = new ethers.Contract(CONFIG.contracts.InvoiceContract, INVOICE_ABI, signer);
    paymasterContract = new ethers.Contract(CONFIG.contracts.Paymaster, PAYMASTER_ABI, signer);
    autoKeeperContract = new ethers.Contract(CONFIG.contracts.AutoKeeper, AUTOKEEPER_ABI, signer);

    // Detect role & SmartWallet
    detectRole();

    // Initialize SmartWallet contract (for payable calls that must go through SmartWallet)
    if (userSmartWallet) {
      smartWalletContract = new ethers.Contract(userSmartWallet, SMART_WALLET_ABI, signer);
    }

    // Check bundler relay health
    await checkBundlerRelay();

    // Register/Check user in backend
    await syncUserToBackend();

    updateHeader();

    document.getElementById("connectScreen").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");

    showRoleSection();

    await refreshInvoices();
    await loadConditions();
    await updateDepositBalance();
    await updateStats();

    setupEventListeners();

    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());

    const aaStatus = userSmartWallet ? "🔗 AA Enabled" : "⚠️ No SmartWallet";
    showToast(`Connected as ${ROLE || "Unknown"}: ${truncAddr(connectedAddr)} | ${aaStatus}`, "success");

    // Start notification heartbeat (once connected)
    startNotificationHeartbeat();

  } catch (err) {
    console.error("Connection failed:", err);
    showToast("Connection failed: " + (err.message || err), "error");
  }
}

// ─── Notification Heartbeat (Persistent Consensus Alerts) ──────────────────
let notificationCheckInterval = null;

function startNotificationHeartbeat() {
  if (notificationCheckInterval) clearInterval(notificationCheckInterval);

  // Initial check
  checkUnreadNotifications();

  // Set interval (every 2 seconds for high-speed consensus feedback)
  notificationCheckInterval = setInterval(checkUnreadNotifications, 2000);
}

async function checkUnreadNotifications() {
  if (!connectedAddr) return;

  try {
    const resp = await fetch(`${API_URL}/notifications/unread`, {
      headers: { "x-wallet-address": connectedAddr }
    });
    const data = await resp.json();

    if (data.success && data.notifications.length > 0) {
      for (const note of data.notifications) {
        showToast(note.message, note.type || "info");
        await acknowledgeNotification(note._id);

        // Immediate UI refresh upon consensus message
        debouncedRefresh();
      }
    }
  } catch (e) {
    console.error("🔔 Heartbeat error:", e);
  }
}

async function acknowledgeNotification(id) {
  try {
    await fetch(`${API_URL}/notifications/${id}/read`, {
      method: "PATCH",
      headers: { "x-wallet-address": connectedAddr }
    });
  } catch (e) {
    console.warn("⚠️ Failed to acknowledge notification:", id);
  }
}

async function checkBundlerRelay() {
  try {
    const relayUrl = CONFIG.bundlerRelayUrl || "http://localhost:3001";
    const resp = await fetch(`${relayUrl}/health`);
    if (resp.ok) {
      console.log("✅ Bundler relay is running");
      return true;
    }
  } catch (e) {
    console.warn("⚠️ Bundler relay not reachable at", CONFIG.bundlerRelayUrl);
    showToast("⚠️ Bundler relay not running! Start it: node scripts/bundler-relay.js", "error");
  }
  return false;
}

// ─── Backend Sync ─────────────────────────────────────────────────────────────
async function syncUserToBackend() {
  try {
    // This will create the user in MongoDB if they don't exist
    const resp = await fetch(`${API_URL}/voting/network-nodes`, {
      headers: { "x-wallet-address": connectedAddr }
    });
    const data = await resp.json();
    if (data.success) {
      console.log("✅ User synced to backend");
      renderGovernanceInfo(data.nodes);
    }
  } catch (e) {
    console.warn("⚠️ Backend not reachable. Governance features disabled.");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  NETWORK SWITCH
// ═════════════════════════════════════════════════════════════════════════════

async function switchToHardhat() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + CONFIG.chainId.toString(16) }],
    });
    location.reload();
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x" + CONFIG.chainId.toString(16),
          chainName: "Hardhat Local",
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: [CONFIG.rpcUrl],
        }],
      });
      location.reload();
    } else {
      showToast("Switch to Hardhat Local network (chain ID 31337) in MetaMask", "error");
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROLE DETECTION — maps EOA to SmartWallet
// ═════════════════════════════════════════════════════════════════════════════

function detectRole() {
  const addr = connectedAddr.toLowerCase();

  // Search through all role arrays in CONFIG
  const sIdx = CONFIG.roles.suppliers.findIndex(a => a.toLowerCase() === addr);
  if (sIdx !== -1) {
    ROLE = "supplier";
    userSmartWallet = CONFIG.contracts.SupplierWallets[sIdx];
    return;
  }

  const bIdx = CONFIG.roles.buyers.findIndex(a => a.toLowerCase() === addr);
  if (bIdx !== -1) {
    ROLE = "buyer";
    userSmartWallet = CONFIG.contracts.BuyerWallets[bIdx];
    return;
  }

  const fIdx = CONFIG.roles.financiers.findIndex(a => a.toLowerCase() === addr);
  if (fIdx !== -1) {
    ROLE = "financier";
    userSmartWallet = CONFIG.contracts.FinancierWallets[fIdx];
    return;
  }

  if (addr === CONFIG.roles.owner.toLowerCase()) {
    ROLE = "admin";
    userSmartWallet = null;
  } else if (!ROLE) {
    ROLE = null;
    userSmartWallet = null;
  }

  console.log(`🔑 Role: ${ROLE}, SmartWallet: ${userSmartWallet || "none"}`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  UI UPDATES
// ═════════════════════════════════════════════════════════════════════════════

async function updateHeader() {
  const addrEl = document.getElementById("walletAddr");
  addrEl.textContent = truncAddr(connectedAddr);
  addrEl.classList.remove("hidden");

  const balance = await readProvider.getBalance(connectedAddr);
  const balEl = document.getElementById("ethBalance");
  balEl.textContent = parseFloat(ethers.formatEther(balance)).toFixed(3) + " ETH";
  balEl.classList.remove("hidden");

  const netBadge = document.getElementById("networkBadge");
  netBadge.classList.remove("hidden");

  // AA badge
  const aaBadge = document.getElementById("aaBadge");
  if (aaBadge && userSmartWallet) {
    aaBadge.textContent = "⛓️ ERC-4337";
    aaBadge.classList.remove("hidden");
  }

  const roleBadge = document.getElementById("roleBadge");
  if (ROLE) {
    roleBadge.textContent = ROLE === "admin" ? "⚙️ Admin" :
      ROLE === "supplier" ? "📦 Supplier" :
        ROLE === "buyer" ? "🛒 Buyer" : "💰 Financier";
    roleBadge.className = `role-badge ${ROLE}`;
    roleBadge.classList.remove("hidden");
  }

  document.getElementById("connectBtn").textContent = "✅ Connected";
  document.getElementById("connectBtn").disabled = true;
}

function showRoleSection() {
  ["supplierSection", "buyerSection", "financierSection", "unknownSection"].forEach(id => {
    document.getElementById(id).classList.add("hidden");
  });

  if (ROLE === "supplier") {
    document.getElementById("supplierSection").classList.remove("hidden");
    populateBuyerDropdown();
  } else if (ROLE === "buyer") {
    document.getElementById("buyerSection").classList.remove("hidden");
  } else if (ROLE === "financier") {
    document.getElementById("financierSection").classList.remove("hidden");
  } else if (ROLE === "admin") {
    document.getElementById("supplierSection").classList.remove("hidden");
  } else {
    const sStr = (CONFIG.roles.suppliers || []).join(", ");
    const bStr = (CONFIG.roles.buyers || []).join(", ");
    const fStr = (CONFIG.roles.financiers || []).join(", ");

    document.getElementById("unknownSection").classList.remove("hidden");
    document.getElementById("expectedAddrs").innerHTML = `
      Suppliers: ${sStr || "none"}<br> 
      Buyers: ${bStr || "none"}<br>
      Financiers: ${fStr || "none"}<br>
      Admin: ${CONFIG.roles.owner}
    `;
  }

  document.getElementById("adminTab").classList.toggle("hidden", ROLE !== "admin");
}

/**
 * Populate the Buyer dropdown for Suppliers
 */
function populateBuyerDropdown() {
  const select = document.getElementById("invBuyer");
  if (!select) return;

  if (!CONFIG || !CONFIG.roles.buyers || !CONFIG.contracts.BuyerWallets) {
    console.warn("⚠️ No buyers found in CONFIG");
    return;
  }

  select.innerHTML = ""; // Clear

  CONFIG.roles.buyers.forEach((eoa, idx) => {
    const sw = CONFIG.contracts.BuyerWallets[idx];
    if (!sw) return;

    const op = document.createElement("option");
    // We store the SmartWallet address as the value because the contract 
    // expects the SmartWallet address for account abstraction flows.
    op.value = sw;
    op.textContent = `Buyer ${idx + 1} (${truncAddr(eoa)})`;
    select.appendChild(op);
  });

  console.log(`✅ Populated Buyer dropdown with ${CONFIG.roles.buyers.length} buyers`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  INVOICE ACTIONS — ALL via ERC-4337 AA (ZERO MetaMask popups)
// ═════════════════════════════════════════════════════════════════════════════

// ── Upload Invoice (Supplier) — GASLESS via AA ───────────────────────────────
let _uploadLock = false;
async function uploadInvoice() {
  // ── Double-click guard ──────────────────────────────────────────────────
  if (_uploadLock) return;
  _uploadLock = true;

  const btn = document.getElementById("uploadBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Uploading via AA...';

  try {
    const buyerAddr = document.getElementById("invBuyer").value.trim();
    const amtStr = document.getElementById("invAmount").value.trim();
    const dueMins = parseInt(document.getElementById("invDueMins").value, 10);

    if (!buyerAddr || !amtStr) {
      showToast("Fill in all fields", "error");
      return;
    }
    if (isNaN(dueMins) || dueMins < 1 || dueMins > 30) {
      showToast("Due time must be between 1 and 30 minutes", "error");
      return;
    }

    // Resolve buyer address: check if it matches any Buyer EOA
    let resolvedBuyer = buyerAddr.toLowerCase();
    const bIdx = (CONFIG.roles.buyers || []).findIndex(a => a.toLowerCase() === resolvedBuyer);
    if (bIdx !== -1) {
      resolvedBuyer = CONFIG.contracts.BuyerWallets[bIdx];
    }

    const amount = ethers.parseEther(amtStr);

    // Use the blockchain's own timestamp (not browser clock) to avoid
    // "Due date in the past" errors from clock skew or evm_increaseTime
    const latestBlock = await readProvider.getBlock("latest");
    const chainNow = latestBlock.timestamp;
    const dueDate = chainNow + (dueMins * 60) + 120; // +120s buffer for tx processing

    const result = await sendAACall(
      INVOICE_ABI,
      CONFIG.contracts.InvoiceContract,
      "uploadInvoice",
      [resolvedBuyer, amount, dueDate]
    );
    showToast(`✅ Invoice uploaded via ERC-4337! TX: ${truncAddr(result.txHash)} (gasless)`, "success");
    await refreshInvoices();
  } catch (err) {
    console.error("Upload failed:", err);
    showToast("Upload failed: " + parseError(err), "error");
  } finally {
    _uploadLock = false;
    btn.disabled = false;
    btn.innerHTML = '📤 Upload Invoice';
  }
}

// ── Approve Invoice (Buyer) — GASLESS via AA ─────────────────────────────────
async function approveInvoice(id) {
  try {
    showToast(`⏳ Approving invoice #${id} via AA (gasless)...`, "info");
    await sendAACall(INVOICE_ABI, CONFIG.contracts.InvoiceContract, "approveByBuyer", [id]);
    showToast(`✅ Invoice #${id} approved via ERC-4337! (gasless)`, "success");
    await refreshInvoices();
    await updateStats();
  } catch (err) {
    showToast("Approve failed: " + parseError(err), "error");
  }
}

// ── Deposit Escrow (Buyer) — GASLESS via AA using pre-deposited balance ──────
async function depositEscrow(id) {
  try {
    showToast(`⏳ Escrowing invoice #${id} from pre-deposit via AA (gasless)...`, "info");
    await sendAACall(
      INVOICE_ABI,
      CONFIG.contracts.InvoiceContract,
      "escrowFromDeposit",
      [id]
    );
    showToast(`✅ Escrow locked for invoice #${id} via ERC-4337! (gasless)`, "success");
    await refreshInvoices();
    await updateDepositBalance();
    await updateStats();
  } catch (err) {
    showToast("Escrow failed: " + parseError(err), "error");
  }
}

// ── Fund Invoice (Financier) — GASLESS via AA ────────────────────────────────
async function fundInvoice(id) {
  try {
    showToast(`⏳ Funding invoice #${id} via AA (gasless)...`, "info");
    await sendAACall(INVOICE_ABI, CONFIG.contracts.InvoiceContract, "fundInvoice", [id]);
    showToast(`✅ Invoice #${id} funded via ERC-4337! Supplier received 90%. (gasless)`, "success");
    await refreshInvoices();
    await updateStats();
  } catch (err) {
    showToast("Fund failed: " + parseError(err), "error");
  }
}

// ── Release Due Date Payment — GASLESS via AA ────────────────────────────────
async function releasePayment(id) {
  try {
    showToast(`⏳ Releasing payment for invoice #${id} via AA...`, "info");
    await sendAACall(INVOICE_ABI, CONFIG.contracts.InvoiceContract, "releaseDueDatePayment", [id]);
    showToast(`✅ Invoice #${id} paid via ERC-4337! (gasless)`, "success");
    await refreshInvoices();
    await updateStats();
  } catch (err) {
    showToast("Release failed: " + parseError(err), "error");
  }
}

// ── Trigger AutoKeeper — GASLESS via AA ──────────────────────────────────────
async function triggerKeeper() {
  try {
    showToast("🤖 Running AutoKeeper via AA...", "info");
    await sendAACall(AUTOKEEPER_ABI, CONFIG.contracts.AutoKeeper, "releaseAll", []);
    showToast("✅ AutoKeeper executed via ERC-4337! (gasless)", "success");
    await refreshInvoices();
    await updateStats();
  } catch (err) {
    showToast("Keeper failed: " + parseError(err), "error");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SET CONDITIONS — GASLESS via AA
// ═════════════════════════════════════════════════════════════════════════════

async function setBuyerCondition() {
  const maxAmt = document.getElementById("buyerMaxAmt").value.trim();
  const supplier = document.getElementById("buyerAllowedSupplier").value.trim();

  if (!maxAmt) {
    showToast("Enter max auto-approve amount", "error");
    return;
  }

  const amount = ethers.parseEther(maxAmt);
  const allowedSupplier = supplier || ethers.ZeroAddress;

  try {
    showToast("⏳ Setting buyer condition via AA (gasless)...", "info");
    await sendAACall(
      INVOICE_ABI,
      CONFIG.contracts.InvoiceContract,
      "setBuyerCondition",
      [amount, allowedSupplier]
    );
    showToast(`✅ Condition set via ERC-4337: auto-approve ≤ ${maxAmt} ETH (gasless)`, "success");
    await loadConditions();
  } catch (err) {
    showToast("Failed: " + parseError(err), "error");
  }
}

async function setFinancierCondition() {
  const maxAmt = document.getElementById("finMaxAmt").value.trim();
  const buyer = document.getElementById("finAllowedBuyer").value.trim();

  if (!maxAmt) {
    showToast("Enter max auto-fund amount", "error");
    return;
  }

  const amount = ethers.parseEther(maxAmt);
  const allowedBuyer = buyer || ethers.ZeroAddress;

  try {
    showToast("⏳ Setting financier condition via AA (gasless)...", "info");
    await sendAACall(
      INVOICE_ABI,
      CONFIG.contracts.InvoiceContract,
      "setFinancierCondition",
      [amount, allowedBuyer]
    );
    showToast(`✅ Condition set via ERC-4337: auto-fund ≤ ${maxAmt} ETH (gasless)`, "success");
    await loadConditions();
  } catch (err) {
    showToast("Failed: " + parseError(err), "error");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  DEPOSIT / WITHDRAW
//  depositFunds → uses depositFor() via MetaMask (1 popup, ETH transfer needed)
//  withdrawFunds → GASLESS via AA (no ETH transfer needed)
// ═════════════════════════════════════════════════════════════════════════════

async function depositFunds() {
  const inputId = (ROLE === "buyer") ? "buyerDepositAmount" : "finDepositAmount";
  const amtStr = document.getElementById(inputId).value.trim();
  if (!amtStr || parseFloat(amtStr) <= 0) {
    showToast("Enter a valid deposit amount", "error");
    return;
  }

  try {
    showToast(`⏳ Depositing ${amtStr} ETH for SmartWallet (1 MetaMask confirm)...`, "info");
    // Use depositFor to credit the SmartWallet's balance — this is the ONLY MetaMask popup
    const tx = await invoiceContract.depositFor(userSmartWallet, { value: ethers.parseEther(amtStr) });
    await tx.wait();
    showToast(`✅ Deposited ${amtStr} ETH for SmartWallet! Auto-flow is funded.`, "success");
    document.getElementById(inputId).value = "";
    await updateDepositBalance();
    await updateHeader();
  } catch (err) {
    showToast("Deposit failed: " + parseError(err), "error");
  }
}

async function withdrawFunds() {
  const inputId = (ROLE === "buyer") ? "buyerDepositAmount" : "finDepositAmount";
  const amtStr = document.getElementById(inputId).value.trim();

  if (!amtStr || parseFloat(amtStr) <= 0) {
    showToast("Enter a valid withdraw amount", "error");
    return;
  }

  try {
    showToast(`⏳ Withdrawing ${amtStr} ETH via AA (gasless)...`, "info");
    await sendAACall(
      INVOICE_ABI,
      CONFIG.contracts.InvoiceContract,
      "withdrawFunds",
      [ethers.parseEther(amtStr)]
    );
    showToast(`✅ Withdrew ${amtStr} ETH via ERC-4337! (gasless)`, "success");
    document.getElementById(inputId).value = "";
    await updateDepositBalance();
    await updateHeader();
  } catch (err) {
    showToast("Withdraw failed: " + parseError(err), "error");
  }
}

async function updateDepositBalance() {
  if (!invoiceReadContract || !userSmartWallet) return;
  try {
    const buyerEl = document.getElementById("buyerContractDeposit");
    const finEl = document.getElementById("finContractDeposit");
    if (!buyerEl && !finEl) return; // UI components removed

    const bal = await invoiceReadContract.deposits(userSmartWallet);
    const valText = parseFloat(ethers.formatEther(bal)).toFixed(4) + " ETH";
    if (buyerEl) buyerEl.textContent = valText;
    if (finEl) finEl.textContent = valText;
  } catch (err) {
    console.error("Failed to read deposit balance:", err);
  }
}

async function loadConditions() {
  // Logic disabled as UI components were removed by user request
  return;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN — direct MetaMask calls (admin doesn't have SmartWallet)
// ═════════════════════════════════════════════════════════════════════════════

async function adminAddUser() {
  const addr = document.getElementById("adminWhitelistAddr").value.trim();
  if (!addr) return showToast("Enter address", "error");
  try {
    const tx = await paymasterContract.addUser(addr);
    await tx.wait();
    showToast(`✅ ${truncAddr(addr)} whitelisted`, "success");
    await loadAdminInfo();
  } catch (err) {
    showToast("Failed: " + parseError(err), "error");
  }
}

async function adminRemoveUser() {
  const addr = document.getElementById("adminWhitelistAddr").value.trim();
  if (!addr) return showToast("Enter address", "error");
  try {
    const tx = await paymasterContract.removeUser(addr);
    await tx.wait();
    showToast(`✅ ${truncAddr(addr)} removed`, "success");
    await loadAdminInfo();
  } catch (err) {
    showToast("Failed: " + parseError(err), "error");
  }
}

async function loadAdminInfo() {
  if (ROLE !== "admin") return;
  try {
    const deposit = await paymasterReadContract.getDeposit();

    const supSW = await paymasterReadContract.allowed(CONFIG.contracts.SupplierSmartWallet);
    const buySW = await paymasterReadContract.allowed(CONFIG.contracts.BuyerSmartWallet);
    const finSW = await paymasterReadContract.allowed(CONFIG.contracts.FinancierSmartWallet);

    document.getElementById("paymasterInfo").innerHTML = `
      <div style="display:flex;flex-direction:column;gap:0.75rem;">
        <div class="condition-status active">
          💰 Paymaster EntryPoint Deposit: <strong>${ethers.formatEther(deposit)} ETH</strong>
        </div>
        <div style="font-size:0.85rem;color:var(--text-secondary);">
          <p>Contract: <span class="addr">${truncAddr(CONFIG.contracts.Paymaster)}</span></p>
        </div>
      </div>
    `;

    document.getElementById("whitelistStatus").innerHTML = `
      <div style="font-size:0.85rem;">
        <p><strong>SmartWallet Whitelist (ERC-4337):</strong></p>
        <p>📦 Supplier SW: ${supSW ? '✅' : '❌'} <span class="addr">${truncAddr(CONFIG.contracts.SupplierSmartWallet)}</span></p>
        <p>🛒 Buyer SW:    ${buySW ? '✅' : '❌'} <span class="addr">${truncAddr(CONFIG.contracts.BuyerSmartWallet)}</span></p>
        <p>💰 Financier SW: ${finSW ? '✅' : '❌'} <span class="addr">${truncAddr(CONFIG.contracts.FinancierSmartWallet)}</span></p>
      </div>
    `;
  } catch (err) {
    console.error("Admin info error:", err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  LOAD INVOICES
// ═════════════════════════════════════════════════════════════════════════════

async function refreshInvoices() {
  try {
    const count = Number(await invoiceReadContract.counter());
    allInvoices = [];

    // Fetch Metadata from Backend
    let metaMap = {};
    try {
      const metaResp = await fetch(`${API_URL}/invoices/metadata`, {
        headers: { "x-wallet-address": connectedAddr }
      });
      const metaData = await metaResp.json();
      if (metaData.success) {
        metaData.metadata.forEach(m => { metaMap[m.invoiceId] = m; });
      }
    } catch (e) { console.warn("Could not fetch invoice metadata:", e); }

    for (let i = 1; i <= count; i++) {
      const raw = await invoiceReadContract.invoices(i);
      allInvoices.push({
        id: Number(raw[0]),
        supplier: raw[1],
        buyer: raw[2],
        amount: raw[3],
        dueDate: Number(raw[4]),
        buyerVerified: raw[5],
        escrowLocked: raw[6],
        financierFunded: raw[7],
        isPaid: raw[8],
        status: raw[9],
        financier: raw[10],
        biddingTimeout: metaMap[i]?.biddingTimeout ? Math.floor(new Date(metaMap[i].biddingTimeout).getTime() / 1000) : null
      });
    }

    renderInvoicesForRole();
    renderAllInvoices();
    updateStats();
    if (ROLE === "admin") loadAdminInfo();

  } catch (err) {
    console.error("Refresh invoices error:", err);
    showToast("Failed to load invoices: " + parseError(err), "error");
  }
}

/**
 * Resolve an address: if it's a SmartWallet, show the role name
 */
function resolveAddr(addr) {
  if (!addr || !CONFIG) return truncAddr(addr);
  const a = addr.toLowerCase();

  // Check SmartWallets
  if (CONFIG.contracts.SupplierWallets?.some(sw => sw.toLowerCase() === a)) return "📦 Supplier SW";
  if (CONFIG.contracts.BuyerWallets?.some(sw => sw.toLowerCase() === a)) return "🛒 Buyer SW";
  if (CONFIG.contracts.FinancierWallets?.some(sw => sw.toLowerCase() === a)) return "💰 Financier SW";

  // Check EOA Roles
  if (CONFIG.roles.suppliers?.some(eoa => eoa.toLowerCase() === a)) return "📦 Supplier";
  if (CONFIG.roles.buyers?.some(eoa => eoa.toLowerCase() === a)) return "🛒 Buyer";
  if (CONFIG.roles.financiers?.some(eoa => eoa.toLowerCase() === a)) return "💰 Financier";

  if (a === CONFIG.roles.owner.toLowerCase()) return "⚙️ Admin";

  return truncAddr(addr);
}

function isMySmartWallet(addr) {
  if (!userSmartWallet || !addr) return false;
  return addr.toLowerCase() === userSmartWallet.toLowerCase();
}

function renderInvoicesForRole() {
  if (ROLE === "supplier") {
    const mine = allInvoices.filter(i => isMySmartWallet(i.supplier));
    document.getElementById("supplierInvoices").innerHTML = mine.length
      ? renderInvoiceTable(mine, "supplier")
      : emptyState("📭", "No invoices uploaded yet");
  }

  if (ROLE === "buyer") {
    const mine = allInvoices.filter(i => isMySmartWallet(i.buyer));
    document.getElementById("buyerInvoices").innerHTML = mine.length
      ? renderInvoiceTable(mine, "buyer")
      : emptyState("📭", "No invoices assigned to you");
  }

  if (ROLE === "financier") {
    // Show invoices the financier has funded, PLUS unfunded ones available to fund
    const mine = allInvoices.filter(i =>
      isMySmartWallet(i.financier) || (!i.financierFunded && !i.isPaid && i.buyerVerified)
    );
    document.getElementById("financierInvoices").innerHTML = mine.length
      ? renderInvoiceTable(mine, "financier")
      : emptyState("📭", "No invoices available");
  }
}

function renderAllInvoices() {
  document.getElementById("allInvoicesTable").innerHTML = allInvoices.length
    ? renderInvoiceTable(allInvoices, "all")
    : emptyState("📭", "No invoices created yet");
}

function renderInvoiceTable(invoices, perspective) {
  const now = Math.floor(Date.now() / 1000);

  const rows = invoices.map(inv => {
    const dueStr = new Date(inv.dueDate * 1000).toLocaleString();
    const pastDue = now >= inv.dueDate;
    const amtEth = ethers.formatEther(inv.amount);
    const secsLeft = inv.dueDate - now;

    // Build countdown HTML
    let countdownHtml = "";
    if (inv.isPaid) {
      countdownHtml = `<span style="color:var(--paid);font-weight:600;">✅ Paid</span>`;
    } else if (inv.status === "BIDDING" && inv.biddingTimeout) {
      const bidSecsLeft = inv.biddingTimeout - now;
      if (bidSecsLeft > 0) {
        const mm = Math.floor(bidSecsLeft / 60);
        const ss = bidSecsLeft % 60;
        const pct = Math.max(0, Math.min(100, (bidSecsLeft / (10 * 60)) * 100)); // normalized to 10 mins for bar
        countdownHtml = `
          <div class="countdown-timer" data-due="${inv.biddingTimeout}" data-type="bidding">
            <div style="font-size:0.75rem;color:var(--accent);margin-bottom:2px;font-weight:600;">🔥 BIDDING ENDS</div>
            <span style="font-weight:700;font-size:0.95rem;color:var(--accent);">${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}</span>
            <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-top:3px;">
              <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px;transition:width 1s linear;"></div>
            </div>
          </div>`;
      } else {
        countdownHtml = `<span style="color:var(--accent);font-weight:600;" class="countdown-pulse">⌛ FINALIZING...</span>`;
      }
    } else if (pastDue) {
      countdownHtml = `<span style="color:#ef4444;font-weight:600;" class="countdown-pulse">⏰ OVERDUE</span>`;
    } else {
      const mm = Math.floor(secsLeft / 60);
      const ss = secsLeft % 60;
      const pct = Math.max(0, Math.min(100, (secsLeft / (30 * 60)) * 100));
      const barColor = pct > 50 ? "#22c55e" : pct > 20 ? "#f59e0b" : "#ef4444";
      countdownHtml = `
        <div class="countdown-timer" data-due="${inv.dueDate}">
          <span style="font-weight:700;font-size:0.95rem;color:${barColor};">${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}</span>
          <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-top:3px;">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width 1s linear;"></div>
          </div>
        </div>`;
    }

    let actions = "";

    if (perspective === "buyer") {
      if (inv.status === "PENDING_BUYER") {
        actions += `<button class="btn btn-primary btn-sm" onclick="approveInvoice(${inv.id})">✅ Approve (AA)</button>`;
      }
      if (inv.status === "APPROVED" && !inv.escrowLocked) {
        actions += `<button class="btn btn-primary btn-sm" onclick="depositEscrow(${inv.id})">🔒 Escrow ${amtEth} ETH</button>`;
      }
    }

    if (perspective === "supplier") {
      if ((inv.status === "APPROVED" || inv.status === "ESCROWED") && !inv.financierFunded) {
        actions += `<button class="btn btn-accent btn-sm" onclick="startBidding(${inv.id})">💎 Start Bidding</button>`;
      }
      if (inv.status === "BIDDING" && !inv.financierFunded) {
        actions += `<button class="btn btn-accent btn-sm" onclick="viewBids(${inv.id})">👁️ View Bids</button>`;
      }
    }

    if (perspective === "financier") {
      if (inv.status === "ESCROWED" && !inv.financierFunded) {
        actions += `<button class="btn btn-purple btn-sm" onclick="fundInvoice(${inv.id})">💰 Fund (AA)</button>`;
      }
      if (inv.status === "BIDDING" && !inv.financierFunded) {
        actions += `<button class="btn btn-purple btn-sm" onclick="submitBid(${inv.id})">💎 Submit Bid</button>`;
      }
    }

    if (inv.status === "FINANCED" && pastDue && !inv.isPaid) {
      actions += `<button class="btn btn-success btn-sm" onclick="releasePayment(${inv.id})">🔓 Release (AA)</button>`;
    }

    return `<tr>
      <td><strong style="cursor:pointer;color:var(--accent);text-decoration:underline;" onclick="showLifecycle(${inv.id})">#${inv.id}</strong></td>
      <td>${resolveAddr(inv.supplier)}</td>
      <td>${resolveAddr(inv.buyer)}</td>
      <td class="eth-val">${amtEth} ETH</td>
      <td style="font-size:0.78rem;">${dueStr}</td>
      <td>${countdownHtml}</td>
      <td><span class="status-badge status-${inv.status}">${inv.status}</span></td>
      <td class="action-btns">${actions || '<span style="color:var(--text-muted);">—</span>'}</td>
    </tr>`;
  }).join("");

  return `
    <div style="overflow-x:auto;">
      <table class="invoice-table">
        <thead><tr>
          <th>ID</th><th>Supplier</th><th>Buyer</th><th>Amount</th><th>Due Date</th><th>⏱ Countdown</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─── Live countdown ticker (runs every second) ──────────────────────────────
let _countdownInterval = null;
function startCountdownTicker() {
  if (_countdownInterval) return;  // already running
  _countdownInterval = setInterval(() => {
    const timers = document.querySelectorAll(".countdown-timer[data-due]");
    if (!timers.length) return;

    const now = Math.floor(Date.now() / 1000);
    let needsRefresh = false;

    timers.forEach(el => {
      const due = parseInt(el.dataset.due, 10);
      const secsLeft = due - now;
      const isBidding = el.getAttribute("data-type") === "bidding";

      if (secsLeft <= 0) {
        el.innerHTML = isBidding
          ? `<span style="color:var(--accent);font-weight:600;" class="countdown-pulse">⌛ FINALIZING...</span>`
          : `<span style="color:#ef4444;font-weight:600;" class="countdown-pulse">⏰ OVERDUE</span>`;
        needsRefresh = true;
        return;
      }

      const mm = Math.floor(secsLeft / 60);
      const ss = secsLeft % 60;

      if (isBidding) {
        const pct = Math.max(0, Math.min(100, (secsLeft / (10 * 60)) * 100));
        el.innerHTML = `
          <div style="font-size:0.75rem;color:var(--accent);margin-bottom:2px;font-weight:600;">🔥 BIDDING ENDS</div>
          <span style="font-weight:700;font-size:0.95rem;color:var(--accent);">${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}</span>
          <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-top:3px;">
            <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px;transition:width 1s linear;"></div>
          </div>`;
      } else {
        const pct = Math.max(0, Math.min(100, (secsLeft / (30 * 60)) * 100));
        const barColor = pct > 50 ? "#22c55e" : pct > 20 ? "#f59e0b" : "#ef4444";
        el.innerHTML = `
          <span style="font-weight:700;font-size:0.95rem;color:${barColor};">${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}</span>
          <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-top:3px;">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width 1s linear;"></div>
          </div>`;
      }
    });

    // When a timer hits zero, re-render to show the "Release" button
    if (needsRefresh) {
      renderInvoicesForRole();
      renderAllInvoices();
    }
  }, 1000);
}

// Start ticker on page load
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", startCountdownTicker);
}

// ═════════════════════════════════════════════════════════════════════════════
//  STATS
// ═════════════════════════════════════════════════════════════════════════════

function updateStats() {
  document.getElementById("statTotal").textContent = allInvoices.length;
  document.getElementById("statPending").textContent = allInvoices.filter(i => i.status === "PENDING_BUYER" || i.status === "PENDING").length;
  document.getElementById("statFinanced").textContent = allInvoices.filter(i => i.status === "FINANCED" || i.status === "ESCROWED").length;
  document.getElementById("statPaid").textContent = allInvoices.filter(i => i.status === "PAID").length;
}

// ═════════════════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═════════════════════════════════════════════════════════════════════════════

function debouncedRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(async () => {
    _refreshTimer = null;
    await refreshInvoices();
  }, 500);
}

function setupEventListeners() {
  const feed = document.getElementById("activityFeed");
  feed.innerHTML = "";

  // Use readProvider-based contract for events (bypasses MetaMask cache)
  invoiceReadContract.on("InvoiceUploaded", (id, supplier, buyer, amount) => {
    addFeedItem("📤", `Invoice <strong>#${id}</strong> uploaded by ${resolveAddr(supplier)} — ${ethers.formatEther(amount)} ETH <span class="aa-tag">via AA</span>`);
    debouncedRefresh();
  });

  invoiceReadContract.on("AutoApproved", (id, reason) => {
    addFeedItem("⚡", `Invoice <strong>#${id}</strong> auto-approved (${reason}) <span class="aa-tag">via AA</span>`);
    debouncedRefresh();
  });

  invoiceReadContract.on("BuyerApproved", (id) => {
    addFeedItem("✅", `Invoice <strong>#${id}</strong> approved by buyer <span class="aa-tag">via AA</span>`);
    debouncedRefresh();
  });

  invoiceReadContract.on("EscrowDeposited", (id, amount) => {
    addFeedItem("🔒", `Escrow deposited for #${id}: ${ethers.formatEther(amount)} ETH`);
    debouncedRefresh();
  });

  invoiceReadContract.on("AutoFinanced", (id, financier, payout) => {
    addFeedItem("⚡", `Invoice <strong>#${id}</strong> auto-financed — supplier got ${ethers.formatEther(payout)} ETH <span class="aa-tag">via AA</span>`);
    debouncedRefresh();
  });

  invoiceReadContract.on("Paid", (id, financier, payout) => {
    addFeedItem("💸", `Invoice <strong>#${id}</strong> PAID — financier received ${ethers.formatEther(payout)} ETH`);
    debouncedRefresh();
  });
}

function addFeedItem(icon, text) {
  const feed = document.getElementById("activityFeed");
  const time = new Date().toLocaleTimeString();
  const item = document.createElement("div");
  item.className = "feed-item";
  item.innerHTML = `
    <span class="feed-icon">${icon}</span>
    <div>
      <div class="feed-text">${text}</div>
      <div class="feed-time">${time}</div>
    </div>
  `;
  feed.prepend(item);
}

// ═════════════════════════════════════════════════════════════════════════════
//  TAB SWITCHING
// ═════════════════════════════════════════════════════════════════════════════

function switchTab(el) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  el.classList.add("active");

  const target = el.dataset.tab;
  ["myDashboard", "allInvoices", "historyTab", "activityFeed", "adminPanel"].forEach(id => {
    document.getElementById(`tab-${id}`).classList.toggle("hidden", id !== target);
  });

  // Auto-load history when History tab is opened
  if (target === "historyTab") {
    // Reset filter to "All Events" every time tab opens
    document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
    const allBtn = document.querySelector('.filter-pill[data-filter="all"]');
    if (allBtn) allBtn.classList.add("active");
    _currentHistoryFilter = "all";
    loadHistory();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

function truncAddr(addr) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function emptyState(icon, text) {
  return `<div class="empty-state"><div class="icon">${icon}</div><p>${text}</p></div>`;
}

function parseError(err) {
  if (err?.reason) return err.reason;
  if (err?.data?.message) return err.data.message;
  if (err?.message) {
    const msg = err.message;
    if (msg.includes("user rejected")) return "Transaction rejected by user";
    if (msg.includes("insufficient funds")) return "Insufficient ETH balance";
    if (msg.includes("Bundler relay")) return "Bundler relay not running. Start: node scripts/bundler-relay.js";
    return msg.slice(0, 200);
  }
  return "Unknown error";
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

// ═════════════════════════════════════════════════════════════════════════════
//  HISTORY — MongoDB-backed persistent event timeline
// ═════════════════════════════════════════════════════════════════════════════

const HISTORY_API = "http://localhost:3002/api";
let _allHistoryEvents = [];
let _currentHistoryFilter = "all";

async function loadHistory() {
  try {
    // Always load ALL events so every role sees the complete invoice lifecycle
    const resp = await fetch(`${HISTORY_API}/history`);
    if (!resp.ok) throw new Error("History server not running");
    const data = await resp.json();

    if (!data.success) throw new Error(data.error || "Unknown error");

    _allHistoryEvents = data.events || [];
    document.getElementById("historyCount").textContent = `${_allHistoryEvents.length} events`;
    renderHistoryTimeline(_allHistoryEvents);
  } catch (err) {
    const timeline = document.getElementById("historyTimeline");
    timeline.innerHTML = `
      <div class="empty-state">
        <div class="icon">⚠️</div>
        <p>History server not available. Start it with: <code>node scripts/server.js</code></p>
      </div>`;
  }
}

async function syncHistory() {
  const btn = document.getElementById("syncBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Syncing...";
  try {
    const resp = await fetch(`${HISTORY_API}/sync`, { method: "POST" });
    const data = await resp.json();
    showToast(`✅ Synced ${data.synced} events from blockchain`, "success");
    await loadHistory();
  } catch (err) {
    showToast("Sync failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Sync";
  }
}

function filterHistory(el) {
  document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
  el.classList.add("active");

  const filter = el.dataset.filter;
  _currentHistoryFilter = filter;

  if (filter === "all") {
    renderHistoryTimeline(_allHistoryEvents);
  } else {
    const types = filter.split(",");
    const filtered = _allHistoryEvents.filter(e => types.includes(e.eventType));
    renderHistoryTimeline(filtered);
  }
}

function getEventBadge(type) {
  const map = {
    InvoiceUploaded: { icon: "📤", label: "Uploaded", cls: "badge-uploaded" },
    BuyerApproved: { icon: "✅", label: "Approved", cls: "badge-approved" },
    AutoApproved: { icon: "🤖", label: "Auto-Approved", cls: "badge-approved" },
    EscrowDeposited: { icon: "🔒", label: "Escrowed", cls: "badge-escrowed" },
    Financed: { icon: "💰", label: "Financed", cls: "badge-financed" },
    Paid: { icon: "✅", label: "Paid", cls: "badge-paid" },
    Deposited: { icon: "⬆️", label: "Deposit", cls: "badge-deposit" },
    Withdrawn: { icon: "⬇️", label: "Withdraw", cls: "badge-withdraw" },
    BuyerConditionSet: { icon: "⚙️", label: "Condition", cls: "badge-condition" },
    FinancierConditionSet: { icon: "⚙️", label: "Condition", cls: "badge-condition" },
  };
  return map[type] || { icon: "📝", label: type, cls: "badge-uploaded" };
}

function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Resolve a SmartWallet address to a readable "Role (0x1234...abcd)" label
function resolveAddrLabel(addr) {
  if (!addr) return null;
  const a = addr.toLowerCase();
  const c = CONFIG.contracts || {};
  const r = CONFIG.roles || {};
  let role = null;
  let eoaAddr = addr;

  if (a === c.SupplierSmartWallet?.toLowerCase()) { role = "Supplier"; eoaAddr = r.supplier; }
  else if (a === c.BuyerSmartWallet?.toLowerCase()) { role = "Buyer"; eoaAddr = r.buyer; }
  else if (a === c.FinancierSmartWallet?.toLowerCase()) { role = "Financier"; eoaAddr = r.financier; }
  else if (a === r.supplier?.toLowerCase()) { role = "Supplier"; eoaAddr = r.supplier; }
  else if (a === r.buyer?.toLowerCase()) { role = "Buyer"; eoaAddr = r.buyer; }
  else if (a === r.financier?.toLowerCase()) { role = "Financier"; eoaAddr = r.financier; }

  if (role && eoaAddr) {
    return `${role} (${truncAddr(eoaAddr)})`;
  }
  return truncAddr(addr);
}

function renderHistoryTimeline(events) {
  const container = document.getElementById("historyTimeline");

  if (!events || events.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📜</div>
        <p>No events found. Upload an invoice to get started!</p>
      </div>`;
    return;
  }

  // ── Build invoice lifecycle summaries ──────────────────────────────────
  const invoiceMap = {};
  events.forEach(ev => {
    if (ev.invoiceId == null) return;
    if (!invoiceMap[ev.invoiceId]) {
      invoiceMap[ev.invoiceId] = { events: [], supplier: null, buyer: null, financier: null, amount: null, status: "Pending" };
    }
    const inv = invoiceMap[ev.invoiceId];
    inv.events.push(ev);
    if (ev.supplier) inv.supplier = ev.supplier;
    if (ev.buyer) inv.buyer = ev.buyer;
    if (ev.financier) inv.financier = ev.financier;
    if (ev.amount && ev.eventType === "InvoiceUploaded") inv.amount = ev.amount;

    // Determine latest status
    if (ev.eventType === "Paid") inv.status = "Paid";
    else if (ev.eventType === "Financed" && inv.status !== "Paid") inv.status = "Financed";
    else if (ev.eventType === "EscrowDeposited" && !["Financed", "Paid"].includes(inv.status)) inv.status = "Escrowed";
    else if ((ev.eventType === "BuyerApproved" || ev.eventType === "AutoApproved") && !["Escrowed", "Financed", "Paid"].includes(inv.status)) inv.status = "Approved";
  });

  // ── Render invoice summary cards ──────────────────────────────────────
  let summaryHtml = "";
  const invoiceIds = Object.keys(invoiceMap).sort((a, b) => Number(a) - Number(b));
  if (invoiceIds.length > 0) {
    const statusColors = { Pending: "#facc15", Approved: "#4ade80", Escrowed: "#60a5fa", Financed: "#c084fc", Paid: "#34d399" };
    const statusSteps = ["Pending", "Approved", "Escrowed", "Financed", "Paid"];

    summaryHtml = `<div class="history-invoices-summary">
      <h3 style="color:var(--text-secondary);font-size:0.85rem;margin:0 0 0.8rem 0;font-weight:600;">📊 Invoice Lifecycle Status</h3>
      <div style="display:flex;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.5rem;">
      ${invoiceIds.map(id => {
      const inv = invoiceMap[id];
      const stepIdx = statusSteps.indexOf(inv.status);
      const statusColor = statusColors[inv.status] || "#818cf8";
      const progressPct = ((stepIdx + 1) / statusSteps.length) * 100;

      return `<div style="flex:1;min-width:260px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:0.9rem 1rem;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
            <span style="font-weight:700;color:var(--text-primary);font-size:0.95rem;">Invoice #${id}</span>
            <span style="font-size:0.7rem;font-weight:600;padding:0.15rem 0.5rem;border-radius:4px;background:${statusColor}22;color:${statusColor};">${inv.status.toUpperCase()}</span>
          </div>
          ${inv.amount ? `<div style="font-family:'JetBrains Mono',monospace;font-size:0.95rem;font-weight:700;color:var(--accent);margin-bottom:0.5rem;">${inv.amount} ETH</div>` : ""}
          <div style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.72rem;color:var(--text-secondary);">
            ${inv.supplier ? `<div>📦 <strong style="color:var(--text-primary)">Supplier:</strong> ${resolveAddrLabel(inv.supplier)}</div>` : ""}
            ${inv.buyer ? `<div>🛒 <strong style="color:var(--text-primary)">Buyer:</strong> ${resolveAddrLabel(inv.buyer)}</div>` : ""}
            ${inv.financier ? `<div>💰 <strong style="color:var(--text-primary)">Financier:</strong> ${resolveAddrLabel(inv.financier)}</div>` : ""}
          </div>
          <div style="margin-top:0.6rem;">
            <div style="display:flex;justify-content:space-between;font-size:0.62rem;color:var(--text-muted);margin-bottom:0.2rem;">
              ${statusSteps.map(s => `<span style="${s === inv.status ? 'color:' + statusColor + ';font-weight:600' : ''}">${s}</span>`).join("")}
            </div>
            <div style="height:4px;background:rgba(255,255,255,0.05);border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${progressPct}%;background:${statusColor};border-radius:2px;transition:width 0.3s;"></div>
            </div>
          </div>
        </div>`;
    }).join("")}
      </div>
    </div>`;
  }

  // ── Render event timeline ─────────────────────────────────────────────
  const timelineHtml = events.map((ev, i) => {
    const badge = getEventBadge(ev.eventType);
    const ts = new Date(ev.timestamp);
    const timeStr = ts.toLocaleString();
    const ago = timeAgo(ev.timestamp);

    // Build address rows
    let addressHtml = "";
    if (ev.supplier) addressHtml += `<div class="history-meta-item"><span class="label">📦 Supplier:</span> ${resolveAddrLabel(ev.supplier)}</div>`;
    if (ev.buyer) addressHtml += `<div class="history-meta-item"><span class="label">🛒 Buyer:</span> ${resolveAddrLabel(ev.buyer)}</div>`;
    if (ev.financier) addressHtml += `<div class="history-meta-item"><span class="label">💰 Financier:</span> ${resolveAddrLabel(ev.financier)}</div>`;

    let metaItems = "";
    if (ev.invoiceId != null) {
      metaItems += `<div class="history-meta-item"><span class="label">Invoice:</span> #${ev.invoiceId}</div>`;
    }
    if (ev.amount) {
      metaItems += `<div class="history-meta-item"><span class="label">Amount:</span> <span class="history-amount">${ev.amount} ETH</span></div>`;
    }
    if (ev.txHash) {
      metaItems += `<div class="history-meta-item"><span class="label">TX:</span> ${ev.txHash.slice(0, 10)}…${ev.txHash.slice(-6)}</div>`;
    }
    if (ev.blockNumber) {
      metaItems += `<div class="history-meta-item"><span class="label">Block:</span> ${ev.blockNumber}</div>`;
    }

    return `
      <div class="history-event" style="animation-delay: ${i * 0.05}s">
        <div class="history-event-top">
          <span class="history-event-badge ${badge.cls}">${badge.icon} ${badge.label}</span>
          <span class="history-event-time" title="${timeStr}">${ago}</span>
        </div>
        <div class="history-event-details">${ev.details || ev.eventType}</div>
        ${addressHtml ? `<div class="history-event-meta" style="margin-top:0.4rem;">${addressHtml}</div>` : ""}
        <div class="history-event-meta">${metaItems}</div>
      </div>`;
  }).join("");

  container.innerHTML = summaryHtml + timelineHtml;
}

// ═════════════════════════════════════════════════════════════════════════════
//  BIDDING SYSTEM LOGIC
// ═════════════════════════════════════════════════════════════════════════════

async function startBidding(id) {
  const mins = prompt("Enter bidding duration in minutes (e.g. 10):", "5");
  if (!mins || isNaN(mins)) return;

  try {
    showToast("⏳ Transitioning to bidding mode...", "info");

    // 1. Notify Backend of the timeout
    const resp = await fetch(`${API_URL}/invoices/${id}/start-bidding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wallet-address": connectedAddr },
      body: JSON.stringify({ timeoutMinutes: parseInt(mins) })
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.message);

    // 2. Execute on-chain startBidding
    await sendAACall(INVOICE_ABI, CONFIG.contracts.InvoiceContract, "startBidding", [id]);

    showToast(`✅ Bidding started! Auto-electing winner in ${mins} minutes.`, "success");
    await refreshInvoices();
  } catch (err) {
    showToast("Failed to start bidding: " + parseError(err), "error");
  }
}

async function submitBid(invoiceId) {
  const adv = prompt("Enter Advance Rate (%)", "");
  const intr = prompt("Enter Interest Rate (%)", "");
  if (!adv || !intr) return;

  try {
    const resp = await fetch(`${API_URL}/invoices/${invoiceId}/bids`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-address": connectedAddr
      },
      body: JSON.stringify({ advanceRate: parseInt(adv), interestRate: parseInt(intr) })
    });
    const data = await resp.json();
    if (data.success) {
      showToast("✅ Bid submitted successfully!", "success");
      await refreshInvoices();
    }
  } catch (err) {
    showToast("Bid submission failed", "error");
  }
}

async function acceptBid(invoiceId, bidId, winningFinancier) {
  try {
    showToast("⏳ Fetching bid details...", "info");

    // Fetch rates from MongoDB
    const bidResult = await fetch(`${API_URL}/invoices/${invoiceId}/bids`, {
      headers: { "x-wallet-address": connectedAddr }
    });
    const bidData = await bidResult.json();
    const winner = bidData.bids.find(b => b._id === bidId);

    if (!winner) return showToast("Could not find bid rates", "error");

    showToast(`⏳ Accepting bid (${winner.advanceRate}% / ${winner.interestRate}%)...`, "busy");

    // 1. Mark as accepted in backend
    await fetch(`${API_URL}/invoices/${invoiceId}/bids/${bidId}/accept`, {
      method: "PATCH",
      headers: { "x-wallet-address": connectedAddr }
    });

    // 2. Execute on-chain transaction via AA
    await sendAACall(INVOICE_ABI, CONFIG.contracts.InvoiceContract, "acceptBid", [
      invoiceId,
      winningFinancier,
      winner.advanceRate,
      winner.interestRate
    ]);

    showToast("✅ Bid accepted and invoice funded!", "success");
    await refreshInvoices();
  } catch (err) {
    showToast("Failed to accept bid: " + parseError(err), "error");
  }
}

async function viewBids(invoiceId) {
  try {
    const inv = allInvoices.find(i => i.id === invoiceId);
    const panel = document.getElementById("supplierBiddingPanel");
    const list = document.getElementById("supplierBidsList");

    // Always show the panel and clear old content immediately
    panel.classList.remove("hidden");
    list.innerHTML = `<p style="color:var(--text-secondary);text-align:center;padding:1rem;">⏳ Loading bids...</p>`;

    // Build header with timer
    let headerHtml = `<span class="card-title">💎 Active Bids — Invoice #${invoiceId}</span>`;
    if (inv && inv.biddingTimeout) {
      const now = Math.floor(Date.now() / 1000);
      const secsLeft = inv.biddingTimeout - now;
      if (secsLeft > 0) {
        headerHtml += `<div class="countdown-timer" data-due="${inv.biddingTimeout}" data-type="bidding" style="margin-left: auto; text-align: right;">
                    <div style="font-size:0.75rem;color:var(--accent);font-weight:600;margin-bottom:2px;">🔥 BIDDING ENDS</div>
                    <span style="font-weight:700;font-size:0.95rem;color:var(--accent);">Loading...</span>
                </div>`;
      } else {
        headerHtml += `<span style="color:var(--accent);font-weight:600;margin-left:auto;" class="countdown-pulse">⌛ FINALIZING...</span>`;
      }
    }

    const headerEl = panel.querySelector(".card-header");
    if (headerEl) {
      headerEl.innerHTML = headerHtml;
      headerEl.style.display = "flex";
      headerEl.style.justifyContent = "space-between";
      headerEl.style.alignItems = "center";
    }

    // Fetch bids from MongoDB for THIS specific invoice
    const resp = await fetch(`${API_URL}/invoices/${invoiceId}/bids`, {
      headers: { "x-wallet-address": connectedAddr }
    });
    const data = await resp.json();

    if (data.success && data.bids.length > 0) {
      list.innerHTML = data.bids.map(b => `
                <div class="card" style="margin-bottom:0.5rem; border-left: 4px solid var(--accent);">
                    <p><strong>Financier:</strong> ${truncAddr(b.financerAddress)}</p>
                    <p><strong>Advance:</strong> ${b.advanceRate}% | <strong>Interest:</strong> ${b.interestRate}%</p>
                    <button class="btn btn-success btn-sm" onclick="acceptBid(${invoiceId}, '${b._id}', '${b.financerAddress}')">Accept Bid</button>
                </div>
            `).join("");
    } else {
      list.innerHTML = `<p style="color:var(--text-secondary);text-align:center;padding:2rem;">📭 No bids yet for Invoice #${invoiceId}. Waiting for financiers to bid...</p>`;
    }
  } catch (e) {
    showToast("Failed to fetch bids: " + e.message, "error");
  }

}

// ═════════════════════════════════════════════════════════════════════════════
//  GOVERNANCE / VOTING LOGIC
// ═════════════════════════════════════════════════════════════════════════════

async function initiateVote() {
  const targetId = document.getElementById("voteTargetSelect").value;
  const reason = document.getElementById("voteReason").value.trim();
  if (!targetId || !reason) return showToast("Select a target and provide a reason", "error");

  const timeoutMinutes = document.getElementById("voteTimeout").value;

  try {
    const resp = await fetch(`${API_URL}/voting/initiate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-address": connectedAddr
      },
      body: JSON.stringify({ targetUserId: targetId, reason, timeoutMinutes })
    });
    const data = await resp.json();
    if (data.success) {
      showToast("✅ Voting session initiated!", "success");
      refreshVotes();
    } else {
      showToast(data.message, "error");
    }
  } catch (e) {
    showToast("Failed to initiate vote", "error");
  }
}

async function castVote(sessionId, decision) {
  try {
    const resp = await fetch(`${API_URL}/voting/${sessionId}/vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wallet-address": connectedAddr
      },
      body: JSON.stringify({ decision })
    });
    const data = await resp.json();
    if (data.success) {
      showToast(`✅ Vote cast: ${decision}`, "success");
      refreshVotes();
    } else {
      showToast(data.message, "error");
    }
  } catch (e) {
    showToast("Failed to cast vote", "error");
  }
}

async function refreshVotes() {
  try {
    const resp = await fetch(`${API_URL}/voting/active`, {
      headers: { "x-wallet-address": connectedAddr }
    });
    const data = await resp.json();
    if (data.success) {
      renderActiveVotes(data.votes);
    }
  } catch (e) { }
}

function renderGovernanceInfo(nodes) {
  const select = document.getElementById("voteTargetSelect");
  if (!select) return;
  select.innerHTML = nodes.map(n => `<option value="${n._id}">${n.walletAddress} (${n.role}) ${n.isSlashed ? '[SLASHED]' : ''}</option>`).join("");
  refreshVotes();
}

function renderActiveVotes(votes) {
  const list = document.getElementById("activeVotesList");
  if (!list) return;
  if (!votes.length) {
    list.innerHTML = "<p style='color:var(--text-muted);'>No active voting sessions.</p>";
    return;
  }
  list.innerHTML = votes.map(v => `
    <div class="card" style="margin-bottom:0.5rem; border-left: 4px solid var(--danger);">
      <p><strong>Target:</strong> ${v.targetUserId.walletAddress}</p>
      <p><strong>Reason:</strong> ${v.reason}</p>
      <p><strong>Progress:</strong> <span class="history-amount">${v.totalVotesCast} / ${v.requiredVotes}</span> votes received</p>
      <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
        <button class="btn btn-danger btn-sm" onclick="castVote('${v._id}', 'slash')" ${v.hasVoted ? 'disabled' : ''}>Slash</button>
        <button class="btn btn-success btn-sm" onclick="castVote('${v._id}', 'keep')" ${v.hasVoted ? 'disabled' : ''}>Keep</button>
      </div>
    </div>
  `).join("");
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function parseError(err) {
  if (err.reason) return err.reason;
  if (err.data && err.data.message) return err.data.message;
  if (err.message) return err.message;
  return "Unknown error";
}

function truncAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function switchTab(btn) {
  const target = btn.getAttribute("data-tab");
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");

  document.querySelectorAll("[id^='tab-']").forEach(div => div.classList.add("hidden"));
  const tab = document.getElementById("tab-" + target);
  if (tab) tab.classList.remove("hidden");

  if (target === "governanceTab") refreshVotes();
}

function showToast(msg, type) {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerText = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

(async function init() {
  if (window.ethereum) {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (accounts.length > 0) {
      await connectWallet();
    }
  }
})();

// ═════════════════════════════════════════════════════════════════════════════
//  INVOICE LIFECYCLE MODAL
// ═════════════════════════════════════════════════════════════════════════════

function showLifecycle(id) {
  const inv = allInvoices.find(i => i.id === id);
  if (!inv) return showToast("Invoice not found", "error");

  const modal = document.getElementById("lifecycleModal");
  const container = document.getElementById("lifecycleSteps");
  const now = Math.floor(Date.now() / 1000);

  const steps = [
    { label: "Invoice Created", icon: "📤" },
    { label: "Buyer Verified", icon: "✅" },
    { label: "Escrow Locked", icon: "🔒" },
    { label: "Listed for Financing", icon: "💎" },
    { label: "Finance Approved", icon: "💰" },
    { label: "Settled (Escrow)", icon: "⚖️" },
    { label: "Paid (Immutable)", icon: "💸" }
  ];

  // Logic to determine completeness
  const stepStatus = steps.map((s, idx) => {
    let done = false;
    let current = false;

    switch(idx) {
      case 0: // Created
        done = true;
        break;
      case 1: // Buyer Verified
        done = inv.buyerVerified || ["APPROVED", "ESCROWED", "BIDDING", "FINANCED", "PAID"].includes(inv.status);
        break;
      case 2: // Escrow Locked
        done = inv.escrowLocked || ["ESCROWED", "BIDDING", "FINANCED", "PAID"].includes(inv.status);
        break;
      case 3: // Bidding / Financing
        done = inv.status === "BIDDING" || ["FINANCED", "PAID"].includes(inv.status);
        break;
      case 4: // Financed
        done = inv.financierFunded || ["FINANCED", "PAID"].includes(inv.status);
        break;
      case 5: // Settled
        done = (inv.status === "FINANCED" && now >= inv.dueDate) || inv.isPaid || inv.status === "PAID";
        break;
      case 6: // Paid
        done = inv.isPaid || inv.status === "PAID";
        break;
    }
    return { ...s, done };
  });

  // Find the first non-done step and mark it as current
  const firstNotDone = stepStatus.findIndex(s => !s.done);
  if (firstNotDone !== -1) {
    stepStatus[firstNotDone].current = true;
  }

  container.innerHTML = stepStatus.map((s, i) => `
    <div class="step-item ${s.done ? 'done' : ''} ${s.current ? 'current' : ''}">
      <div class="step-circle">${s.done ? '✓' : (i + 1)}</div>
      <div class="step-label">${s.label}</div>
    </div>
  `).join("");

  modal.classList.remove("hidden");
}

window.showLifecycle = showLifecycle; // Ensure it's globally accessible

function closeLifecycle() {
  document.getElementById("lifecycleModal").classList.add("hidden");
}

window.closeLifecycle = closeLifecycle;
