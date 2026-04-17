const { ethers } = require("ethers");

async function main() {
    const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

    try {
        console.log("Connecting to blockchain at http://127.0.0.1:8545...");
        const blockNumber = await provider.getBlockNumber();
        const gasPrice = await provider.getFeeData();
        const priceInWei = gasPrice.gasPrice;
        
        console.log(`Current Block Height: ${blockNumber}`);
        console.log(`Current Gas Price: ${ethers.formatUnits(priceInWei, "gwei")} Gwei`);
        console.log("--------------------------------------------------");

        // Latest Block Stats
        const latestBlock = await provider.getBlock(blockNumber);
        const latestGasUsed = latestBlock.gasUsed;
        const latestCost = latestGasUsed * priceInWei;

        console.log("LATEST BLOCK STATS:");
        console.log(`- Gas Used: ${latestGasUsed.toLocaleString()} units`);
        console.log(`- Gas Limit: ${latestBlock.gasLimit.toLocaleString()} units`);
        console.log(`- Cost: ${ethers.formatEther(latestCost)} ETH/Native`);
        console.log("--------------------------------------------------");

        // Blockchain cumulative stats
        console.log("Calculating total blockchain gas usage (this may take a moment)...");
        let totalGasUsed = BigInt(0);
        
        // Use a loop to fetch blocks in batches if history is large
        // For development, we'll fetch all.
        const startTime = Date.now();
        for (let i = 0; i <= blockNumber; i++) {
            const block = await provider.getBlock(i);
            if (block) {
                totalGasUsed += block.gasUsed;
            }
            if (i % 100 === 0 && i > 0) {
                console.log(`...processed ${i} blocks`);
            }
        }
        const endTime = Date.now();

        const totalCost = totalGasUsed * priceInWei;

        console.log("TOTAL BLOCKCHAIN STATS:");
        console.log(`- Total Blocks Analyzed: ${blockNumber + 1}`);
        console.log(`- Total Cumulative Gas Used: ${totalGasUsed.toLocaleString()} units`);
        console.log(`- Total Estimated Cost: ${ethers.formatEther(totalCost)} ETH/Native`);
        console.log(`- Time taken: ${((endTime - startTime) / 1000).toFixed(2)}s`);
        console.log("--------------------------------------------------");

    } catch (error) {
        console.error("Error connecting to node or fetching data:", error.message);
        console.log("\nTIP: Make sure your local node (e.g., npx hardhat node) is running.");
    }
}

main();
