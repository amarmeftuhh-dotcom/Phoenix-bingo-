const express = require('express');
const router = express.Router();
const { BotUser } = require('./bot.model');

// server.js ላይ ያሉትን Settings እና Auth ወደዚህ ፋይል ለማምጣት በ Parameter እንቀበላቸዋለን
module.exports = function(SystemSettings, loadSettings, auth) {
    
    // 1. የቦቶችን ዝርዝር ወደ Admin የሚያልከው (የነበረው)
    router.post('/bots-list', auth, async (req, res) => {
        try {
            let bots = await BotUser.find().sort({ _id: -1 });
            let s = await SystemSettings.findOne(); // ለ settings ዳታ
            res.json({ success: true, bots: bots, settings: s });
        } catch(e) { 
            res.json({ success: false }); 
        }
    });

    // 2. Admin ላይ የሚስተካከለውን Bot Settings ሴቭ የሚያደርገው (የነበረው)
    // እዚህ ውስጥ isBotSystemActive (On/Off) እና botWinnerForce (Bot or Real User) አሉ።
    router.post('/bot-master-update', auth, async (req, res) => {
        try {
            let s = await SystemSettings.findOne();
            s.isBotSystemActive = req.body.isBotSystemActive; // ሙሉ ሲስተሙን On/Off ማድረጊያ
            s.botWinnerForce = req.body.botWinnerForce;       // ማሸነፍ ያለበትን መምረጫ ("bot", "real", "none")
            s.botDist1 = req.body.botDist1;
            s.botDist2 = req.body.botDist2;
            s.botDist3 = req.body.botDist3;
            s.botDist4 = req.body.botDist4;
            
            await s.save();
            await loadSettings(); // አዲሱን Setting Update እንዲያደርግ
            res.json({ success: true });
        } catch(e) { 
            res.json({ success: false }); 
        }
    });

    // ==========================================
    // አዲስ የተጨመሩ (አንተ የጠየቅካቸው) ራውቶች
    // ==========================================

    // 3. ቦትን Edit ማድረጊያ (ስም፣ ስንት ካርቴላ እንዲይዝ እና የራሱ On/Off)
    router.post('/bot-edit', auth, async (req, res) => {
        try {
            const { botId, name, phone, cardsCount, isActive } = req.body;
            await BotUser.findByIdAndUpdate(botId, {
                name: name,
                phone: phone,
                cardsCount: cardsCount, // ቦቱ ስንት ካርቴላ መግዛት/መያዝ እንዳለበት
                isActive: isActive      // ይሄኛው ቦት ብቻውን እንዲሰራ ወይስ እንዳይሰራ (On/Off)
            });
            res.json({ success: true, message: "Bot successfully updated!" });
        } catch(e) {
            res.json({ success: false, message: "Error updating bot" });
        }
    });

    // 4. አዲስ ቦቶችን በብዛት (30 ወይም 50) መጨመሪያ
    router.post('/bot-add-custom', auth, async (req, res) => {
        try {
            const amount = parseInt(req.body.amount) || 30; // ከ Admin የሚላክ ቁጥር (ለምሳሌ 50)
            
            for(let i = 0; i < amount; i++) {
                await BotUser.create({
                    name: "Bot User " + Math.floor(Math.random() * 1000),
                    phone: "09" + Math.floor(Math.random() * 90000000 + 10000000),
                    cardsCount: 1, // መጀመሪያ ሲገቡ በ1 ካርቴላ ይጀምራሉ (በኋላ edit ይደረጋል)
                    isActive: true
                });
            }
            res.json({ success: true, message: `${amount} new bots added!` });
        } catch(e) {
            res.json({ success: false });
        }
    });

    // 5. ከሴኮንዱ ጋር አብረው ቀስ እያሉ ካርቴላ እንዲገዙ (Simulate) ማድረጊያ
    // ጨዋታው ሊጀመር ሰከንድ ሲቆጥር ከ Frontend በየ 1 ሰከንዱ ይህንን API መጥራት ትችላለህ
    router.post('/bot-gradual-buy', auth, async (req, res) => {
        try {
            // Master System Off ከሆነ ምንም አይግዙ
            let s = await SystemSettings.findOne();
            if(!s.isBotSystemActive) {
                return res.json({ success: true, bought: false, message: "Bot system is OFF" });
            }

            // 1 Active የሆነ ቦት በ Random እንመርጣለን
            const activeBots = await BotUser.find({ isActive: true });
            if(activeBots.length === 0) return res.json({ success: false });

            const randomBot = activeBots[Math.floor(Math.random() * activeBots.length)];
            
            // የቦቱ CardsCount ስንት እንደሆነ እናያለን 
            const cardsToBuy = randomBot.cardsCount;

            // (እዚህ ጋር ቦቱ ወደ ጨዋታው እንደገባ እና 'cardsToBuy' ያህል ካርቴላ እንደገዛ አድርገህ ወደ ጌም ሎጂክህ ትጨምረዋለህ)
            // ለምሳሌ የ Socket.io Event መላክ ትችላለህ: 
            // io.emit('bot_bought_card', { botName: randomBot.name, count: cardsToBuy })

            res.json({ 
                success: true, 
                bought: true, 
                bot: randomBot.name, 
                cards: cardsToBuy 
            });
        } catch(e) {
            res.json({ success: false });
        }
    });

    return router;
};
