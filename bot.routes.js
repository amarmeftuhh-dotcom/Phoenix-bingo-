const express = require('express');
const router = express.Router();
const { BotUser, initBotDatabase } = require('./bot.model');

const ETHIOPIAN_BOT_NAMES = [
    "አበበ","ጫላ","አስቴር","ሄኖክ","ዳዊት","ማክዳ","ዮሴፍ","ቃልኪዳን","ሳሙኤል","ቤዛዊት",
    "አለሙ","ተስፋዬ","መሰረት","ሀና","ዮናስ","ናትናኤል","እየሩሳሌም","ኤደን","ቢኒያም","ቴዎድሮስ",
    "አብርሀም","ሳራ","አቤል","ሚካኤል","ዘላለም","ፍሬዘር","እንዳለ","ብርሀኑ","ጌታሁን","መላኩ",
    "አየለ","በላይ","ሀይሌ","ታደሰ","ታምራት","አማኑኤል","ሀብታሙ","ደጀኔ","አዳነ","አሊ",
    "ከድር","ጀማል","ፋጡማ","አሚና","ሰሚራ","አስናቀች","ፀሀይ","ሮማን","መቅደስ","ትዕግስት",
    "ሰለሞን","ዳንኤል","ኤርሚያስ","በእምነት","አሮን","ናሆም","ኪሩቤል","ያብስራ","በረከት","ቸርነት",
    "አሸናፊ","ድልነሳው","ይሁኔ","ጌትነት","ደሳለኝ","አለማየሁ","ተፈራ","ካሳሁን","ሺፈራው","በቀለ",
    "ቶሎሳ","ጉዲሳ","ፈይሳ","ጫልቱ","ለሚ","አበራ","ደመቀ","አንዷለም","ስዩም","ዘነበ",
    "ሙላቱ","ታሪኩ","አግማስ","ጌታቸው","ወርቁ","ሰይፉ","ጥላሁን","ማህሙድ","ኑሩ","ከማል",
    "ሰኢድ","ሀሰን","ዑስማን","አብዱል","ረሂማ","ዘይነብ","ሀዋ","አያንቱ","ኩመራ","ገመቹ"
];

let inMemoryBots = ETHIOPIAN_BOT_NAMES.slice(0, 30).map((name, idx) => ({
    _id: 'bot_' + (idx + 1),
    name,
    phone: '09' + String(11234501 + idx).padStart(8, '0'),
    isActive: true,
    lastPlayed: new Date(0),
    cardsCount: (idx % 3) + 1
}));

let inMemoryBotSettings = {
    isBotSystemActive: false,
    botWinnerForce: 'mix',
    mixBotCount: 1,
    botDist1: 0,
    botDist2: 0,
    botDist3: 0,
    botDist4: 0,
    isBotScheduleActive: false,
    botStepSeconds: 5,
    botSlots: []
};

async function getBotsFromStore(mongoose) {
    if (mongoose && mongoose.connection && mongoose.connection.readyState === 1) {
        let count = await BotUser.countDocuments();
        if (count === 0 && typeof initBotDatabase === 'function') {
            await initBotDatabase().catch(() => {});
        }
        return await BotUser.find().sort({ _id: -1 });
    }
    return inMemoryBots;
}

async function getSettingsFromStore(SystemSettings, mongoose) {
    if (mongoose && mongoose.connection && mongoose.connection.readyState === 1 && SystemSettings) {
        let s = await SystemSettings.findOne();
        if (!s && mongoose.models.Settings) {
            s = await mongoose.models.Settings.findOne();
        }
        if (!s) {
            s = new SystemSettings(inMemoryBotSettings);
            await s.save().catch(() => {});
        }
        return s;
    }
    return inMemoryBotSettings;
}

module.exports = function(SystemSettings, loadSettings, auth, context = {}) {
    const mongoose = context.mongoose || require('mongoose');

    // 1. የቦቶችን ዝርዝር ወደ Admin የሚያልከው
    router.post('/bots-list', auth, async (req, res) => {
        try {
            const bots = await getBotsFromStore(mongoose);
            const s = await getSettingsFromStore(SystemSettings, mongoose);
            const settingsObj = (s && typeof s.toObject === 'function') ? s.toObject() : (s || {});
            const merged = { ...inMemoryBotSettings, ...(global.__inMemorySettings || {}), ...settingsObj };
            res.json({
                success: true,
                bots: bots || [],
                settings: {
                    isBotSystemActive: !!merged.isBotSystemActive,
                    botWinnerForce: merged.botWinnerForce || 'mix',
                    mixBotCount: Number(merged.mixBotCount) || 1,
                    botDist1: Number(merged.botDist1 ?? 0),
                    botDist2: Number(merged.botDist2 ?? 0),
                    botDist3: Number(merged.botDist3 ?? 0),
                    botDist4: Number(merged.botDist4 ?? 0),
                    isBotScheduleActive: !!merged.isBotScheduleActive
                }
            });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // 2. Admin ላይ የሚስተካከለውን Bot Settings ሴቭ የሚያደርገው
    router.post(['/bot-master-update', '/bot-master-update-v2'], auth, async (req, res) => {
        try {
            const updates = {};
            if (req.body.isBotSystemActive !== undefined) updates.isBotSystemActive = !!req.body.isBotSystemActive;
            if (req.body.botWinnerForce !== undefined) updates.botWinnerForce = req.body.botWinnerForce;
            if (req.body.mixBotCount !== undefined) updates.mixBotCount = Math.max(1, Number(req.body.mixBotCount) || 1);
            if (req.body.botDist1 !== undefined) updates.botDist1 = Math.max(0, parseInt(req.body.botDist1, 10) || 0);
            if (req.body.botDist2 !== undefined) updates.botDist2 = Math.max(0, parseInt(req.body.botDist2, 10) || 0);
            if (req.body.botDist3 !== undefined) updates.botDist3 = Math.max(0, parseInt(req.body.botDist3, 10) || 0);
            if (req.body.botDist4 !== undefined) updates.botDist4 = Math.max(0, parseInt(req.body.botDist4, 10) || 0);
            if (req.body.isBotScheduleActive !== undefined) updates.isBotScheduleActive = !!req.body.isBotScheduleActive;

            Object.assign(inMemoryBotSettings, updates);
            if (!global.__inMemorySettings) global.__inMemorySettings = {};
            Object.assign(global.__inMemorySettings, updates);

            if (mongoose && mongoose.connection && mongoose.connection.readyState === 1) {
                if (SystemSettings) {
                    await SystemSettings.findOneAndUpdate({}, { $set: updates }, { upsert: true, new: true }).catch(() => {});
                }
                if (mongoose.models.Settings && mongoose.models.Settings !== SystemSettings) {
                    await mongoose.models.Settings.findOneAndUpdate({}, { $set: updates }, { upsert: true, new: true }).catch(() => {});
                }
            }
            if (typeof loadSettings === 'function') {
                await loadSettings({ forceSync: true, updates });
            }
            res.json({ success: true, settings: inMemoryBotSettings });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // 3. ቦትን Edit ማድረጊያ (ስም፣ ስልክ፣ ስንት ካርቴላ እንዲይዝ እና የራሱ On/Off)
    router.post('/bot-edit', auth, async (req, res) => {
        try {
            const { botId, name, phone, cardsCount, isActive } = req.body;
            const cleanCards = Math.max(1, Math.min(4, Number(cardsCount) || 1));
            const cleanActive = isActive !== false;
            let oldPhone = phone;

            if (mongoose && mongoose.connection && mongoose.connection.readyState === 1 && !String(botId).startsWith('bot_')) {
                const existing = await BotUser.findById(botId).catch(() => null);
                if (existing && existing.phone) oldPhone = existing.phone;
                await BotUser.findByIdAndUpdate(botId, {
                    name,
                    phone,
                    cardsCount: cleanCards,
                    isActive: cleanActive
                });
            }
            const memBot = inMemoryBots.find(b => String(b._id) === String(botId));
            if (memBot) {
                oldPhone = memBot.phone || oldPhone;
                memBot.name = name || memBot.name;
                memBot.phone = phone || memBot.phone;
                memBot.cardsCount = cleanCards;
                memBot.isActive = cleanActive;
            }
            if (typeof loadSettings === 'function') {
                await loadSettings({
                    editedBot: { botId, oldPhone, name, phone, cardsCount: cleanCards, isActive: cleanActive }
                });
            }
            res.json({ success: true, message: "Bot successfully updated!" });
        } catch (e) {
            res.json({ success: false, message: "Error updating bot: " + e.message });
        }
    });

    // 4. አዲስ ቦቶችን በብዛት መጨመሪያ
    router.post('/bot-add-custom', auth, async (req, res) => {
        try {
            const amount = Math.max(1, Math.min(200, parseInt(req.body.amount, 10) || 10));
            for (let i = 0; i < amount; i++) {
                const randName = ETHIOPIAN_BOT_NAMES[Math.floor(Math.random() * ETHIOPIAN_BOT_NAMES.length)];
                const randPhone = "09" + Math.floor(Math.random() * 90000000 + 10000000);
                const newBotObj = {
                    name: randName,
                    phone: randPhone,
                    cardsCount: (i % 3) + 1,
                    isActive: true,
                    lastPlayed: new Date(0)
                };
                if (mongoose && mongoose.connection && mongoose.connection.readyState === 1) {
                    await BotUser.create(newBotObj);
                } else {
                    inMemoryBots.unshift({
                        _id: 'bot_' + Date.now() + '_' + i,
                        ...newBotObj
                    });
                }
            }
            res.json({ success: true, message: `${amount} አዲስ ቦቶች ተጨምረዋል!` });
        } catch (e) {
            res.json({ success: false, message: e.message });
        }
    });

    // 5. የቦቶችን ስም እና ስልክ በጅምላ መቀየሪያ (Randomize Bot Names)
    router.post('/bots-rename-all', auth, async (req, res) => {
        try {
            const limit = parseInt(req.body.limit, 10) || 0;
            if (mongoose && mongoose.connection && mongoose.connection.readyState === 1) {
                let query = BotUser.find().sort({ _id: -1 });
                if (limit > 0) query = query.limit(limit);
                const bots = await query;
                for (let i = 0; i < bots.length; i++) {
                    const randName = ETHIOPIAN_BOT_NAMES[(i + Math.floor(Math.random() * ETHIOPIAN_BOT_NAMES.length)) % ETHIOPIAN_BOT_NAMES.length];
                    const randPhone = "09" + Math.floor(Math.random() * 90000000 + 10000000);
                    bots[i].name = randName;
                    bots[i].phone = randPhone;
                    await bots[i].save();
                }
                return res.json({ success: true, message: `✅ የ ${bots.length} ቦቶች ስም እና ስልክ ተቀይሯል!` });
            } else {
                const targetCount = limit > 0 ? Math.min(limit, inMemoryBots.length) : inMemoryBots.length;
                for (let i = 0; i < targetCount; i++) {
                    inMemoryBots[i].name = ETHIOPIAN_BOT_NAMES[Math.floor(Math.random() * ETHIOPIAN_BOT_NAMES.length)];
                    inMemoryBots[i].phone = "09" + Math.floor(Math.random() * 90000000 + 10000000);
                }
                return res.json({ success: true, message: `✅ የ ${targetCount} ቦቶች ስም እና ስልክ ተቀይሯል!` });
            }
        } catch (e) {
            res.json({ success: false, message: e.message });
        }
    });

    // 6. ቦት ማጥፊያ (Delete Bot)
    router.post('/delete-bot', auth, async (req, res) => {
        try {
            const { id } = req.body;
            let deletedPhone = null;
            if (mongoose && mongoose.connection && mongoose.connection.readyState === 1 && !String(id).startsWith('bot_')) {
                const doc = await BotUser.findByIdAndDelete(id).catch(() => null);
                if (doc && doc.phone) deletedPhone = doc.phone;
            }
            const foundMem = inMemoryBots.find(b => String(b._id) === String(id));
            if (foundMem && foundMem.phone) deletedPhone = foundMem.phone;
            inMemoryBots = inMemoryBots.filter(b => String(b._id) !== String(id));
            if (typeof loadSettings === 'function') {
                await loadSettings({ deletedBotPhone: deletedPhone });
            }
            res.json({ success: true, message: "Bot deleted!" });
        } catch (e) {
            res.json({ success: false, message: e.message });
        }
    });

    // 7. ቀስ እያሉ ካርቴላ እንዲገዙ (Simulate) ማድረጊያ
    router.post('/bot-gradual-buy', auth, async (req, res) => {
        try {
            const s = await getSettingsFromStore(SystemSettings, mongoose);
            if (s && s.isBotSystemActive === false) {
                return res.json({ success: true, bought: false, message: "Bot system is OFF" });
            }
            const bots = await getBotsFromStore(mongoose);
            const activeBots = bots.filter(b => b.isActive !== false);
            if (activeBots.length === 0) return res.json({ success: false });

            const randomBot = activeBots[Math.floor(Math.random() * activeBots.length)];
            res.json({
                success: true,
                bought: true,
                bot: randomBot.name,
                cards: randomBot.cardsCount || 1
            });
        } catch (e) {
            res.json({ success: false });
        }
    });

    router.getBotsFromStore = getBotsFromStore;
    router.getSettingsFromStore = getSettingsFromStore;
    router.inMemoryBotSettings = inMemoryBotSettings;
    router.inMemoryBots = inMemoryBots;
    return router;
};
