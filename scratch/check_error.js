const ethers = require("ethers");
const errors = [
  "NotBuyer()",
  "AlreadyApproved()",
  "NotApproved()",
  "IncorrectAmount()",
  "EscrowNotLocked()",
  "TooEarly()",
  "NotFunded()",
  "AlreadyPaid()",
  "NotWhitelistedFinancier()",
  "InsufficientDeposit()",
  "NotOwner()",
  "NotEntryPoint()",
  "ZeroAddress()",
  "NotAuthorized()",
  "DeadlineExpired()",
  "InvalidSignature()",
  "InvalidNonce()",
  "AccountNotWhitelisted()",
  "AddressEmptyCode(address)"
];

errors.forEach(err => {
  console.log(`${err}: ${ethers.id(err).substring(0, 10)}`);
});
