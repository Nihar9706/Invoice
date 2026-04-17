require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    // ── Local Hardhat Node (default — use this for development) ─────────────
    hardhat: {
      chainId: 31337,
      mining: {
        auto: true,
        interval: 0,
      },
    },

    // ─── Localhost (Default for npx hardhat node) ───────────────────────────
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // ── GoChain Testnet ───────────────────────────────────────────────────────
    // Chain ID: 31337 for GoChain testnet (same as Hardhat local — but different RPC)
    // Faucet: https://testnet-explorer.gochain.io/faucet
    // Explorer: https://testnet-explorer.gochain.io
    //
    // To deploy to GoChain testnet:
    //   npx hardhat run scripts/deploy.js --network gochain_testnet
    // To test against GoChain testnet:
    //   npx hardhat test --network gochain_testnet
    //
    // IMPORTANT: Replace GOCHAIN_PRIVATE_KEY with your actual private key
    // or use process.env.PRIVATE_KEY from a .env file
    gochain_testnet: {
      url: "https://testnet-rpc.gochain.io",
      chainId: 31337,
      // Use environment variable for security — never hardcode private keys!
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },

    // ── GoChain Mainnet (if needed later) ────────────────────────────────────
    // gochain_mainnet: {
    //   url: "https://rpc.gochain.io",
    //   chainId: 60,
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    // },
  },

  // ── Gas Reporter (optional, shows gas usage per function in tests) ─────────
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
};