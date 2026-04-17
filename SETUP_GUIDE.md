# 🚀 Invoice Finance DApp — Complete Setup Guide

Follow these steps exactly to maintain a clean, working development environment with **Full Account Abstraction (AA) / Gasless Transactions**.

---

## 1. MetaMask Configuration (Mandatory)
Every time you restart the Hardhat node, MetaMask will have a **stale cache** which causes "Nonce" or "Invalid Block Tag" errors.

### **Steps to Clear Cache:**
1. Open MetaMask.
2. Go to **Settings** -> **Advanced**.
3. Scroll down and click **Clear activity tab data** (Reset Account).
4. Ensure you are connected to **Hardhat Local** (Chain ID: `31337`).

---

## 2. Starting the Environment (In Order)
If you need to start from scratch, run these commands in separate terminal windows:

### **Terminal 1: Local Blockchain**
```bash
npx hardhat node
```

### **Terminal 2: Deploy Contracts**
```bash
npx hardhat run scripts/deploy.js --network localhost
```

### **Terminal 3: Bundler Relay (Gasless Processor)**
```bash
node scripts/bundler-relay.js
```

### **Terminal 4: Frontend Server**
```bash
npx http-server fronte nd -p 3000 -c-1
```

---

## 3. The Roles (Hardhat Default Accounts)
Import these Private Keys into MetaMask to test each role:

| Role | Index | Address | Private Key |
| :--- | :--- | :--- | :--- |
| **Supplier** | #1 | `0x709979...` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| **Buyer** | #2 | `0x3C44Cd...` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| **Financier** | #5 | `0x996550...` | `0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba` |

---

## 4. Verification Console Commands
Run these in your Browser Console (**F12 -> Console**) while on `http://localhost:3000` to see real-time balance updates bypassing MetaMask's UI delay.

### **Check Supplier Balance (Proof of Payout)**
```javascript
ethers.formatEther(await readProvider.getBalance("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"))
```

### **Check Financier Balance**
```javascript
ethers.formatEther(await readProvider.getBalance("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"))
```

---

## 5. Helpful Tips
- **Hard Refresh**: Press `Ctrl + Shift + R` in the browser to ensure you have the latest code and config.
- **Pre-Seed**: The deploy script automatically seeds the **Buyer** and **Financier** with **100 ETH** inside the smart contract for testing.
- **Payout Rule**: Supplier receives **90%** of the invoice amount instantly when Funded. The Financier receives the **10% profit** on the Due Date.
