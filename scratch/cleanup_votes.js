const mongoose = require("mongoose");
const User = require("../backend/models/User");
const VoteSession = require("../backend/models/VoteSession");
const Notification = require("../backend/models/Notification");

async function cleanup() {
    await mongoose.connect("mongodb://127.0.0.1:27017/invoice-finance-merged");
    console.log("Connected for Ultra-Cleanup...");

    // STRICT QUORUM: No Admins, only core roles
    const activeVoters = await User.find({ 
        isSlashed: false, 
        isActive: true,
        role: { $in: ["supplier", "buyer", "financer"] } 
    });
    
    const totalVoters = activeVoters.length;
    console.log(`Verified Voters in Network: ${totalVoters}`);
    
    const activeSessions = await VoteSession.find({ status: "Active" }).populate("targetUserId");
    
    for (const session of activeSessions) {
        if (!session.targetUserId) continue;

        const quorum = Math.max(1, totalVoters - 1);
        const threshold = Math.ceil((quorum * 2) / 3);
        const slashVotes = session.votes.filter(v => v.decision === "slash").length;
        const keepVotes = session.votes.filter(v => v.decision === "keep").length;
        const totalCast = session.votes.length;

        console.log(`Session for ${session.targetUserId.walletAddress.slice(0,8)}: Slash=${slashVotes}, Keep=${keepVotes}, Total=${totalCast}, Quorum=${quorum}, Threshold=${threshold}`);

        let finalized = false;

        if (slashVotes >= threshold) {
            session.status = "Slashed";
            const target = await User.findById(session.targetUserId._id);
            if (target) {
                target.isSlashed = true;
                target.isActive = false;
                await target.save();
            }
            console.log(`✅ Slashed node via 2/3 supermajority`);
            finalized = true;
        } else if (keepVotes >= threshold) {
            session.status = "Dismissed";
            console.log(`✅ Dismissed node via 2/3 supermajority`);
            finalized = true;
        } else if (totalCast >= quorum) {
            session.status = "Dismissed";
            console.log(`✅ Dismissed node via 100% participation`);
            finalized = true;
        }

        if (finalized) {
            await session.save();
            await Notification.create({
                message: `⚖️ Governance Resolution: Vote for ${session.targetUserId.walletAddress.slice(0,8)} is FINALIZED (${session.status}).`,
                type: session.status === "Slashed" ? "danger" : "success"
            });
        }
    }

    console.log("Ultra-cleanup complete.");
    process.exit(0);
}

cleanup().catch(e => { console.error(e); process.exit(1); });
