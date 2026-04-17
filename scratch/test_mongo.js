const mongoose = require("mongoose");
const MONGO_URI = "mongodb://127.0.0.1:27017/invoice-finance-merged";

console.log("Connecting to:", MONGO_URI);
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("✅ Success!");
        process.exit(0);
    })
    .catch(err => {
        console.error("❌ Failed:", err.message);
        process.exit(1);
    });
