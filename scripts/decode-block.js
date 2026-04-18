const { ethers } = require("hardhat");

async function main() {
  const blockNum = parseInt(process.env.BLOCK_NUM || "48");
  
  console.log(`\n🔍 Fetching Block #${blockNum} from Local Blockchain...`);
  const block = await ethers.provider.getBlock(blockNum, true);
  
  if (!block || block.transactions.length === 0) {
    return console.log(`❌ No transactions found in Block #${blockNum}`);
  }

  const txHash = block.transactions[0].hash || block.transactions[0];
  console.log(`✅ Found Transaction: ${txHash}`);

  const receipt = await ethers.provider.getTransactionReceipt(txHash);
  const IC = await ethers.getContractFactory("InvoiceContract");
  const iface = IC.interface;

  console.log("\n=== DECODED EVENTS ===\n");
  let found = false;

  receipt.logs.forEach(log => {
    try {
      const parsed = iface.parseLog(log);
      if (parsed) {
        console.log(`📢 Event Emitted: [ ${parsed.name} ]`);
        Object.keys(parsed.args).forEach(key => {
          if (isNaN(key)) { // Only print named variables (id, supplier, etc)
            let val = parsed.args[key].toString();
            // Format large numbers back to ETH for readability
            if (val.length > 15 && !val.startsWith("0x")) {
              val = ethers.formatEther(val) + " ETH";
            }
            console.log(`   👉 ${key}: ${val}`);
          }
        });
        console.log("-----------------------------------");
        found = true;
      }
    } catch (e) {
      // Ignore logs from other contracts
    }
  });

  if (!found) {
    console.log("No InvoiceContract events were found in this transaction.");
  }
}

main().catch(console.error);
