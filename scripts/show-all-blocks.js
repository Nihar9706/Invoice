const { ethers } = require("hardhat");

async function main() {
  const latestBlockNum = await ethers.provider.getBlockNumber();
  console.log(`\n=== ALL BLOCKS ON LOCAL BLOCKCHAIN (Total: ${latestBlockNum + 1}) ===\n`);

  for (let i = 0; i <= latestBlockNum; i++) {
    const b = await ethers.provider.getBlock(i);
    console.log(`Block #${b.number}`);
    console.log(`  Hash:         ${b.hash}`);
    console.log(`  Timestamp:    ${new Date(b.timestamp * 1000).toLocaleString()}`);
    console.log(`  Transactions: ${b.transactions.length}`);
    console.log(`-----------------------------------------------------`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
