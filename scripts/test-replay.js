const { ethers } = require("hardhat");

async function main() {
  const cfg = require("../frontend/deployed.json");
  
  const [relayer] = await ethers.getSigners();
  const provider = ethers.provider;

  // The supplier's EOA private key (Hardhat account #1)
  const suppKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const suppSigner = new ethers.Wallet(suppKey);

  const iface = new ethers.Interface(["function uploadInvoice(address,uint256,uint256)"]);
  const block = await provider.getBlock("latest");
  
  // Encode the inner call to InvoiceContract
  const calldata = iface.encodeFunctionData("uploadInvoice", [
    cfg.contracts.BuyerSmartWallet,
    ethers.parseEther("1"),
    block.timestamp + 300
  ]);

  const epAbi = [
    "function nonces(address) view returns (uint256)",
    "function handleOp(tuple(address sender,address target,bytes data,bytes signature,address paymaster,uint256 nonce)) external"
  ];
  const ep = new ethers.Contract(cfg.contracts.EntryPoint, epAbi, relayer);

  // 1. Get the current nonce for the Supplier's SmartWallet
  const nonce = await ep.nonces(cfg.contracts.SupplierSmartWallet);
  console.log("Current nonce:", nonce.toString());

  // 2. Hash the UserOp data INCLUDING the nonce
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ["address", "address", "bytes", "uint256"],
    [cfg.contracts.SupplierSmartWallet, cfg.contracts.InvoiceContract, calldata, nonce]
  );
  const hash = ethers.keccak256(encoded);

  // 3. Sign it
  const sig = await suppSigner.signMessage(ethers.getBytes(hash));

  const signedOp = {
    sender: cfg.contracts.SupplierSmartWallet,
    target: cfg.contracts.InvoiceContract,
    data: calldata,
    signature: sig,
    paymaster: cfg.contracts.Paymaster,
    nonce: nonce
  };

  console.log("\n=== ERC-4337 REPLAY PROTECTION DEMO ===");
  
  console.log("\nAttempt 1: Submitting UserOp with valid nonce...");
  try {
    const tx = await ep.handleOp(signedOp);
    await tx.wait();
    console.log("  ✅ SUCCESS: Transaction executed. Nonce was incremented.");
  } catch (e) {
    console.log("  ❌ FAILED:", e.message);
  }

  const nonceAfter = await ep.nonces(cfg.contracts.SupplierSmartWallet);
  console.log("  -> Nonce is now:", nonceAfter.toString());

  console.log("\nAttempt 2: REPLAY ATTACK! Submitting the EXACT SAME signed UserOp again...");
  try {
    const tx = await ep.handleOp(signedOp);
    await tx.wait();
    console.log("  ❌ BUG: Expected rejection, but transaction succeeded!");
  } catch (e) {
    console.log("  ✅ REJECTED (Protection Working!):", e.reason || e.message.substring(0, 100));
  }
}

main().catch(console.error);
