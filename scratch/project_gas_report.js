const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
    // 1. Load Deployed Contracts
    const deployedPath = path.join(__dirname, "..", "frontend", "deployed.json");
    if (!fs.existsSync(deployedPath)) {
        console.error("Error: frontend/deployed.json not found.");
        return;
    }
    const deployedData = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
    const contracts = deployedData.contracts;
    const rpcUrl = deployedData.rpcUrl || "http://127.0.0.1:8545";

    const provider = new ethers.JsonRpcProvider(rpcUrl);

    try {
        console.log(`Connecting to ${rpcUrl}...`);
        const blockNumber = await provider.getBlockNumber();
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice;

        console.log(`Analyzing project gas usage up to Block #${blockNumber}...`);
        console.log("--------------------------------------------------");

        // Mapping to store gas info
        const projectGas = {};
        let totalProjectGas = BigInt(0);

        // Flatten values to search for (including arrays like SupplierWallets)
        const addressesToFind = [];
        const addressToName = {};

        function addAddress(name, val) {
            if (Array.isArray(val)) {
                val.forEach((addr, i) => {
                    const indexedName = `${name}[${i}]`;
                    addressesToFind.push(addr.toLowerCase());
                    addressToName[addr.toLowerCase()] = indexedName;
                });
            } else if (typeof val === "string") {
                addressesToFind.push(val.toLowerCase());
                addressToName[val.toLowerCase()] = name;
            }
        }

        for (const [name, val] of Object.entries(contracts)) {
            addAddress(name, val);
        }

        // Iterate through all blocks to find deployment transactions
        console.log("Searching for deployment transactions...");
        for (let i = 0; i <= blockNumber; i++) {
            const block = await provider.getBlock(i, true); // true to get full transactions
            if (!block) continue;

            for (const tx of block.prefetchedTransactions) {
                const receipt = await provider.getTransactionReceipt(tx.hash);
                if (receipt && receipt.contractAddress) {
                    const contractAddr = receipt.contractAddress.toLowerCase();
                    if (addressesToFind.includes(contractAddr)) {
                        const name = addressToName[contractAddr];
                        projectGas[name] = {
                            address: receipt.contractAddress,
                            gasUsed: receipt.gasUsed,
                            blockNumber: receipt.blockNumber,
                            txHash: tx.hash
                        };
                        totalProjectGas += receipt.gasUsed;
                    }
                }
            }
        }

        // Output Table
        console.log("\nINDIVIDUAL CONTRACT DEPLOYMENT COSTS:");
        console.log("--------------------------------------------------");
        console.log(`${"Contract Name".padEnd(25)} | ${"Gas Used".padEnd(12)} | ${"Block"}`);
        console.log("-".repeat(50));
        
        for (const [name, info] of Object.entries(projectGas)) {
            console.log(`${name.padEnd(25)} | ${info.gasUsed.toLocaleString().padEnd(12)} | #${info.blockNumber}`);
        }

        const totalPriceLocal = totalProjectGas * gasPrice;

        console.log("\n" + "=".repeat(50));
        console.log("PROJECT SUMMARY (LOCAL ENVIRONMENT)");
        console.log("-".repeat(50));
        console.log(`Total Gas Used by Project:   ${totalProjectGas.toLocaleString()} units`);
        console.log(`Current Gas Price (Local):   ${ethers.formatUnits(gasPrice, "gwei")} Gwei`);
        console.log(`Total Project Cost (Local):  ${ethers.formatEther(totalPriceLocal)} ETH/Native`);
        console.log("=".repeat(50));

        // Comparison Stats
        const gochainGasPrice = ethers.parseUnits("1", "gwei"); // Typical GoChain Testnet floor
        const mainnetGasPrice = ethers.parseUnits("30", "gwei"); // Estimated average Mainnet

        const gochainCost = totalProjectGas * gochainGasPrice;
        const mainnetCost = totalProjectGas * mainnetGasPrice;

        console.log("\nPRODUCTION COST ANALYSIS (ESTIMATED):");
        console.log("--------------------------------------------------");
        console.log(`GoChain Testnet (1 Gwei):    ${ethers.formatEther(gochainCost)} GO`);
        console.log(`Ethereum Mainnet (30 Gwei):  ${ethers.formatEther(mainnetCost)} ETH`);
        console.log(`Ethereum Mainnet (USD @ 3k): $${(parseFloat(ethers.formatEther(mainnetCost)) * 3000).toFixed(2)}`);
        console.log("--------------------------------------------------");

        // Block Capacity
        const latestBlock = await provider.getBlock("latest");
        console.log(`Blockchain Block Gas Limit:  ${latestBlock.gasLimit.toLocaleString()} units`);
        console.log(`Your Project fills:          ${((Number(totalProjectGas) / Number(latestBlock.gasLimit)) * 100).toFixed(4)}% of a single block.`);

    } catch (error) {
        console.error("Error generating report:", error.message);
    }
}

main();
