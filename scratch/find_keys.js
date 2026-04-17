const { ethers } = require("ethers");

const mnemonic = "test test test test test test test test test test test junk";
const targets = [
  "0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199",
  "0xdd2fd4581271e230360230f9337d5c0430bf44c0",
  "0xbda5747bfd65f08deb54cb465eb87d40e51b197e",
  "0xcd3b766ccdd6ae721141f452c550ca635964ce71",
  "0x2546bcd3c84621e976d8185a91a922ae77ecec30",
  "0x71be63f3384f5fb98995898a86b02fb2426c5788"
];

const found = {};

for (let i = 0; i < 20; i++) {
    const path = `m/44'/60'/0'/0/${i}`;
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, "", path);
    const addr = wallet.address.toLowerCase();
    if (targets.includes(addr)) {
        found[addr] = { index: i, key: wallet.privateKey };
    }
}

console.log(JSON.stringify(found, null, 2));
