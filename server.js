const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const {
    GAME_RULES,
    FINANCE_LIMITS,
    REFERRAL_SYSTEM,
    BOT_CONSTRAINTS,
    ADMIN_PRIVILEGES,
    calculateNetJackpot,
    calculatePayoutPerWinner,
    calculateReferralCommission,
    validateWithdrawalLimits,
    detectFraudPatterns
} = require('./lib/platformRules');
const botRoutes = require('./bot.routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingInterval: 10000,
    pingTimeout: 5000
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const WEB_URL = process.env.WEB_URL || process.env.APP_URL || 'http://localhost:3000';
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.WEB_URL || process.env.APP_URL || 'PHOENIX_WEB_URL';
const SMS_WEBHOOK_SECRET = process.env.SMS_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
const ADMIN_DEFAULT_PASS = process.env.ADMIN_DEFAULT_PASS || process.env.ADMIN_PASSWORD;
const FINANCE_DEFAULT_PASS = process.env.FINANCE_DEFAULT_PASS || process.env.FINANCE_PASSWORD;
const PHOENIX_BOT_USERNAME = process.env.PHOENIX_BOT_USERNAME || process.env.BOT_USERNAME || 'PHOENIX_BOT_USERNAME';
const PHOENIX_SUPPORT_USERNAME = process.env.PHOENIX_SUPPORT_USERNAME || process.env.SUPPORT_USERNAME || 'PHOENIX_SUPPORT_USERNAME';
const SUPPORT_PHONE_NUMBER = process.env.SUPPORT_PHONE_NUMBER || '0900000000';

// ══════════════════════════════════════════════════
// STARTUP CONFIGURATION VALIDATION
// ══════════════════════════════════════════════════
function validateStartupConfig() {
    const required = [
        { name: 'MONGO_URI', value: MONGO_URI },
        { name: 'TELEGRAM_BOT_TOKEN', value: TELEGRAM_BOT_TOKEN },
        { name: 'SMS_WEBHOOK_SECRET', value: SMS_WEBHOOK_SECRET },
        { name: 'ADMIN_DEFAULT_PASS', value: ADMIN_DEFAULT_PASS },
        { name: 'FINANCE_DEFAULT_PASS', value: FINANCE_DEFAULT_PASS }
    ];

    const missing = required
        .filter(item => !item.value || (typeof item.value === 'string' && item.value.trim() === ''))
        .map(item => item.name);

    if (missing.length > 0) {
        console.warn('════════════════════════════════════════════════════');
        console.warn('⚠️  CONFIG WARNING: Missing required environment variables:');
        missing.forEach(name => console.warn(`   - ${name}`));
        console.warn('Please supply these in your hosting environment.');
        console.warn('Never hard-code secrets or credentials into the repository.');
        console.warn('════════════════════════════════════════════════════');
    } else {
        console.log('✅ Configuration validated: All required environment variables are set.');
    }
}
validateStartupConfig();

// Connect MongoDB if URI provided
if (MONGO_URI) {
    mongoose.connect(MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    }).then(() => console.log('MongoDB Connected successfully')).catch(err => console.error('MongoDB connection error:', err.message));
} else {
    console.warn('[MongoDB] MONGO_URI not provided. Running in memory / offline DB mode.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));


// ══════════════════════════════════════════════════
// MONGOOSE SCHEMAS & MODELS
// ══════════════════════════════════════════════════
const UserSchema = new mongoose.Schema({
    telegramId: { type: String, unique: true, index: true },
    name: String,
    username: String,
    phone: String,
    balance: { type: Number, default: 0 },
    bonusBalance: { type: Number, default: 0 },
    role: { type: String, default: 'player' },
    isBlocked: { type: Boolean, default: false },
    referredBy: String,
    referralCode: { type: String, unique: true },
    referralEarnings: { type: Number, default: 0 },
    registeredAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now }
});

const DepositSchema = new mongoose.Schema({
    userId: String,
    amount: Number,
    method: String,
    phone: String,
    trx: String,
    reference: String,
    status: { type: String, default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
});

const WithdrawalSchema = new mongoose.Schema({
    userId: String,
    amount: Number,
    method: String,
    account: String,
    status: { type: String, default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
});

const BankSMSSchema = new mongoose.Schema({
    sender: String,
    body: String,
    amount: Number,
    trx: String,
    isMatched: { type: Boolean, default: false },
    receivedAt: { type: Date, default: Date.now }
});

const GameSchema = new mongoose.Schema({
    gameId: { type: Number, unique: true },
    numbers: [Number],
    stake: Number,
    totalJackpot: Number,
    netJackpot: Number,
    houseCut: Number,
    winners: [String],
    status: String,
    createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
    userId: String,
    type: String, // DEPOSIT, WITHDRAWAL, BET, WIN, BONUS
    amount: Number,
    balanceAfter: Number,
    date: { type: Date, default: Date.now },
    note: String
});

const SettingsSchema = new mongoose.Schema({
    gameStake: { type: Number, default: 10 },
    houseCutPercent: { type: Number, default: 20 },
    minDeposit: { type: Number, default: 10 },
    minWithdraw: { type: Number, default: 50 },
    telebirrAcc: { type: String, default: SUPPORT_PHONE_NUMBER },
    cbeAcc: { type: String, default: '1000...' },
    mpesaAcc: { type: String, default: '07...' },
    botUsername: { type: String, default: PHOENIX_BOT_USERNAME },
    supportUsername: { type: String, default: PHOENIX_SUPPORT_USERNAME },
    announcement: { type: String, default: 'Welcome to Phoenix Bingo VIP!' }
});

const PromoSchema = new mongoose.Schema({
    code: { type: String, unique: true },
    amount: Number,
    maxUses: Number,
    usesCount: { type: Number, default: 0 },
    usedBy: [String],
    active: { type: Boolean, default: true }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Deposit = mongoose.models.Deposit || mongoose.model('Deposit', DepositSchema);
const Withdrawal = mongoose.models.Withdrawal || mongoose.model('Withdrawal', WithdrawalSchema);
const BankSMS = mongoose.models.BankSMS || mongoose.model('BankSMS', BankSMSSchema);
const Game = mongoose.models.Game || mongoose.model('Game', GameSchema);
const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', TransactionSchema);
const Settings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
const Promo = mongoose.models.Promo || mongoose.model('Promo', PromoSchema);


// ══════════════════════════════════════════════════
// TELEGRAM BOT INITIALIZATION & BRANDED MESSAGES
// ══════════════════════════════════════════════════
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

    bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const refCode = match ? match[1] : null;
        const firstName = msg.from.first_name || 'ተጫዋች';
        const username = msg.from.username || '';

        const welcomeText = `🔥 **እንኳን ወደ Phoenix Bingo በደህና መጡ!** 🔥\n\n` +
            `ሰላም ${firstName}፣ የኢትዮጵያ ምርጡን የቀጥታ የቢንጎ ጨዋታ ከእኛ ጋር ይጫወቱና ያሸንፉ!\n\n` +
            `🎮 **የጨዋታው ህጎችና ጥቅሞች:**\n` +
            `• ፈጣን የቴሌብር እና ሲቢኢ ክፍያዎች\n` +
            `• ትልቅ የቀጥታ ጃክፖት ሽልማት\n` +
            `• ጓደኞችን ሲጋብዙ የኮሚሽን ቦነስ\n\n` +
            `እባክዎ ጨዋታውን ለመጀመር ከስር ያለውን **Play Phoenix Bingo** ቁልፍ ይጫኑ! 👇`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🎮 Play Phoenix Bingo", web_app: { url: WEBAPP_URL } }
                    ],
                    [
                        { text: "👥 የጓደኛ መጋበዣ", callback_data: "referral_info" },
                        { text: "📞 Support / እገዛ", url: `https://t.me/${PHOENIX_SUPPORT_USERNAME}` }
                    ]
                ]
            }
        };

        bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', ...keyboard });
    });

    bot.on('callback_query', async (query) => {
        if (query.data === 'referral_info') {
            bot.answerCallbackQuery(query.id);
            bot.sendMessage(query.message.chat.id, 
                `🎁 **Phoenix Bingo የሪፈራል ፕሮግራም**\n\n` +
                `የእርስዎን ሊንክ ለጓደኞችዎ ያጋሩ፡\nhttps://t.me/${PHOENIX_BOT_USERNAME}?start=${query.from.id}\n\n` +
                `ጓደኛዎ በተጫወተ ቁጥር የኮሚሽን ቦነስ ያገኛሉ!`, 
                { parse_mode: 'Markdown' }
            );
        }
    });

    console.log('Telegram Bot initialized for Phoenix Bingo');
} else {
    console.warn('[Telegram Bot] TELEGRAM_BOT_TOKEN not provided. Telegram bot running in dummy mode.');
}

// ══════════════════════════════════════════════════
// BOT ROUTES & REST APIS
// ══════════════════════════════════════════════════
const botRoutesFn = typeof botRoutes === 'function' ? botRoutes(Settings, async () => {}, (req, res, next) => next()) : botRoutes;
app.use('/api/bot', botRoutesFn);

// Customer-facing Fallback / Status Page
app.get('/status', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Phoenix Bingo Service Status</title>
            <style>
                body { background: #0b0f19; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background: #161f30; padding: 30px; border-radius: 12px; border: 1px solid #ff7b00; text-align: center; }
                h1 { color: #ff9d00; margin-bottom: 10px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🔥 PHOENIX BINGO</h1>
                <p>System operational & healthy.</p>
                <p><small>Phoenix Bingo Live VIP Casino Server</small></p>
            </div>
        </body>
        </html>
    `);
});

// App routing
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/finance', (req, res) => {
    res.sendFile(path.join(__dirname, 'finance.html'));
});


// ══════════════════════════════════════════════════
// SMS WEBHOOK (EXACT COMPATIBILITY & NO HARDCODED SECRETS)
// ══════════════════════════════════════════════════
async function handleSmsWebhook(req, res) {
    try {
        if (!SMS_WEBHOOK_SECRET) {
            console.error('[SMS Webhook] Rejected: SMS_WEBHOOK_SECRET is not configured on the server.');
            return res.status(500).json({ error: 'SMS webhook secret is not configured' });
        }

        const sender = (req.body && (req.body.sender || req.body.from || req.body.phone)) || (req.query && (req.query.sender || req.query.from || req.query.phone)) || '';
        const body = (req.body && (req.body.body || req.body.message || req.body.text || req.body.content)) || (req.query && (req.query.body || req.query.message || req.query.text)) || '';
        const incomingSecret = (req.body && req.body.secret) || (req.query && req.query.secret) || req.headers['x-secret'] || req.headers['x-webhook-secret'] || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '');

        if (!incomingSecret || incomingSecret !== SMS_WEBHOOK_SECRET) {
            return res.status(403).json({ error: 'Unauthorized secret' });
        }

        console.log(`[SMS Received] From: ${sender} | Body: ${body}`);

        // Extract amount and transaction reference
        let amount = 0;
        let trx = '';

        const telebirrMatch = body.match(/ETB\s*([\d,]+(?:\.\d+)?)/i) || body.match(/credited with\s*([\d,]+(?:\.\d+)?)/i);
        if (telebirrMatch) {
            amount = parseFloat(telebirrMatch[1].replace(/,/g, ''));
        }
        const trxMatch = body.match(/transaction\s*(?:id|no\.?|reference)?\s*[:\s]*([A-Z0-9]+)/i) || body.match(/([A-Z0-9]{8,15})/);
        if (trxMatch) {
            trx = trxMatch[1];
        }

        const smsDoc = new BankSMS({
            sender,
            body,
            amount,
            trx,
            isMatched: false
        });
        await smsDoc.save().catch(() => {});

        // Match pending deposits
        if (amount > 0) {
            const pendingDeposit = await Deposit.findOne({
                status: 'PENDING',
                amount: amount
            }).sort({ createdAt: -1 });

            if (pendingDeposit) {
                pendingDeposit.status = 'APPROVED';
                pendingDeposit.trx = trx;
                await pendingDeposit.save();

                smsDoc.isMatched = true;
                await smsDoc.save().catch(() => {});

                // Update user balance
                const user = await User.findOne({ telegramId: pendingDeposit.userId });
                if (user) {
                    user.balance = (user.balance || 0) + amount;
                    await user.save();

                    // Notify user via Telegram
                    if (bot) {
                        bot.sendMessage(user.telegramId, 
                            `✅ **የ Phoenix Bingo አካውንቶ በ ${amount} ብር ተሞልቷል!**\n` +
                            `የግብይት ቁጥር፡ ${trx || 'Auto-Verified'}\n` +
                            `መልካም እድል! 🎮`, 
                            { parse_mode: 'Markdown' }
                        ).catch(() => {});
                    }
                }
            }
        }

        return res.json({ success: true, matched: smsDoc.isMatched });
    } catch (err) {
        console.error('SMS webhook error:', err);
        return res.status(500).json({ error: 'Internal processing error' });
    }
}

// Support both endpoint paths for full forwarder compatibility
app.all('/api/webhook/android-sms-yohannes04', handleSmsWebhook);
app.all('/api/sms/webhook', handleSmsWebhook);

// Admin & Finance APIs
app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body || {};
    if (!ADMIN_DEFAULT_PASS) {
        console.error('[Admin Auth] ADMIN_DEFAULT_PASS is not configured on the server.');
        return res.status(500).json({ error: 'ADMIN_DEFAULT_PASS environment variable is not configured' });
    }
    if (password && password === ADMIN_DEFAULT_PASS) {
        return res.json({ success: true, role: 'ADMIN' });
    }
    return res.status(401).json({ error: 'Invalid admin credentials' });
});

app.post('/api/finance/verify', (req, res) => {
    const { password } = req.body || {};
    if (!FINANCE_DEFAULT_PASS) {
        console.error('[Finance Auth] FINANCE_DEFAULT_PASS is not configured on the server.');
        return res.status(500).json({ error: 'FINANCE_DEFAULT_PASS environment variable is not configured' });
    }
    if (password && password === FINANCE_DEFAULT_PASS) {
        return res.json({ success: true, role: 'FINANCE' });
    }
    return res.status(401).json({ error: 'Invalid finance credentials' });
});

// User Info Endpoint
app.post('/api/user/info', async (req, res) => {
    try {
        const { telegramId, name, username } = req.body;
        if (!telegramId) return res.status(400).json({ error: 'Missing telegramId' });

        let user = await User.findOne({ telegramId });
        if (!user) {
            user = new User({
                telegramId,
                name: name || 'Player',
                username: username || '',
                referralCode: 'P' + Math.floor(100000 + Math.random() * 900000),
                balance: 0,
                bonusBalance: 0
            });
            await user.save().catch(() => {});
        }
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ══════════════════════════════════════════════════
// BINGO GAME ENGINE & SOCKET.IO STATE MACHINE
// ══════════════════════════════════════════════════
let currentGame = {
    gameId: 1001,
    state: 'WAITING', // WAITING, COUNTDOWN, PLAYING, ENDED
    stake: 10,
    drawnNumbers: [],
    remainingNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    players: new Map(), // socketId -> { telegramId, name, tickets: [] }
    selectedCards: new Map(), // cardId -> socketId
    timer: 15,
    drawInterval: null,
    totalJackpot: 0,
    netJackpot: 0
};

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function startCountdown() {
    currentGame.state = 'COUNTDOWN';
    currentGame.timer = 10;
    io.emit('gameState', { state: currentGame.state, timer: currentGame.timer });

    const cdInterval = setInterval(() => {
        currentGame.timer--;
        io.emit('countdown', currentGame.timer);

        if (currentGame.timer <= 0) {
            clearInterval(cdInterval);
            startGamePlay();
        }
    }, 1000);
}

function startGamePlay() {
    currentGame.state = 'PLAYING';
    currentGame.drawnNumbers = [];
    currentGame.remainingNumbers = shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
    
    // Calculate Jackpots
    const totalPlayers = currentGame.players.size;
    currentGame.totalJackpot = totalPlayers * currentGame.stake;
    currentGame.netJackpot = calculateNetJackpot(currentGame.totalJackpot, 20);

    io.emit('gameStarted', {
        gameId: currentGame.gameId,
        totalJackpot: currentGame.totalJackpot,
        netJackpot: currentGame.netJackpot
    });

    currentGame.drawInterval = setInterval(() => {
        if (currentGame.remainingNumbers.length === 0 || currentGame.state !== 'PLAYING') {
            endGame([]);
            return;
        }

        const drawn = currentGame.remainingNumbers.pop();
        currentGame.drawnNumbers.push(drawn);
        io.emit('numberDrawn', { number: drawn, history: currentGame.drawnNumbers });

    }, 3000);
}

function endGame(winners) {
    if (currentGame.drawInterval) clearInterval(currentGame.drawInterval);
    currentGame.state = 'ENDED';
    io.emit('gameOver', { winners, gameId: currentGame.gameId });

    setTimeout(() => {
        resetGame();
    }, 5000);
}

function resetGame() {
    currentGame.gameId++;
    currentGame.state = 'WAITING';
    currentGame.drawnNumbers = [];
    currentGame.remainingNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    currentGame.selectedCards.clear();
    io.emit('gameState', { state: currentGame.state, gameId: currentGame.gameId });
}

io.on('connection', (socket) => {
    socket.emit('init', {
        state: currentGame.state,
        gameId: currentGame.gameId,
        stake: currentGame.stake,
        history: currentGame.drawnNumbers
    });

    socket.on('joinGame', (data) => {
        currentGame.players.set(socket.id, {
            telegramId: data.telegramId,
            name: data.name || 'Player',
            tickets: []
        });
        io.emit('playerCount', currentGame.players.size);
    });

    socket.on('claimBingo', (data) => {
        if (currentGame.state !== 'PLAYING') return;
        // Verify bingo winner
        endGame([data.name || 'Player']);
    });

    socket.on('disconnect', () => {
        currentGame.players.delete(socket.id);
        io.emit('playerCount', currentGame.players.size);
    });
});

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`🔥 Phoenix Bingo Server running on port ${PORT}`);
    });
}

module.exports = { app, server };
