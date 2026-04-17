const { ethers } = require("ethers");
const key = "0xdf57089febbacf7ba0bc227da71a0d8f8883bc0f42964cd079d399994895690b";
const wallet = new ethers.Wallet(key);
console.log("Address:", wallet.address);
