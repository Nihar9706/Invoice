const { ethers } = require("hardhat");

async function main() {
  const block = await ethers.provider.getBlock(45, true);
  if (!block || block.transactions.length === 0) {
    return console.log("No transactions in Block #45");
  }

  const txHash = block.transactions[0].hash || block.transactions[0];
  console.log("Transaction Hash:", txHash);

  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  const IC = await ethers.getContractFactory("InvoiceContract");
  const iface = IC.interface;

  console.log("\n=== DECODED EVENTS FROM BLOCK #45 ===\n");
  let found = false;

  receipt.logs.forEach(log => {
    try {
      const parsed = iface.parseLog(log);
      if (parsed) {
        console.log(`Event: ${parsed.name}`);
        Object.keys(parsed.args).forEach(key => {
          // Only print named arguments
          if (isNaN(key)) {
            let val = parsed.args[key].toString();
            if (val.length > 15 && !val.startsWith("0x")) {
              val = ethers.formatEther(val) + " ETH";
            }
            console.log(`  ${key}: ${val}`);
          }
        });
        console.log("-----------------------------------");
        found = true;
      }
    } catch (e) {
      // Ignore logs that don't belong to InvoiceContract (like EntryPoint)
    }
  });

  if (!found) {
    console.log("No InvoiceContract events found. This might have been a different type of transaction.");
  }
}

main().catch(console.error);
