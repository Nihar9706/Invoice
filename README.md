# 🧾 Invoice Factoring DApp

A decentralized invoice financing platform built on Ethereum, leveraging **ERC-4337 (Account Abstraction)** to provide a seamless, gasless experience for suppliers, buyers, and financiers.

---

## 🌟 Overview

This platform automates the traditional invoice factoring process, where suppliers sell their invoices at a discount to get immediate liquidity. By using smart contracts and Account Abstraction, we eliminate manual paperwork and high transaction friction.

### 🔑 Key Features
- **Gasless Transactions**: Users don't need to hold ETH; a Paymaster covers the gas fees via ERC-4337 EntryPoint.
- **Smart Escrow**: Automated locking and release of funds based on invoice due dates.
- **Role-Based Access**: Specialized dashboards for:
  - **Supplier**: Upload invoices and receive instant funding.
  - **Buyer**: Approve invoices and repay the escrow.
  - **Financier**: Fund invoices and earn interest/margins automatically.
- **Automated Workflow**: Approval thresholds (e.g., invoices < 11 ETH) automatically trigger financing flows.

---

## 🛠 Tech Stack

- **Smart Contracts**: Solidity (Hardhat)
- **Account Abstraction**: ERC-4337 (Smart Wallets, Paymaster, EntryPoint)
- **Frontend**: Vanilla JavaScript, Ethers.js, HTML5, CSS3
- **Local Network**: Hardhat Node
- **Relay**: Custom Bundler Relay for processing User Operations

---

## 🚀 Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v16+ recommended).
- [MetaMask](https://metamask.io/) browser extension.

### 2. Installation
```bash
# Install dependencies
npm install
```

### 3. Running Locally
Run these commands in separate terminal windows:

**Terminal 1: Start Hardhat Node**
```bash
npx hardhat node
```

**Terminal 2: Deploy Contracts**
```bash
npx hardhat run scripts/deploy.js --network localhost
```

**Terminal 3: Start Bundler Relay**
```bash
node scripts/bundler-relay.js
```

**Terminal 4: Launch Frontend**
```bash
npx http-server frontend -p 3000 -c-1
```
Open `http://localhost:3000` in your browser.

---

## 👤 Role Testing (MetaMask)

Use these Hardhat accounts to test the different roles:

| Role | Address | Private Key |
| :--- | :--- | :--- |
| **Supplier** | `0x709979...` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| **Buyer** | `0x3C44Cd...` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| **Financier** | `0x996550...` | `0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba` |

---

## 📁 Project Structure

- `contracts/`: Solidity smart contracts (Invoice, SmartWallet, Paymaster).
- `frontend/`: The DApp web interface.
- `scripts/`: Deployment, test scripts, and the bundler relay.
- `scripts/models/`: Event models for transaction history.
- `SETUP_GUIDE.md`: Detailed environment configuration and troubleshooting.

---

## 📝 License
MIT License
