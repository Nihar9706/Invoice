const { ethers } = require("hardhat");

async function main() {
  const targets = [
    "0x826F65f1976b392d9426bea4f40687751adFF348",
    "0x66676081356A6eFd0814ef25C79d107523170e83",
    "0xcd3b766ccdd6d521757b290c4d1284d71d3d6333",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9"
  ];
  const [admin] = await ethers.getSigners();
  
  for (const target of targets) {
    console.log(`Sending 1000 ETH from ${admin.address} to ${target}...`);
    const tx = await admin.sendTransaction({
      to: target,
      value: ethers.parseEther("1000")
    });
    await tx.wait();
    console.log(`✅ 1000 ETH Sent Successfully to ${target}!`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
