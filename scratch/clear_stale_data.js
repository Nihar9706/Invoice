const mongoose = require('mongoose');

async function main() {
    await mongoose.connect('mongodb://127.0.0.1:27017/invoice-finance-merged');
    
    const bidResult = await mongoose.connection.db.collection('bids').deleteMany({});
    console.log('Cleared ' + bidResult.deletedCount + ' stale bids');
    
    const invResult = await mongoose.connection.db.collection('invoices').deleteMany({});
    console.log('Cleared ' + invResult.deletedCount + ' stale invoice metadata');
    
    await mongoose.disconnect();
    console.log('Done - MongoDB cleaned.');
}

main().catch(err => { console.error(err); process.exit(1); });
