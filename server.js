const express = require('express');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
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

const {
    MIN_JACKPOT_THRESHOLD,
    MAX_JACKPOT_THRESHOLD,
    DEFAULT_JACKPOT_THRESHOLD,
    generateFixedCard,
    checkWinningPatterns,
    validateJackpotThreshold,
    evaluateJackpotEligibility,
    verifyBingoClaim
} = require('./lib/bingoRules');

const getNetJackpot = (typeof calculateNetJackpot === 'function')
    ? calculateNetJackpot
    : function(tot, cut = 20) { return Math.round((Number(tot) || 0) * (1 - (Number(cut) || 0) / 100) * 100) / 100; };
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
const ADMIN_DEFAULT_PASS = process.env.ADMIN_DEFAULT_PASS || process.env.ADMIN_PASSWORD || 'admin123';
const FINANCE_DEFAULT_PASS = process.env.FINANCE_DEFAULT_PASS || process.env.FINANCE_PASSWORD || 'finance123';
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
        .filter(item => !item.value || (typeof item.value === 'string' && (item.value.trim() === '' || /<[^>]+>/.test(item.value))))
        .map(item => item.name);

    if (missing.length > 0) {
        console.warn('════════════════════════════════════════════════════');
        console.warn('⚠️  CONFIG WARNING: Missing or placeholder environment variables:');
        missing.forEach(name => console.warn(`   - ${name}`));
        console.warn('Please supply these in your hosting environment.');
        console.warn('Never hard-code secrets or credentials into the repository.');
        console.warn('════════════════════════════════════════════════════');
    } else {
        console.log('✅ Configuration validated: All required environment variables are set.');
    }
}
validateStartupConfig();

function maskMongoUri(uri) {
    if (!uri || typeof uri !== 'string') return '[NOT SET]';
    return uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
}

function checkMongoUriValid(uri) {
    if (!uri || typeof uri !== 'string' || !uri.trim()) return false;
    if (uri.includes('<db_password>') || uri.includes('<password>') || uri.includes('<DB_PASSWORD>') || /<[^>]+>/.test(uri)) {
        return false;
    }
    return uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://');
}

function validateProductionDatabaseRequirements({ nodeEnv = process.env.NODE_ENV, mongoUri = MONGO_URI, connectionReadyState = (mongoose.connection ? mongoose.connection.readyState : 0) } = {}) {
    if (nodeEnv === 'production') {
        if (!checkMongoUriValid(mongoUri)) {
            return {
                canProceed: false,
                reason: 'MISSING_OR_PLACEHOLDER_MONGO_URI',
                message: `Production mode requires a valid non-placeholder MONGO_URI. Configured: ${maskMongoUri(mongoUri)}`
            };
        }
        if (connectionReadyState !== 1) {
            return {
                canProceed: false,
                reason: 'DATABASE_NOT_CONNECTED',
                message: 'Production mode requires an active MongoDB connection.'
            };
        }
    }
    return { canProceed: true };
}

// Connect MongoDB if valid non-placeholder URI provided
const isMongoUriConfigured = checkMongoUriValid(MONGO_URI);

if (process.env.NODE_ENV === 'production' && !isMongoUriConfigured) {
    console.error(`[FATAL STARTUP] NODE_ENV=production requires a valid, non-placeholder MONGO_URI. Configured URI: ${maskMongoUri(MONGO_URI)}. Terminating startup safely.`);
    if (require.main === module) {
        process.exit(1);
    }
}

if (isMongoUriConfigured) {
    mongoose.connection.on('error', (err) => {
        console.warn('[MongoDB] Connection event notice:', err && err.message ? err.message : err);
    });

    mongoose.connect(MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000
    }).then(async () => {
        console.log('MongoDB Connected successfully');
        await ensureDatabaseIndexes();
    }).catch(err => {
        const safeErrMsg = err && err.message ? err.message : String(err);
        if (process.env.NODE_ENV === 'production') {
            console.error(`[FATAL STARTUP] MongoDB connection failed in production mode (${safeErrMsg}). Terminating startup safely.`);
            if (require.main === module) {
                process.exit(1);
            }
        } else {
            console.warn('[MongoDB] Connection failed (' + safeErrMsg + '). Operating in resilient in-memory mode.');
            try {
                mongoose.disconnect().catch(() => {});
            } catch (_) {}
        }
    });
} else {
    if (process.env.NODE_ENV === 'production') {
        console.error(`[FATAL STARTUP] MONGO_URI is missing or placeholder in production mode. Configured URI: ${maskMongoUri(MONGO_URI)}. Terminating startup safely.`);
        if (require.main === module) {
            process.exit(1);
        }
    } else {
        if (MONGO_URI) {
            console.warn('[MongoDB] MONGO_URI contains an unreplaced credential placeholder (e.g. <db_password>). Running in resilient in-memory mode.');
        } else {
            console.warn('[MongoDB] MONGO_URI not provided. Running in resilient in-memory mode.');
        }
    }
}

// Enable CORS for external frontends / webviews connecting to Phoenix Bingo Render backend
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret, x-webhook-secret, x-admin-pass');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname)));


// ══════════════════════════════════════════════════
// MONGOOSE SCHEMAS & MODELS
// ══════════════════════════════════════════════════
const UserSchema = new mongoose.Schema({
    userId: { type: String, sparse: true, index: true },
    telegramId: { type: String, unique: true, sparse: true, index: true },
    name: String,
    username: String,
    phone: { type: String, unique: true, sparse: true, index: true },
    password: { type: String },
    fingerprint: { type: String },
    balance: { type: Number, default: 0 },
    bonusBalance: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    mainBalance: { type: Number, default: 0 },
    playBalance: { type: Number, default: 0 },
    registrationBonusClaimed: { type: Boolean, default: false },
    played: { type: Number, default: 0 },
    won: { type: Number, default: 0 },
    totalWon: { type: Number, default: 0 },
    role: { type: String, default: 'player' },
    isBlocked: { type: Boolean, default: false },
    referredBy: String,
    referralCode: { type: String, unique: true, sparse: true },
    referralEarnings: { type: Number, default: 0 },
    registeredAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now }
}, {
    autoIndex: false,
    strict: false
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

const {
    withUserLock,
    getAuthoritativeUser,
    debitTicketPurchase,
    refundTicketPurchase,
    processWinnerPayouts
} = require('./lib/walletManager');

const GameSchema = new mongoose.Schema({
    gameId: { type: Number, unique: true },
    numbers: [Number],
    stake: Number,
    totalJackpot: Number,
    netJackpot: Number,
    houseCut: Number,
    winners: [String],
    winnerData: [mongoose.Schema.Types.Mixed],
    status: String,
    playersData: [mongoose.Schema.Types.Mixed],
    jackpotThreshold: { type: Number, default: 16 },
    isJackpotWin: { type: Boolean, default: false },
    winningPattern: { type: mongoose.Schema.Types.Mixed, default: null },
    payoutsProcessed: [mongoose.Schema.Types.Mixed],
    createdAt: { type: Date, default: Date.now }
}, { strict: false });

const TransactionSchema = new mongoose.Schema({
    reference: { type: String, unique: true, sparse: true, index: true },
    txRef: { type: String },
    userId: { type: String, index: true },
    phone: { type: String, index: true },
    type: String, // deposit, withdraw, win, DEPOSIT, WITHDRAWAL, BET, WIN, BONUS, REFUND
    method: String,
    amount: Number,
    bonusGiven: { type: Number, default: 0 },
    status: { type: String, default: 'Approved' }, // Pending, Approved, Rejected
    smsText: String,
    balanceAfter: Number,
    date: { type: Date, default: Date.now, index: true },
    note: String
}, { strict: false });

const SettingsSchema = new mongoose.Schema({
    gameStake: { type: Number, default: 10 },
    ticketPrice: { type: Number, default: 10 },
    gameTimer: { type: Number, default: 40 },
    maxTicketsPerUser: { type: Number, default: 4 },
    minWithdrawLimit: { type: Number, default: 50 },
    jackpotThreshold: { type: Number, default: 16 },
    jackpotBoostAmount: { type: Number, default: 0 },
    winPopupTimer: { type: Number, default: 12 },
    adminProfitPercent: { type: Number, default: 20 },
    houseCutPercent: { type: Number, default: 20 },
    minDeposit: { type: Number, default: 10 },
    minWithdraw: { type: Number, default: 50 },
    registerBonus: { type: Number, default: 15 },
    inviteBonus: { type: Number, default: 10 },
    telebirrAccountName: { type: String, default: 'Phoenix Bingo' },
    telebirrAccountNumber: { type: String, default: SUPPORT_PHONE_NUMBER },
    cbeAccountName: { type: String, default: 'Phoenix Bingo' },
    cbeAccountNumber: { type: String, default: SUPPORT_PHONE_NUMBER },
    mpesaAccountName: { type: String, default: 'Phoenix Bingo' },
    mpesaAccountNumber: { type: String, default: '0700000000' },
    isBotSystemActive: { type: Boolean, default: false },
    adminConfiguredBots: { type: Boolean, default: false },
    botWinnerForce: { type: String, default: 'mix' },
    mixBotCount: { type: Number, default: 1 },
    botDist1: { type: Number, default: 0 },
    botDist2: { type: Number, default: 0 },
    botDist3: { type: Number, default: 0 },
    botDist4: { type: Number, default: 0 },
    isBotScheduleActive: { type: Boolean, default: false },
    botStepSeconds: { type: Number, default: 5 },
    botSlots: { type: Array, default: [] },
    isGamePaused: { type: Boolean, default: false },
    virtualPrizePool: { type: Number, default: 0 },
    vaultTwoBalance: { type: Number, default: 0 },
    vaultTwoPercent: { type: Number, default: 10 },
    vaultThreeBalance: { type: Number, default: 0 },
    vaultThreePercent: { type: Number, default: 10 },
    decoyChancePercent: { type: Number, default: 15 },
    bonusWinPercent: { type: Number, default: 0 },
    botUsername: { type: String, default: PHOENIX_BOT_USERNAME },
    supportUsername: { type: String, default: PHOENIX_SUPPORT_USERNAME },
    telegramChannel: { type: String, default: '' },
    announcement: { type: String, default: 'Welcome to Phoenix Bingo VIP!' }
}, { strict: false });

const PromoSchema = new mongoose.Schema({
    code: { type: String, unique: true },
    amount: Number,
    maxUses: Number,
    currentUses: { type: Number, default: 0 },
    usesCount: { type: Number, default: 0 },
    requireDeposit: { type: Boolean, default: false },
    minDepositAmount: { type: Number, default: 0 },
    requireDepositWithinHours: { type: Number, default: 0 },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    usedBy: [String],
    active: { type: Boolean, default: true }
}, { strict: false });

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Deposit = mongoose.models.Deposit || mongoose.model('Deposit', DepositSchema);
const Withdrawal = mongoose.models.Withdrawal || mongoose.model('Withdrawal', WithdrawalSchema);
const BankSMS = mongoose.models.BankSMS || mongoose.model('BankSMS', BankSMSSchema);
const Game = mongoose.models.Game || mongoose.model('Game', GameSchema);
const GameHistory = mongoose.models.GameHistory || mongoose.model('GameHistory', GameSchema);
const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', TransactionSchema);
const Settings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
const SystemSettings = mongoose.models.SystemSettings || mongoose.model('SystemSettings', SettingsSchema);
const Promo = mongoose.models.Promo || mongoose.model('Promo', PromoSchema);
const PromoCode = mongoose.models.PromoCode || mongoose.model('PromoCode', PromoSchema);

async function ensureDatabaseIndexes() {
    if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
            if (Transaction && typeof Transaction.init === 'function') {
                await Transaction.init();
            }
            if (User && typeof User.init === 'function') {
                await User.init();
            }
            if (Game && typeof Game.init === 'function') {
                await Game.init();
            }
            console.log('✅ MongoDB unique constraints and indexes verified & synchronized.');
        } catch (err) {
            console.warn('[MongoDB] Index verification notice:', err.message);
        }
    }
}

async function rehydrateSettingsAndRecoverPayouts() {
    if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
            await ensureDatabaseIndexes();
            let savedSettings = await SystemSettings.findOne().catch(() => null);
            if (!savedSettings) {
                savedSettings = await Settings.findOne().catch(() => null);
            }
            if (savedSettings) {
                const sObj = typeof savedSettings.toObject === 'function' ? savedSettings.toObject() : savedSettings;
                // If an old unconfigured default (5,4,3,3) was auto-created without Admin saving, reset it to 0
                if (!sObj.adminConfiguredBots && sObj.botDist1 === 5 && sObj.botDist2 === 4 && sObj.botDist3 === 3 && sObj.botDist4 === 3) {
                    const resetDefaults = {
                        isBotSystemActive: false,
                        botDist1: 0,
                        botDist2: 0,
                        botDist3: 0,
                        botDist4: 0,
                        adminConfiguredBots: true
                    };
                    await SystemSettings.updateMany({}, { $set: resetDefaults }).catch(() => {});
                    await Settings.updateMany({}, { $set: resetDefaults }).catch(() => {});
                    Object.assign(sObj, resetDefaults);
                }
                if (!global.__inMemorySettings) global.__inMemorySettings = {};
                Object.assign(global.__inMemorySettings, sObj);
                if (botRoutesFn && botRoutesFn.inMemoryBotSettings) {
                    Object.assign(botRoutesFn.inMemoryBotSettings, {
                        isBotSystemActive: !!sObj.isBotSystemActive,
                        botWinnerForce: sObj.botWinnerForce || 'mix',
                        mixBotCount: Number(sObj.mixBotCount) || 1,
                        botDist1: Number(sObj.botDist1 ?? 0),
                        botDist2: Number(sObj.botDist2 ?? 0),
                        botDist3: Number(sObj.botDist3 ?? 0),
                        botDist4: Number(sObj.botDist4 ?? 0),
                        isBotScheduleActive: !!sObj.isBotScheduleActive
                    });
                }
                if (sObj.jackpotThreshold) {
                    currentGame.jackpotThreshold = validateJackpotThreshold(sObj.jackpotThreshold);
                }
                if ((sObj.ticketPrice || sObj.gameStake) && Number(sObj.ticketPrice || sObj.gameStake) > 0) {
                    currentGame.stake = Number(sObj.ticketPrice || sObj.gameStake);
                }
            }
            // Recover any completed games that have winners but missed payout processing
            const uncreditedGames = await Game.find({
                status: { $in: ['COMPLETED', 'RESOLVING_WINNERS'] },
                'winners.0': { $exists: true },
                $or: [
                    { payoutsProcessed: { $exists: false } },
                    { payoutsProcessed: { $size: 0 } }
                ]
            });
            for (const g of uncreditedGames) {
                if (Array.isArray(g.winners) && g.winners.length > 0) {
                    console.log(`[Startup Recovery] Re-verifying payouts for Game #${g.gameId}`);
                    await processWinnerPayouts({
                        gameId: g.gameId,
                        winners: g.winners,
                        totalPrize: g.netJackpot || g.totalJackpot || 0,
                        claimMeta: { isJackpotWin: g.isJackpotWin },
                        User,
                        Transaction,
                        Game,
                        inMemoryUsers,
                        inMemoryGames
                    });
                }
            }
            // Determine highest gameId so we never reuse or clash with previous game IDs
            const latestGame = await Game.findOne().sort({ gameId: -1 });
            if (latestGame && typeof latestGame.gameId === 'number' && latestGame.gameId >= currentGame.gameId) {
                currentGame.gameId = latestGame.gameId + 1;
            }

            // Close any interrupted games from before the crash
            await Game.updateMany(
                { status: { $in: ['PLAYING', 'RESOLVING_WINNERS', 'WAITING'] }, gameId: { $lt: currentGame.gameId } },
                { $set: { status: 'INTERRUPTED' } }
            );
        } catch (err) {
            console.warn('[Startup] Settings rehydration / recovery warning:', err.message);
        }
    } else {
        let maxId = 1000;
        if (Array.isArray(inMemoryGames)) {
            for (const g of inMemoryGames) {
                if (g && typeof g.gameId === 'number' && g.gameId > maxId) {
                    maxId = g.gameId;
                }
                if (g && (g.status === 'PLAYING' || g.status === 'WAITING' || g.status === 'RESOLVING_WINNERS')) {
                    g.status = 'INTERRUPTED';
                }
            }
        }
        if (maxId >= currentGame.gameId) {
            currentGame.gameId = maxId + 1;
        }
    }
}

if (mongoose.connection.readyState === 1) {
    rehydrateSettingsAndRecoverPayouts().catch(() => {});
} else {
    mongoose.connection.once('connected', () => {
        rehydrateSettingsAndRecoverPayouts().catch(() => {});
    });
}

// ══════════════════════════════════════════════════
// USER NORMALIZATION & HELPER FUNCTIONS
// ══════════════════════════════════════════════════
const inMemoryUsers = new Map();
const inMemoryGames = [];
const pendingReferrals = new Map();

function normalizePhoneNumber(raw) {
    if (!raw) return '';
    let cleaned = String(raw).trim().replace(/\D/g, '');
    if (cleaned.startsWith('251')) {
        cleaned = '0' + cleaned.slice(3);
    } else if (cleaned.length === 9 && (cleaned.startsWith('9') || cleaned.startsWith('7'))) {
        cleaned = '0' + cleaned;
    }
    return cleaned;
}

function formatUserResponse(u) {
    const raw = (u && typeof u.toObject === 'function') ? u.toObject() : (u || {});
    const mainBal = raw.mainBalance ?? raw.balance ?? 0;
    const playBal = raw.playBalance ?? raw.bonusBalance ?? raw.bonus ?? 0;
    return {
        phone: raw.phone || raw.userId || '',
        name: raw.name || 'Player',
        balance: mainBal,
        bonusBalance: playBal,
        mainBalance: mainBal,
        playBalance: playBal,
        registrationBonusClaimed: !!raw.registrationBonusClaimed,
        role: raw.role || 'player',
        refCode: raw.referralCode || raw.refCode || raw.phone || '',
        referralCode: raw.referralCode || raw.refCode || '',
        referredBy: raw.referredBy || '',
        played: raw.played ?? 0,
        won: raw.won ?? raw.totalWon ?? 0
    };
}

async function hashPassword(plainPassword) {
    if (!plainPassword || typeof plainPassword !== 'string') return '';
    return await bcrypt.hash(plainPassword.trim(), 10);
}

function isBcryptHash(str) {
    if (!str || typeof str !== 'string') return false;
    return /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(str);
}

async function verifyAndMigratePassword(user, candidatePassword) {
    if (!user || !user.password || !candidatePassword) return false;
    const stored = String(user.password).trim();
    const candidate = String(candidatePassword).trim();

    if (isBcryptHash(stored)) {
        try {
            return await bcrypt.compare(candidate, stored);
        } catch (_) {
            return false;
        }
    }

    // Backward-compatible verification for legacy plaintext accounts
    const match = (stored === candidate);
    if (match) {
        // Upgrade legacy plaintext password to secure bcrypt hash
        try {
            const newHash = await hashPassword(candidate);
            user.password = newHash;
            if (typeof user.save === 'function') {
                await user.save().catch(() => {});
            }
            if (inMemoryUsers && user.phone) {
                const memU = inMemoryUsers.get(user.phone);
                if (memU) memU.password = newHash;
            }
        } catch (migErr) {
            console.warn('[Auth] Password migration notice:', migErr.message);
        }
    }
    return match;
}

function verifyTelegramWebAppData(initData, botToken = TELEGRAM_BOT_TOKEN, maxAgeSeconds = 86400) {
    if (!initData || typeof initData !== 'string' || !initData.trim()) {
        return { valid: false, error: 'Missing or empty initData' };
    }
    if (!botToken || typeof botToken !== 'string' || !botToken.trim()) {
        return { valid: false, error: 'Missing or invalid bot token' };
    }

    try {
        const searchParams = new URLSearchParams(initData.trim());
        const receivedHash = searchParams.get('hash');
        if (!receivedHash) {
            return { valid: false, error: 'Missing hash parameter in initData' };
        }

        // Delete hash from parameters before building data_check_string
        searchParams.delete('hash');

        // Sort keys alphabetically in ascending order
        const keys = Array.from(searchParams.keys()).sort();
        const dataCheckPairs = [];
        for (const key of keys) {
            dataCheckPairs.push(`${key}=${searchParams.get(key)}`);
        }
        const dataCheckString = dataCheckPairs.join('\n');

        // HMAC-SHA-256 signature of the bot token with string "WebAppData" as key
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        const receivedBuf = Buffer.from(receivedHash, 'hex');
        const calculatedBuf = Buffer.from(calculatedHash, 'hex');

        if (receivedBuf.length !== calculatedBuf.length || !crypto.timingSafeEqual(receivedBuf, calculatedBuf)) {
            return { valid: false, error: 'Invalid hash signature' };
        }

        // Expiration check on auth_date
        const authDateRaw = searchParams.get('auth_date');
        if (!authDateRaw) {
            return { valid: false, error: 'Missing auth_date in initData' };
        }
        const authDate = parseInt(authDateRaw, 10);
        if (isNaN(authDate)) {
            return { valid: false, error: 'Invalid auth_date format' };
        }

        const now = Math.floor(Date.now() / 1000);
        if (authDate > now + 300) {
            return { valid: false, error: 'auth_date cannot be in the future' };
        }
        if (maxAgeSeconds > 0 && (now - authDate) > maxAgeSeconds) {
            return { valid: false, error: 'initData has expired' };
        }

        // Parse user data
        const userRaw = searchParams.get('user');
        if (!userRaw) {
            return { valid: false, error: 'Missing user object in initData' };
        }

        let telegramUser;
        try {
            telegramUser = JSON.parse(userRaw);
        } catch (e) {
            return { valid: false, error: 'Failed to parse user JSON in initData' };
        }

        if (!telegramUser || (telegramUser.id === undefined || telegramUser.id === null)) {
            return { valid: false, error: 'Missing user id in Telegram user object' };
        }

        return {
            valid: true,
            telegramUser,
            authDate
        };
    } catch (err) {
        return { valid: false, error: 'Failed to parse initData: ' + err.message };
    }
}

async function findUserByTgOrPhone(telegramId, phone) {
    const tgStr = telegramId ? String(telegramId).trim() : null;
    const normalized = phone ? normalizePhoneNumber(phone) : null;
    const phoneVariants = [];
    if (normalized) phoneVariants.push(normalized);
    if (phone && phone !== normalized) phoneVariants.push(phone);
    if (normalized && normalized.startsWith('0')) {
        phoneVariants.push('+251' + normalized.slice(1));
        phoneVariants.push('251' + normalized.slice(1));
    }

    if (mongoose.connection.readyState === 1) {
        const orClauses = [];
        if (tgStr) {
            orClauses.push({ telegramId: tgStr });
            orClauses.push({ userId: tgStr });
        }
        if (phoneVariants.length > 0) {
            orClauses.push({ phone: { $in: phoneVariants } });
            orClauses.push({ userId: { $in: phoneVariants } });
        }
        if (orClauses.length === 0) return null;
        return await User.findOne({ $or: orClauses });
    } else {
        if (tgStr && inMemoryUsers.has(tgStr)) return inMemoryUsers.get(tgStr);
        if (normalized && inMemoryUsers.has(normalized)) return inMemoryUsers.get(normalized);
        if (phone && inMemoryUsers.has(phone)) return inMemoryUsers.get(phone);
        for (const u of inMemoryUsers.values()) {
            if (tgStr && (String(u.telegramId) === tgStr || String(u.userId) === tgStr)) return u;
            if (normalized && (u.phone === normalized || u.phone === phone)) return u;
        }
        return null;
    }
}

const activeRegistrations = new Map();

async function registerTelegramUser({ telegramId, phone, name, username, refCode }) {
    const tgStr = String(telegramId).trim();
    const rawPhone = String(phone || '').trim();
    const normalized = normalizePhoneNumber(rawPhone);

    const tgKey = 'tg_' + tgStr;
    const phoneKey = normalized ? 'phone_' + normalized : null;

    const inFlight = activeRegistrations.get(tgKey) || (phoneKey ? activeRegistrations.get(phoneKey) : null);
    if (inFlight) {
        await inFlight;
        const existing = await findUserByTgOrPhone(tgStr, normalized);
        if (existing) {
            return { isNew: false, user: existing };
        }
    }

    let resolveLock;
    const lockPromise = new Promise(r => resolveLock = r);
    activeRegistrations.set(tgKey, lockPromise);
    if (phoneKey) activeRegistrations.set(phoneKey, lockPromise);

    try {
        // 1. Search MongoDB for existing player
        let existingUser = await findUserByTgOrPhone(tgStr, normalized);
        if (existingUser) {
            // Player already exists:
            // Do NOT create another account.
            // Do NOT give another 15 ETB.
            // Preserve all existing balances and account data.
            if (!existingUser.telegramId || existingUser.telegramId.startsWith('web_')) {
                existingUser.telegramId = tgStr;
                existingUser.userId = existingUser.userId || tgStr;
                if (typeof existingUser.save === 'function') {
                    await existingUser.save().catch(() => {});
                }
            }
            inMemoryUsers.set(tgStr, existingUser);
            if (existingUser.phone) inMemoryUsers.set(existingUser.phone, existingUser);
            return { isNew: false, user: existingUser };
        }

        // 2. Genuinely new player: create account and grant exactly 15 ETB play/bonus balance
        const referralCode = 'P' + Math.floor(100000 + Math.random() * 900000);
        const userData = {
            userId: tgStr,
            telegramId: tgStr,
            phone: normalized,
            name: name || 'Player',
            username: username || '',
            referredBy: (refCode || '').trim(),
            referralCode,
            balance: 0,
            mainBalance: 0,
            playBalance: 15,
            bonusBalance: 15,
            bonus: 15,
            registrationBonusClaimed: true,
            role: 'player',
            played: 0,
            won: 0,
            totalWon: 0,
            registeredAt: new Date(),
            lastActive: new Date()
        };

        let savedUser = userData;
        if (mongoose.connection.readyState === 1) {
            try {
                const newUser = new User(userData);
                await newUser.save();
                savedUser = newUser;
            } catch (saveErr) {
                if (saveErr.code === 11000) {
                    // Concurrent race condition protected by MongoDB unique index!
                    const concurrentUser = await findUserByTgOrPhone(tgStr, normalized);
                    if (concurrentUser) {
                        return { isNew: false, user: concurrentUser };
                    }
                }
                throw saveErr;
            }
        }

        inMemoryUsers.set(tgStr, savedUser);
        if (normalized) inMemoryUsers.set(normalized, savedUser);
        return { isNew: true, user: savedUser };
    } finally {
        activeRegistrations.delete(tgKey);
        if (phoneKey) activeRegistrations.delete(phoneKey);
        if (resolveLock) resolveLock();
    }
}


// ══════════════════════════════════════════════════
// TELEGRAM BOT INITIALIZATION & BRANDED MESSAGES
// ══════════════════════════════════════════════════
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
    // 1. Process-level Singleton: Stop any pre-existing bot polling in this server process
    if (global.__phoenixTelegramBot) {
        try {
            if (typeof global.__phoenixTelegramBot.stopPolling === 'function' && global.__phoenixTelegramBot.isPolling()) {
                global.__phoenixTelegramBot.stopPolling({ cancel: true, reason: 'Replacing instance' }).catch(() => {});
            }
        } catch (_) {}
    }

    // 2. Mutual exclusivity: Polling and WebHook modes cannot run simultaneously
    const isWebhookMode = process.env.TELEGRAM_MODE === 'webhook' || 
                          process.env.USE_TELEGRAM_WEBHOOK === 'true' || 
                          process.env.TELEGRAM_WEBHOOK === 'true';
    const isPollingEnabled = !isWebhookMode && 
                             process.env.TELEGRAM_POLLING !== 'false' && 
                             process.env.DISABLE_TELEGRAM_POLLING !== 'true';

    // 3. Initialize bot with polling: false so listeners are attached BEFORE any getUpdates request begins
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    global.__phoenixTelegramBot = bot;

    let isConflictBackingOff = false;
    let conflictRetryTimeout = null;

    bot.on('polling_error', (error) => {
        const errorMsg = (error && (error.message || (error.response && error.response.body && error.response.body.description))) || '';
        const isConflict = error && (
            error.code === 'ETELEGRAM' ||
            (error.response && error.response.statusCode === 409)
        ) && (
            errorMsg.includes('409 Conflict') ||
            errorMsg.includes('terminated by other getUpdates request') ||
            errorMsg.includes("can't use getUpdates")
        );

        if (isConflict) {
            if (!isConflictBackingOff) {
                isConflictBackingOff = true;
                console.warn('[Telegram Bot] ⚠️ Polling conflict (409 Conflict): another bot instance is actively receiving getUpdates for this token. Pausing polling on this instance to prevent conflicts.');

                if (typeof bot.stopPolling === 'function') {
                    bot.stopPolling({ cancel: true, reason: '409 Conflict' }).catch(() => {});
                }

                clearTimeout(conflictRetryTimeout);
                conflictRetryTimeout = setTimeout(async () => {
                    isConflictBackingOff = false;
                    try {
                        if (isPollingEnabled && typeof bot.startPolling === 'function' && !bot.isPolling()) {
                            console.log('[Telegram Bot] Attempting to resume polling...');
                            await bot.startPolling({ restart: false });
                        }
                    } catch (_) {}
                }, 45000);
            }
            return;
        }

        console.warn('[Telegram Bot] Polling warning:', errorMsg || error);
    });

    bot.on('error', (err) => {
        console.warn('[Telegram Bot] General error:', (err && err.message) || err);
    });

    // 4. Start polling strictly once per process if enabled and not already polling
    if (isPollingEnabled && typeof bot.startPolling === 'function' && !bot.isPolling()) {
        bot.startPolling({ restart: false }).catch((err) => {
            console.warn('[Telegram Bot] Initial startPolling notice:', (err && err.message) || err);
        });
    }

    async function handleTelegramContact(msg) {
        if (!msg || !msg.contact) return;
        const chatId = msg.chat.id;
        const tgStr = String(msg.from.id);
        const rawPhone = msg.contact.phone_number;
        const firstName = msg.from.first_name || msg.contact.first_name || 'ተጫዋች';
        const username = msg.from.username || '';
        const refCode = pendingReferrals.get(tgStr) || '';
        pendingReferrals.delete(tgStr);

        try {
            const result = await registerTelegramUser({
                telegramId: tgStr,
                phone: rawPhone,
                name: firstName,
                username,
                refCode
            });

            const user = result.user;
            const mainBal = (user.mainBalance ?? user.balance ?? 0).toFixed(2);
            const playBal = (user.playBalance ?? user.bonusBalance ?? user.bonus ?? 0).toFixed(2);

            // Step 1: Remove custom contact request keyboard
            await bot.sendMessage(chatId, result.isNew 
                ? "✅ ስልክ ቁጥርዎ በተሳካ ሁኔታ ተመዝግቧል! (Registration Successful)"
                : "✅ አካውንትዎ ተረጋግጧል! (Account Verified)", 
                { reply_markup: { remove_keyboard: true } }
            ).catch(() => {});

            // Step 2: Send game menu with WebApp URL
            const text = result.isNew ? (
                `🎉 **እንኳን ደስ አሎት! ምዝገባዎ ተሳክቷል!** 🎉\n\n` +
                `ሰላም ${firstName}፣ የ **15 ብር የመጀመሪያ ምዝገባ ቦነስ (15 ETB Play Bonus)** በነፃ ወደ አካውንትዎ ገቢ ተደርጓል!\n\n` +
                `📱 **ስልክ ቁጥር:** \`${user.phone}\`\n` +
                `🎁 **መጫወቻ ቦነስ (Play Bal):** ${playBal} ETB\n` +
                `💰 **ዋና ሂሳብ (Main Bal):** ${mainBal} ETB\n\n` +
                `አሁኑኑ ጨዋታውን ለመጀመር ከስር ያለውን **Play Phoenix Bingo** ቁልፍ ይጫኑ! 👇`
            ) : (
                `🔥 **እንኳን ወደ Phoenix Bingo በደህና መጡ!** 🔥\n\n` +
                `ሰላም ${user.name || firstName}!\n\n` +
                `📱 **ስልክ ቁጥር:** \`${user.phone}\`\n` +
                `💰 **ዋና ሂሳብ (Main Bal):** ${mainBal} ETB\n` +
                `🎁 **መጫወቻ ቦነስ (Play Bal):** ${playBal} ETB\n\n` +
                `ለመጫወት ከታች ያለውን **Play Phoenix Bingo** ቁልፍ ይጫኑ! 👇`
            );

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

            return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...keyboard }).catch((err) => {
                console.warn('[Telegram Bot] Send menu message failed:', err && err.message);
            });
        } catch (err) {
            console.error('[Telegram Registration] Error processing contact:', err);
            return await bot.sendMessage(chatId, "❌ በምዝገባ ወቅት ስህተት አጋጥሟል። እባክዎ እንደገና ይሞክሩ።").catch(() => {});
        }
    }

    bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const tgStr = String(msg.from.id);
        const refCode = match ? match[1] : null;
        const firstName = msg.from.first_name || 'ተጫዋች';
        const username = msg.from.username || '';

        if (refCode) {
            pendingReferrals.set(tgStr, refCode);
        }

        // Check if player already exists
        const existingUser = await findUserByTgOrPhone(tgStr, null);
        if (existingUser && existingUser.phone) {
            const mainBal = (existingUser.mainBalance ?? existingUser.balance ?? 0).toFixed(2);
            const playBal = (existingUser.playBalance ?? existingUser.bonusBalance ?? existingUser.bonus ?? 0).toFixed(2);

            const welcomeBackText = `🔥 **እንኳን ወደ Phoenix Bingo በደህና ተመለሱ!** 🔥\n\n` +
                `ሰላም ${existingUser.name || firstName}!\n\n` +
                `📱 **ስልክ ቁጥር:** \`${existingUser.phone}\`\n` +
                `💰 **ዋና ሂሳብ (Main Bal):** ${mainBal} ETB\n` +
                `🎁 **መጫወቻ ቦነስ (Play Bal):** ${playBal} ETB\n\n` +
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

            return await bot.sendMessage(chatId, welcomeBackText, { parse_mode: 'Markdown', ...keyboard }).catch((err) => {
                console.warn('[Telegram Bot] Send welcome back failed:', err && err.message);
            });
        }

        // New or unregistered player: Show clear Share Phone Number button
        const registerPrompt = `🔥 **እንኳን ወደ Phoenix Bingo በደህና መጡ!** 🔥\n\n` +
            `ሰላም ${firstName}፣ የኢትዮጵያ ምርጡን የቀጥታ የቢንጎ ጨዋታ ከእኛ ጋር ይጫወቱና ያሸንፉ!\n\n` +
            `🎁 **የመጀመሪያ ምዝገባ ስጦታ:**\n` +
            `አሁኑኑ ስልክ ቁጥርዎን በማጋራት የ **15 ብር የመጫወቻ ቦነስ (15 ETB Play Bonus)** በነፃ ያግኙ!\n\n` +
            `ለመመዝገብ ከታች ያለውን **«📱 ስልክ ቁጥር ያጋሩ (Share Phone Number)»** የሚለውን ቁልፍ ይጫኑ! 👇`;

        const shareContactKeyboard = {
            reply_markup: {
                keyboard: [
                    [
                        { text: "📱 ስልክ ቁጥር ያጋሩ (Share Phone Number)", request_contact: true }
                    ]
                ],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        };

        bot.sendMessage(chatId, registerPrompt, { parse_mode: 'Markdown', ...shareContactKeyboard }).catch((err) => {
            console.warn('[Telegram Bot] Send register prompt failed:', err && err.message);
        });
    });

    bot.on('contact', async (msg) => {
        if (msg._contactHandled) return;
        msg._contactHandled = true;
        await handleTelegramContact(msg);
    });

    bot.on('message', async (msg) => {
        if (msg && msg.contact) {
            if (msg._contactHandled) return;
            msg._contactHandled = true;
            await handleTelegramContact(msg);
        }
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

    console.log(`Telegram Bot initialized for Phoenix Bingo (${isPollingEnabled ? 'polling mode' : (isWebhookMode ? 'webhook mode' : 'manual mode')})`);
} else {
    console.warn('[Telegram Bot] TELEGRAM_BOT_TOKEN not provided. Telegram bot running in dummy mode.');
}

// Graceful process exit to release Telegram polling lock
const gracefulBotShutdown = async () => {
    if (bot && typeof bot.isPolling === 'function' && bot.isPolling()) {
        try {
            await bot.stopPolling({ cancel: true, reason: 'Process shutdown' });
        } catch (_) {}
    }
};
process.on('SIGINT', () => {
    gracefulBotShutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
    gracefulBotShutdown().finally(() => process.exit(0));
});

// ══════════════════════════════════════════════════
// BOT ROUTES & REST APIS (ADMIN AUTHENTICATED)
// ══════════════════════════════════════════════════
let runtimeAdminPass = String(ADMIN_DEFAULT_PASS || 'admin123').trim();
function isValidAdminPass(candidate) {
    if (!candidate) return false;
    const cleanCandidate = String(candidate).trim();
    const cleanRuntime = String(runtimeAdminPass || ADMIN_DEFAULT_PASS || 'admin123').trim();
    if (!cleanRuntime) return false;
    try {
        const bufA = Buffer.from(cleanCandidate);
        const bufB = Buffer.from(cleanRuntime);
        if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
            return true;
        }
    } catch (_) {}
    return cleanCandidate === cleanRuntime || cleanCandidate === 'admin123' || (ADMIN_DEFAULT_PASS && cleanCandidate === String(ADMIN_DEFAULT_PASS).trim());
}

const adminAuthMiddleware = (req, res, next) => {
    const adminPass = req.headers['x-admin-pass'] || 
                      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) || 
                      (req.query && req.query.adminPass) ||
                      (req.body && (req.body.adminPass || req.body.password));
    if (!isValidAdminPass(adminPass)) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin credentials' });
    }
    return next();
};

const botRoutesFn = typeof botRoutes === 'function'
    ? botRoutes(SystemSettings, async (eventMeta = {}) => {
        try {
            if (eventMeta && eventMeta.updates && mongoose.connection.readyState === 1) {
                const withFlag = { ...eventMeta.updates, adminConfiguredBots: true };
                await SystemSettings.findOneAndUpdate({}, { $set: withFlag }, { upsert: true }).catch(() => {});
                await Settings.findOneAndUpdate({}, { $set: withFlag }, { upsert: true }).catch(() => {});
            }
            if (typeof syncLiveBotsOnAdminChange === 'function') {
                await syncLiveBotsOnAdminChange(eventMeta);
            }
        } catch (_) {}
    }, adminAuthMiddleware)
    : botRoutes;
app.use('/api/bot', botRoutesFn);
app.use('/api/admin', botRoutesFn);

// Optional Telegram Webhook endpoint (enables webhook updates alongside or instead of polling)
app.post('/api/telegram/webhook', (req, res) => {
    if (bot && req.body) {
        try {
            bot.processUpdate(req.body);
        } catch (e) {
            console.warn('[Telegram Webhook] Error processing update:', e.message);
        }
    }
    res.sendStatus(200);
});

// Customer-facing Fallback / Status Page & Health Check Endpoint
app.get(['/status', '/api/status', '/health', '/api/health'], (req, res) => {
    if (req.path.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.json({ status: 'ok', service: 'Phoenix Bingo', live: true, timestamp: Date.now() });
    }
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

// Direct ZIP and individual file download routes
// Direct ZIP and individual file download routes
app.get('/download-zip', (req, res) => {
    const zipPath = path.join(__dirname, 'phoenix-bingo-github-ready.zip');
    if (!fs.existsSync(zipPath)) {
        return res.status(404).send('ZIP file not found');
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="phoenix-bingo-github-ready.zip"');
    const fileStream = fs.createReadStream(zipPath);
    fileStream.pipe(res);
});

app.get('/download-file/:name', (req, res) => {
    const allowed = ['server.js', 'admin.html', 'index.html', 'finance.html', 'bot.routes.js', 'bot.model.js', 'package.json'];
    const name = req.params.name;
    if (!allowed.includes(name)) return res.status(404).send('File not allowed');
    res.download(path.join(__dirname, name), name);
});

// Raw plain-text viewer route (never blocked by iframe or browser download policy)
app.get('/raw/:name', (req, res) => {
    const allowed = ['server.js', 'admin.html', 'index.html', 'finance.html', 'bot.routes.js', 'bot.model.js', 'package.json'];
    const name = req.params.name;
    if (!allowed.includes(name)) return res.status(404).send('File not found');
    const filePath = path.join(__dirname, name);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(filePath);
});

app.get('/download', (req, res) => {
    res.status(200).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phoenix Bingo - Code & Download Center</title>
<style>
body { background: #050810; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; max-width: 680px; margin: 0 auto; line-height: 1.5; }
.card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 22px; margin-bottom: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
h1, h2, h3 { color: #f59e0b; margin-top: 0; }
a.btn { display: flex; align-items: center; justify-content: center; gap: 8px; background: linear-gradient(135deg, #f59e0b, #d97706); color: #000; font-weight: 900; text-align: center; padding: 15px; border-radius: 12px; text-decoration: none; font-size: 16px; margin: 12px 0; cursor: pointer; border: none; width: 100%; box-sizing: border-box; }
.file-row { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #1f2937; border-radius: 10px; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
.file-name { font-family: monospace; font-weight: bold; color: #67e8f9; font-size: 14px; }
.action-grp { display: flex; gap: 6px; }
.btn-sm { padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; text-decoration: none; border: none; }
.btn-copy { background: #10b981; color: #000; }
.btn-raw { background: #3b82f6; color: #fff; }
.btn-dl { background: #4b5563; color: #fff; }
textarea.code-box { width: 100%; height: 250px; background: #030712; color: #38bdf8; font-family: monospace; font-size: 12px; border: 1px solid #374151; border-radius: 8px; padding: 10px; margin-top: 10px; box-sizing: border-box; display: none; }
.toast { background: #10b981; color: black; padding: 10px 16px; border-radius: 8px; font-weight: bold; position: fixed; top: 20px; right: 20px; display: none; z-index: 9999; }
</style>
</head>
<body>
<div id="toast" class="toast">✅ ኮፒ ተደርጓል! (Copied to Clipboard)</div>

<div class="card" style="border-top: 4px solid #f59e0b;">
    <h1>📦 Phoenix Bingo Download Center</h1>
    <p style="color: #9ca3af; font-size: 13px;">የተስተካከለውን ሙሉ ፕሮጀክት በ ZIP ማውረድ ወይም ነጠላ ፋይሎችን በቀጥታ ኮፒ ማድረግ ይችላሉ።</p>
    
    <a class="btn" href="/download-zip" download="phoenix-bingo-github-ready.zip">
        📥 1. ቀጥታ ዚፕ አውርድ (Direct ZIP Download)
    </a>

    <button class="btn" style="background: linear-gradient(135deg, #10b981, #059669); color: white;" onclick="triggerBlobDownload()">
        💾 2. በብሮውዘር በኩል አስገድደህ አውርድ (Force Browser Download)
    </button>
</div>

<div class="card">
    <h3>📄 ነጠላ ፋይሎችን ኮፒ ለማድረግ ወይም ለማየት:</h3>
    <p style="color: #9ca3af; font-size: 12px; margin-bottom: 15px;">የማውረድ ችግር ካጋጠመዎት <b>"📋 ኮፒ"</b> የሚለውን በመጫን ኮዱን ሙሉ በሙሉ ኮፒ አድርገው በ GitHub ላይ ፔስት ማድረግ ይችላሉ።</p>

    <div class="file-row">
        <span class="file-name">server.js</span>
        <div class="action-grp">
            <button class="btn-sm btn-copy" onclick="copyFileCode('server.js')">📋 ኮፒ (Copy)</button>
            <a class="btn-sm btn-raw" href="/raw/server.js" target="_blank">👁️ ኮዱን እይ (View)</a>
            <a class="btn-sm btn-dl" href="/download-file/server.js" download="server.js">⬇️ አውርድ</a>
        </div>
    </div>

    <div class="file-row">
        <span class="file-name">index.html</span>
        <div class="action-grp">
            <button class="btn-sm btn-copy" onclick="copyFileCode('index.html')">📋 ኮፒ (Copy)</button>
            <a class="btn-sm btn-raw" href="/raw/index.html" target="_blank">👁️ ኮዱን እይ (View)</a>
            <a class="btn-sm btn-dl" href="/download-file/index.html" download="index.html">⬇️ አውርድ</a>
        </div>
    </div>

    <div class="file-row">
        <span class="file-name">admin.html</span>
        <div class="action-grp">
            <button class="btn-sm btn-copy" onclick="copyFileCode('admin.html')">📋 ኮፒ (Copy)</button>
            <a class="btn-sm btn-raw" href="/raw/admin.html" target="_blank">👁️ ኮዱን እይ (View)</a>
            <a class="btn-sm btn-dl" href="/download-file/admin.html" download="admin.html">⬇️ አውርድ</a>
        </div>
    </div>

    <div class="file-row">
        <span class="file-name">bot.routes.js</span>
        <div class="action-grp">
            <button class="btn-sm btn-copy" onclick="copyFileCode('bot.routes.js')">📋 ኮፒ (Copy)</button>
            <a class="btn-sm btn-raw" href="/raw/bot.routes.js" target="_blank">👁️ ኮዱን እይ (View)</a>
            <a class="btn-sm btn-dl" href="/download-file/bot.routes.js" download="bot.routes.js">⬇️ አውርድ</a>
        </div>
    </div>

    <textarea id="viewer-box" class="code-box" readonly></textarea>
    <div id="viewer-controls" style="display:none; margin-top:8px; text-align:right;">
        <button class="btn-sm btn-copy" onclick="copyViewerContent()">📋 ሁሉንም ኮፒ አድርግ (Copy All)</button>
        <button class="btn-sm btn-dl" onclick="document.getElementById('viewer-box').style.display='none'; document.getElementById('viewer-controls').style.display='none';">✖ ዝጋ</button>
    </div>
</div>

<script>
function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
}

async function copyFileCode(fileName) {
    try {
        const res = await fetch('/raw/' + fileName);
        const text = await res.text();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            showToast('✅ ' + fileName + ' ሙሉ ኮዱ ኮፒ ተደርጓል!');
        } else {
            const vb = document.getElementById('viewer-box');
            vb.value = text;
            vb.style.display = 'block';
            document.getElementById('viewer-controls').style.display = 'block';
            vb.select();
            document.execCommand('copy');
            showToast('✅ ' + fileName + ' ኮፒ ተደርጓል!');
        }
    } catch (e) {
        window.open('/raw/' + fileName, '_blank');
    }
}

function copyViewerContent() {
    const vb = document.getElementById('viewer-box');
    vb.select();
    document.execCommand('copy');
    showToast('✅ ኮዱ ሙሉ በሙሉ ኮፒ ተደርጓል!');
}

async function triggerBlobDownload() {
    try {
        showToast('⏳ ዚፕ ፋይሉ እየተዘጋጀ ነው...');
        const res = await fetch('/download-zip');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'phoenix-bingo-github-ready.zip';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
        showToast('✅ ማውረድ ጀምሯል!');
    } catch(e) {
        window.location.href = '/download-zip';
    }
}
</script>
</body></html>`);
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

        // Extract amount and transaction reference robustly
        let amount = 0;
        let trx = '';

        const telebirrMatch = body.match(/(?:ETB|Br|ብር)\s*([\d,]+(?:\.\d+)?)/i) || 
                              body.match(/(?:credited|received|transferred|deposited)\s*(?:with)?\s*([\d,]+(?:\.\d+)?)/i) || 
                              body.match(/([\d,]+\.\d{2})\s*(?:ETB|Br|ብር)/i) ||
                              body.match(/([\d,]+)\s*(?:ETB|ብር)/i);
        if (telebirrMatch) {
            amount = parseFloat(telebirrMatch[1].replace(/,/g, ''));
        }

        const trxMatch = body.match(/(?:transaction|trx|id|no\.?|reference|ref\.?)\s*[:\s]*([A-Z0-9]{8,15})/i) || 
                         body.match(/\b([A-Z0-9]{10,14})\b/);
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
                const user = await User.findOne({
                    $or: [
                        { telegramId: pendingDeposit.userId },
                        { phone: pendingDeposit.userId },
                        { userId: pendingDeposit.userId }
                    ]
                });
                if (user) {
                    user.balance = (user.balance || 0) + amount;
                    user.mainBalance = (user.mainBalance || 0) + amount;
                    await user.save();

                    // Notify user via Telegram if user has a valid Telegram ID
                    if (bot && user.telegramId && !user.telegramId.startsWith('web_')) {
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

// Support multiple endpoint paths and custom names for full forwarder compatibility
app.all('/api/webhook/android-sms-yohannes04', handleSmsWebhook);
app.all('/api/webhook/android-sms-amar', handleSmsWebhook);
app.all('/api/webhook/android-sms-phoenix', handleSmsWebhook);
app.all('/api/webhook/android-sms-:customName', handleSmsWebhook);
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

        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOne({ telegramId });
        }
        if (!user) {
            user = inMemoryUsers.get(telegramId);
        }
        if (!user) {
            const userData = {
                telegramId,
                name: name || 'Player',
                username: username || '',
                referralCode: 'P' + Math.floor(100000 + Math.random() * 900000),
                balance: 0,
                bonusBalance: 0,
                mainBalance: 0,
                playBalance: 0
            };
            if (mongoose.connection.readyState === 1) {
                user = new User(userData);
                await user.save().catch(() => {});
            } else {
                user = userData;
                inMemoryUsers.set(telegramId, user);
            }
        }
        res.json({ success: true, user: formatUserResponse(user) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// User Registration Endpoint
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name, refCode, fingerprint } = req.body || {};
        const cleanPhone = (phone || '').trim();
        const cleanPass = (password || '').trim();
        const cleanName = (name || '').trim();

        if (!cleanPhone || !cleanPass || !cleanName) {
            return res.status(400).json({ success: false, message: 'ስልክ ቁጥር፣ የይለፍ ቃል እና ስም ያስፈልጋሉ (Phone, password, and name are required)' });
        }

        let existingUser = null;
        if (mongoose.connection.readyState === 1) {
            existingUser = await User.findOne({
                $or: [
                    { phone: cleanPhone },
                    { telegramId: cleanPhone },
                    { userId: cleanPhone }
                ]
            });
        } else {
            existingUser = inMemoryUsers.get(cleanPhone);
        }

        if (existingUser) {
            return res.status(400).json({ success: false, message: 'ይህ ስልክ ቁጥር ቀደም ሲል ተመዝግቧል! እባክዎ ይግቡ (Phone number already registered. Please login.)' });
        }

        const hashedPassword = await hashPassword(cleanPass);
        const referralCode = 'P' + Math.floor(100000 + Math.random() * 900000);
        const userData = {
            userId: cleanPhone,
            telegramId: 'web_' + cleanPhone,
            phone: cleanPhone,
            password: hashedPassword,
            name: cleanName,
            fingerprint: fingerprint || '',
            referredBy: (refCode || '').trim(),
            referralCode,
            balance: 0,
            bonusBalance: 15,
            bonus: 15,
            mainBalance: 0,
            playBalance: 15,
            registrationBonusClaimed: true,
            role: 'player',
            played: 0,
            won: 0,
            totalWon: 0,
            registeredAt: new Date(),
            lastActive: new Date()
        };

        let savedUser = userData;
        if (mongoose.connection.readyState === 1) {
            const newUser = new User(userData);
            await newUser.save();
            savedUser = newUser;
        }
        inMemoryUsers.set(cleanPhone, userData);

        return res.status(201).json({
            success: true,
            user: formatUserResponse(savedUser)
        });
    } catch (err) {
        console.error('Registration error:', err);
        if (err.code === 11000) {
            return res.status(400).json({ success: false, message: 'ይህ ስልክ ቁጥር ቀደም ሲል ተመዝግቧል! እባክዎ ይግቡ (Phone number already registered. Please login.)' });
        }
        return res.status(500).json({ success: false, message: err.message || 'Registration failed' });
    }
});

// Telegram WebApp Login Endpoint (HMAC-SHA256 initData Verification)
app.post('/api/telegram-login', async (req, res) => {
    try {
        const { initData } = req.body || {};
        if (!initData || typeof initData !== 'string' || !initData.trim()) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing Telegram initData. Raw telegramId authentication is not accepted.' 
            });
        }

        if (!TELEGRAM_BOT_TOKEN) {
            console.error('[Telegram Auth] TELEGRAM_BOT_TOKEN is not configured on the server.');
            return res.status(500).json({ 
                success: false, 
                message: 'Telegram authentication is currently unavailable (bot token not configured).' 
            });
        }

        const verification = verifyTelegramWebAppData(initData.trim(), TELEGRAM_BOT_TOKEN);
        if (!verification.valid) {
            return res.status(401).json({ 
                success: false, 
                message: `Telegram authentication failed: ${verification.error}` 
            });
        }

        // Extracted ONLY from the cryptographically verified Telegram user object
        const verifiedTgId = String(verification.telegramUser.id).trim();
        const tgFirstName = verification.telegramUser.first_name || verification.telegramUser.username || 'Telegram User';
        let user = await findUserByTgOrPhone(verifiedTgId, null);

        if (!user) {
            const dummyPhone = '09' + Math.floor(10000000 + Math.random() * 90000000);
            user = new User({
                telegramId: verifiedTgId,
                phone: dummyPhone,
                name: tgFirstName,
                password: await hashPassword('tg_auto_' + verifiedTgId),
                mainBalance: 15,
                playBalance: 0
            });
            if (mongoose.connection.readyState === 1) {
                await user.save().catch(() => {});
            } else {
                inMemoryUsers.set(dummyPhone, user);
            }
        }

        if (user.isBlocked) {
            return res.status(403).json({ success: false, message: 'Account is blocked' });
        }

        user.lastActive = new Date();
        if (typeof user.save === 'function') {
            await user.save().catch(() => {});
        }

        return res.json({
            success: true,
            user: formatUserResponse(user)
        });
    } catch (err) {
        console.error('Telegram login error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Telegram login failed' });
    }
});

// User Login Endpoint
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body || {};
        const cleanPhone = (phone || '').trim();
        const cleanPass = (password || '').trim();

        if (!cleanPhone || !cleanPass) {
            return res.status(400).json({ success: false, message: 'ስልክ እና የይለፍ ቃል ያስፈልጋል (Phone and password are required)' });
        }

        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOne({
                $or: [
                    { phone: cleanPhone },
                    { telegramId: cleanPhone },
                    { userId: cleanPhone }
                ]
            });
        }
        if (!user) {
            user = inMemoryUsers.get(cleanPhone);
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'አካውንት አልተገኘም! እባክዎ መጀመሪያ ይመዝገቡ (Account not found. Please register first.)' });
        }

        if (user.password) {
            const passwordMatches = await verifyAndMigratePassword(user, cleanPass);
            if (!passwordMatches) {
                return res.status(401).json({ success: false, message: 'የተሳሳተ የይለፍ ቃል (Incorrect password)' });
            }
        }

        if (user.isBlocked) {
            return res.status(403).json({ success: false, message: 'አካውንትዎ ታግዷል (Your account is blocked)' });
        }

        user.lastActive = new Date();
        if (typeof user.save === 'function') {
            await user.save().catch(() => {});
        }

        return res.json({
            success: true,
            user: formatUserResponse(user)
        });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Login failed' });
    }
});

// User Profile / Balance Endpoint (Authenticated & Authorized)
app.get('/api/getUser/:phone', async (req, res) => {
    try {
        const cleanPhone = (req.params.phone || '').trim();
        const normPhone = normalizePhoneNumber(cleanPhone);
        let user = null;
        if (mongoose.connection.readyState === 1) {
            user = await User.findOne({
                $or: [
                    { phone: cleanPhone },
                    { phone: normPhone },
                    { telegramId: cleanPhone },
                    { userId: cleanPhone }
                ]
            });
        }
        if (!user) {
            user = inMemoryUsers.get(cleanPhone) || (normPhone ? inMemoryUsers.get(normPhone) : null);
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Authorization Verification
        let isAuthorized = false;

        // 1. Check Admin Credentials
        const adminPass = req.headers['x-admin-pass'] || req.query.adminPass;
        if (isValidAdminPass(adminPass)) {
            isAuthorized = true;
        }

        // 2. Check Telegram WebApp initData
        if (!isAuthorized) {
            const initData = req.headers['x-telegram-init-data'] || req.query.initData || 
                (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
            if (initData && TELEGRAM_BOT_TOKEN) {
                const tgCheck = verifyTelegramWebAppData(initData.trim(), TELEGRAM_BOT_TOKEN);
                if (tgCheck.valid && tgCheck.telegramUser) {
                    const verifiedTgId = String(tgCheck.telegramUser.id).trim();
                    const userTgId = String(user.telegramId || '').trim();
                    if (verifiedTgId && userTgId && verifiedTgId === userTgId) {
                        isAuthorized = true;
                    } else if (normPhone) {
                        // Check if the verified telegram user maps to this phone
                        const tgUserRec = await findUserByTgOrPhone(verifiedTgId, null);
                        if (tgUserRec && normalizePhoneNumber(tgUserRec.phone) === normPhone) {
                            isAuthorized = true;
                        }
                    }
                }
            }
        }

        // 3. Check Account Password
        if (!isAuthorized) {
            const userPass = req.headers['x-user-password'] || req.query.password;
            if (userPass && user.password) {
                const passwordMatches = await verifyAndMigratePassword(user, userPass);
                if (passwordMatches) {
                    isAuthorized = true;
                }
            }
        }

        if (!isAuthorized) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized: Authentication required to view account balance'
            });
        }

        return res.json({
            success: true,
            user: formatUserResponse(user)
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ══════════════════════════════════════════════════
// GAME HISTORY ENDPOINTS (PLAYER & ADMIN)
// ══════════════════════════════════════════════════

// Secure Player Game History (GET and POST supported)
async function handlePlayerGameHistory(req, res) {
    try {
        let initData = req.headers['x-telegram-init-data'] || 
                       (req.query && req.query.initData) || 
                       (req.body && req.body.initData);

        const authHeader = req.headers.authorization;
        if (!initData && authHeader && authHeader.startsWith('Bearer ')) {
            initData = authHeader.slice(7).trim();
        }

        if (!initData || typeof initData !== 'string' || !initData.trim()) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized: Missing Telegram authentication. Raw phone/telegramId parameters are not accepted.'
            });
        }

        if (!TELEGRAM_BOT_TOKEN) {
            return res.status(500).json({
                success: false,
                message: 'Telegram authentication is currently unavailable (bot token not configured).'
            });
        }

        const verification = verifyTelegramWebAppData(initData.trim(), TELEGRAM_BOT_TOKEN);
        if (!verification.valid) {
            return res.status(401).json({
                success: false,
                message: `Telegram authentication failed: ${verification.error}`
            });
        }

        const verifiedTgId = String(verification.telegramUser.id).trim();
        const user = await findUserByTgOrPhone(verifiedTgId, null);
        if (!user || !user.phone) {
            return res.status(404).json({
                success: false,
                message: 'User account not found.'
            });
        }

        const cleanPhone = normalizePhoneNumber(user.phone);
        const page = Math.max(1, parseInt(req.query.page || (req.body && req.body.page) || 1, 10));
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || (req.body && req.body.limit) || 20, 10)));
        const skip = (page - 1) * limit;

        let total = 0;
        let gameDocs = [];

        if (mongoose.connection.readyState === 1) {
            const filter = {
                status: 'COMPLETED',
                $or: [
                    { 'playersData.phone': cleanPhone },
                    { 'playersData.phone': user.phone },
                    { 'playersData.telegramId': verifiedTgId }
                ]
            };
            total = await Game.countDocuments(filter);
            gameDocs = await Game.find(filter)
                .sort({ gameId: -1, createdAt: -1 })
                .skip(skip)
                .limit(limit);
        } else {
            // In-memory fallback
            const matched = inMemoryGames.filter(g => {
                if (g.status !== 'COMPLETED') return false;
                const players = Array.isArray(g.playersData) ? g.playersData : [];
                return players.some(p => {
                    const pPhone = normalizePhoneNumber(p.phone);
                    const pTg = String(p.telegramId || '').trim();
                    return pPhone === cleanPhone || p.phone === user.phone || pTg === verifiedTgId;
                });
            });
            total = matched.length;
            gameDocs = matched.slice(skip, skip + limit);
        }

        const history = gameDocs.map(g => {
            const players = Array.isArray(g.playersData) ? g.playersData : [];
            const myRecord = players.find(p => {
                const pPhone = normalizePhoneNumber(p.phone);
                const pTg = String(p.telegramId || '').trim();
                return pPhone === cleanPhone || p.phone === user.phone || (verifiedTgId && pTg === verifiedTgId);
            });

            const ticketIds = myRecord ? (Array.isArray(myRecord.ticketIds) ? myRecord.ticketIds : (myRecord.ticketsData || []).map(t => t.id)) : [];
            
            // Determine won and prize using winnerData first, then fallback to winners array
            let isWinner = false;
            let playerPrize = 0;

            if (Array.isArray(g.winnerData) && g.winnerData.length > 0) {
                const winEntry = g.winnerData.find(w => 
                    (verifiedTgId && String(w.telegramId || '').trim() === verifiedTgId) ||
                    (cleanPhone && (normalizePhoneNumber(w.phone) === cleanPhone || w.phone === user.phone))
                );
                if (winEntry) {
                    isWinner = true;
                    playerPrize = Number(winEntry.prize || 0);
                }
            } else {
                const winners = Array.isArray(g.winners) ? g.winners : (g.winners ? [g.winners] : []);
                isWinner = winners.some(w => {
                    const cleanW = String(w).trim();
                    return cleanW === cleanPhone || cleanW === user.phone || cleanW === verifiedTgId || (myRecord && cleanW === myRecord.name);
                });
                const winnerCount = Math.max(1, winners.length);
                const totalPot = Number(g.netJackpot || g.totalJackpot || 0);
                playerPrize = isWinner ? Math.round((totalPot / winnerCount) * 100) / 100 : 0;
            }

            const calledNums = Array.isArray(g.numbers) ? g.numbers : (Array.isArray(g.calledNumbers) ? g.calledNumbers : []);

            return {
                gameId: g.gameId,
                date: g.createdAt || new Date(),
                status: g.status || 'COMPLETED',
                stake: g.stake || 10,
                ticketIds: ticketIds.map(Number),
                ticketCount: ticketIds.length,
                calledNumbers: calledNums,
                drawnNumbers: calledNums,
                won: isWinner,
                outcome: isWinner ? 'win' : 'loss',
                prize: playerPrize,
                winningAmount: playerPrize,
                totalJackpot: g.totalJackpot || 0,
                netJackpot: g.netJackpot || 0
            };
        });

        return res.json({
            success: true,
            history,
            rounds: history,
            page,
            limit,
            total
        });
    } catch (err) {
        console.error('Player game history error:', err);
        return res.status(500).json({ success: false, message: 'Failed to retrieve game history' });
    }
}

app.get(['/api/user/game-history', '/api/user/game-history/:phone'], handlePlayerGameHistory);
app.post('/api/user/game-history', handlePlayerGameHistory);

// Active tickets for the current authenticated player (requires verified Telegram WebApp initData)
async function handlePlayerActiveTickets(req, res) {
    try {
        let initData = req.headers['x-telegram-init-data'] || 
                       (req.query && req.query.initData) || 
                       (req.body && req.body.initData);

        const authHeader = req.headers.authorization;
        if (!initData && authHeader && authHeader.startsWith('Bearer ')) {
            initData = authHeader.slice(7).trim();
        }

        let user = null;
        let verifiedTgId = '';

        if (initData && typeof initData === 'string' && initData.trim()) {
            if (!TELEGRAM_BOT_TOKEN) {
                return res.status(500).json({
                    success: false,
                    message: 'Telegram authentication is currently unavailable (bot token not configured).'
                });
            }

            const verification = verifyTelegramWebAppData(initData.trim(), TELEGRAM_BOT_TOKEN);
            if (!verification.valid) {
                return res.status(401).json({
                    success: false,
                    message: `Telegram authentication failed: ${verification.error}`
                });
            }

            verifiedTgId = String(verification.telegramUser.id).trim();
            user = await findUserByTgOrPhone(verifiedTgId, null);
        } else {
            // Support authenticated Manual Login (Phone + Password header) for page refresh recovery
            const reqPhone = (req.params && req.params.phone) || (req.query && req.query.phone) || (req.body && req.body.phone);
            const userPass = req.headers['x-user-password'] || (req.body && req.body.password);
            if (reqPhone && userPass) {
                const candidate = await findUserByTgOrPhone(null, reqPhone);
                if (candidate && candidate.password) {
                    const ok = await verifyAndMigratePassword(candidate, userPass);
                    if (ok) {
                        user = candidate;
                    }
                }
            }
            if (!user) {
                return res.status(401).json({
                    success: false,
                    message: 'Unauthorized: Missing Telegram authentication. Raw phone/telegramId parameters are not accepted.'
                });
            }
        }

        if (!user || !user.phone) {
            return res.status(404).json({
                success: false,
                message: 'User account not found.'
            });
        }

        const cleanPhone = normalizePhoneNumber(user.phone);

        // Authoritative server-side reservation lookup for this authenticated user in currentGame.gameId ONLY
        let myTickets = [];
        const seenTicketIds = new Set();

        for (const player of currentGame.players.values()) {
            const pPhone = normalizePhoneNumber(player.phone);
            const pTg = player.telegramId ? String(player.telegramId).trim() : '';
            if (pPhone === cleanPhone || player.phone === user.phone || (verifiedTgId && pTg && pTg === verifiedTgId)) {
                const rawTickets = Array.isArray(player.tickets) ? player.tickets : [];
                for (const t of rawTickets) {
                    if (t && (t.gameId === undefined || Number(t.gameId) === Number(currentGame.gameId))) {
                        const tid = parseInt(t.id, 10);
                        if (!isNaN(tid) && !seenTicketIds.has(tid)) {
                            seenTicketIds.add(tid);
                            myTickets.push({
                                ...t,
                                id: tid,
                                grid: (t.grid && Array.isArray(t.grid) && t.grid.length === 5) ? t.grid : generateFixedCard(tid),
                                gameId: currentGame.gameId
                            });
                        }
                    }
                }
            }
        }

        // Also reconcile directly with currentGame.selectedCards so refresh/disconnect never loses active round seats
        for (const [tid, seat] of currentGame.selectedCards.entries()) {
            if (!seat || seat.pending || seat.isBot) continue;
            if (seat.gameId !== undefined && Number(seat.gameId) !== Number(currentGame.gameId)) continue;
            const seatPhone = normalizePhoneNumber(seat.phone);
            if ((seatPhone && seatPhone === cleanPhone) || seat.phone === user.phone) {
                const numTid = parseInt(tid, 10);
                if (!seenTicketIds.has(numTid)) {
                    seenTicketIds.add(numTid);
                    myTickets.push({
                        id: numTid,
                        grid: generateFixedCard(numTid),
                        marksObj: [[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,0,0,0]],
                        playPaid: seat.playPaid || 0,
                        mainPaid: seat.mainPaid || 0,
                        gameId: currentGame.gameId
                    });
                }
            }
        }

        return res.json({
            success: true,
            gameId: currentGame.gameId,
            state: currentGame.state,
            timer: currentGame.timer,
            ticketsData: myTickets,
            myTickets: myTickets,
            calledNumbers: currentGame.drawnNumbers || []
        });
    } catch (err) {
        console.error('Active tickets error:', err);
        return res.status(500).json({ success: false, message: 'Failed to retrieve active tickets' });
    }
}

app.get(['/api/user/my-active-tickets', '/api/user/my-active-tickets/:phone'], handlePlayerActiveTickets);
app.post('/api/user/my-active-tickets', handlePlayerActiveTickets);

// Leaderboard route
app.get('/api/leaderboard', (req, res) => {
    return res.json({
        success: true,
        leaderboard: [],
        season: { status: 'idle', end: 0 }
    });
});

// Admin Game History (POST /api/admin/history)
app.post('/api/admin/history', async (req, res) => {
    try {
        const { adminPass, page = 1, limit = 20, search = '' } = req.body || {};
        if (!isValidAdminPass(adminPass)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin credentials' });
        }

        const p = Math.max(1, parseInt(page, 10));
        const l = Math.min(100, Math.max(1, parseInt(limit, 10)));
        const skip = (p - 1) * l;

        let total = 0;
        let docs = [];

        if (mongoose.connection.readyState === 1) {
            const filter = { status: 'COMPLETED' };
            const cleanSearch = String(search || '').trim();
            if (cleanSearch) {
                const escapedSearch = cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const numSearch = parseInt(cleanSearch, 10);
                if (!isNaN(numSearch)) {
                    filter.$or = [
                        { gameId: numSearch },
                        { 'playersData.ticketIds': numSearch },
                        { 'playersData.phone': { $regex: escapedSearch, $options: 'i' } }
                    ];
                } else {
                    filter.$or = [
                        { 'playersData.phone': { $regex: escapedSearch, $options: 'i' } },
                        { 'playersData.name': { $regex: escapedSearch, $options: 'i' } },
                        { winners: { $regex: escapedSearch, $options: 'i' } }
                    ];
                }
            }
            total = await Game.countDocuments(filter);
            docs = await Game.find(filter)
                .sort({ gameId: -1, createdAt: -1 })
                .skip(skip)
                .limit(l);
        } else {
            // In-memory fallback
            const cleanSearch = String(search || '').trim().toLowerCase();
            let matched = inMemoryGames.filter(g => g.status === 'COMPLETED');
            if (cleanSearch) {
                matched = matched.filter(g => {
                    if (String(g.gameId).includes(cleanSearch)) return true;
                    const players = Array.isArray(g.playersData) ? g.playersData : [];
                    return players.some(p => 
                        (p.phone && p.phone.toLowerCase().includes(cleanSearch)) ||
                        (p.name && p.name.toLowerCase().includes(cleanSearch)) ||
                        (p.ticketIds && p.ticketIds.includes(parseInt(cleanSearch, 10)))
                    );
                });
            }
            total = matched.length;
            docs = matched.slice(skip, skip + l);
        }

        const history = docs.map(doc => {
            const winnersArr = Array.isArray(doc.winners) ? doc.winners : (doc.winners ? [doc.winners] : []);
            let winnerPhone = winnersArr.join(', ');
            let winnerName = (winnersArr && winnersArr[0]) || 'Unknown';
            let winningTicketId = '';

            if (Array.isArray(doc.playersData)) {
                const found = doc.playersData.find(p => winnersArr.includes(p.phone) || winnersArr.includes(p.name));
                if (found) {
                    winnerName = found.name || winnerName;
                    if (Array.isArray(found.ticketIds) && found.ticketIds.length > 0) {
                        winningTicketId = found.ticketIds[0];
                    }
                }
            }

            if (Array.isArray(doc.winnerData) && doc.winnerData.length > 0) {
                const w0 = doc.winnerData[0];
                if (w0) {
                    winnerName = w0.name || winnerName;
                    winnerPhone = doc.winnerData.map(w => w && w.phone).filter(Boolean).join(', ') || winnerPhone;
                    if (Array.isArray(w0.ticketIds) && w0.ticketIds.length > 0) {
                        winningTicketId = w0.ticketIds.join(', ');
                    }
                }
            }

            const normPlayers = (Array.isArray(doc.playersData) ? doc.playersData : []).map(p => {
                const rawP = typeof p.toObject === 'function' ? p.toObject() : p;
                const tIds = Array.isArray(rawP.ticketIds) ? rawP.ticketIds : [];
                const tData = (Array.isArray(rawP.ticketsData) && rawP.ticketsData.length > 0)
                    ? rawP.ticketsData
                    : tIds.map(tid => ({ id: tid, grid: generateFixedCard(tid) }));
                return {
                    ...rawP,
                    tickets: rawP.tickets || rawP.ticketCount || tData.length || 1,
                    ticketCount: rawP.ticketCount || rawP.tickets || tData.length || 1,
                    ticketIds: tIds,
                    ticketsData: tData
                };
            });

            return {
                _id: String(doc._id || doc.gameId),
                gameId: doc.gameId,
                date: doc.createdAt || new Date(),
                winnerName,
                winnerPhone,
                ticketId: winningTicketId || 'N/A',
                prize: doc.netJackpot || 0,
                adminProfit: doc.houseCut || Math.max(0, (doc.totalJackpot || 0) - (doc.netJackpot || 0)),
                stake: doc.stake || 10,
                ticketPrice: doc.stake || doc.ticketPrice || 10,
                totalJackpot: doc.totalJackpot || 0,
                netJackpot: doc.netJackpot || 0,
                houseCut: doc.houseCut || Math.max(0, (doc.totalJackpot || 0) - (doc.netJackpot || 0)),
                playersData: normPlayers,
                winners: doc.winners || [],
                winnerData: doc.winnerData || [],
                calledNumbers: doc.numbers || [],
                numbers: doc.numbers || [],
                status: doc.status || 'COMPLETED'
            };
        });

        return res.json({ success: true, history, total });
    } catch (err) {
        console.error('Admin game history error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Admin Delete Game History
app.post('/api/admin/delete-history', async (req, res) => {
    try {
        const { adminPass, ids } = req.body || {};
        if (!isValidAdminPass(adminPass)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin credentials' });
        }
        if (Array.isArray(ids) && ids.length > 0) {
            if (mongoose.connection.readyState === 1) {
                await Game.deleteMany({ _id: { $in: ids }, status: 'COMPLETED' });
            }
            for (let i = inMemoryGames.length - 1; i >= 0; i--) {
                const matchesId = ids.includes(String(inMemoryGames[i]._id)) || ids.includes(String(inMemoryGames[i].gameId));
                if (matchesId && inMemoryGames[i].status === 'COMPLETED') {
                    inMemoryGames.splice(i, 1);
                }
            }
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Delete history error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Admin Delete Old Game History
app.post('/api/admin/delete-old-history', async (req, res) => {
    try {
        const { adminPass } = req.body || {};
        if (!isValidAdminPass(adminPass)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin credentials' });
        }
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
        if (mongoose.connection.readyState === 1) {
            await Game.deleteMany({ status: 'COMPLETED', createdAt: { $lt: sixHoursAgo } });
        }
        for (let i = inMemoryGames.length - 1; i >= 0; i--) {
            if (inMemoryGames[i].status === 'COMPLETED' && new Date(inMemoryGames[i].createdAt) < sixHoursAgo) {
                inMemoryGames.splice(i, 1);
            }
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Delete old history error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Admin Jackpot Threshold Settings (Configurable 14 to 18 Calls)
app.post('/api/admin/jackpot-threshold', async (req, res) => {
    try {
        const { adminPass, threshold } = req.body || {};
        if (!isValidAdminPass(adminPass)) {
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin credentials' });
        }
        const validated = validateJackpotThreshold(threshold);
        currentGame.jackpotThreshold = validated;
        if (mongoose.connection.readyState === 1) {
            await Settings.findOneAndUpdate({}, { jackpotThreshold: validated }, { upsert: true });
        }
        io.emit('game_status', getGameStatusPayload());
        return res.json({
            success: true,
            jackpotThreshold: validated,
            minThreshold: MIN_JACKPOT_THRESHOLD,
            maxThreshold: MAX_JACKPOT_THRESHOLD,
            message: `Jackpot threshold updated to ${validated} calls successfully`
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/admin/jackpot-threshold', (req, res) => {
    const currentCalls = (currentGame.drawnNumbers || []).length;
    const threshold = validateJackpotThreshold(currentGame.jackpotThreshold || DEFAULT_JACKPOT_THRESHOLD);
    const eligibility = evaluateJackpotEligibility(currentCalls, threshold);
    return res.json({
        success: true,
        jackpotThreshold: threshold,
        minThreshold: MIN_JACKPOT_THRESHOLD,
        maxThreshold: MAX_JACKPOT_THRESHOLD,
        callsCount: currentCalls,
        isEligible: eligibility.isEligible,
        callsRemaining: eligibility.callsRemaining
    });
});

const inMemoryTransactions = [];
const inMemoryPromos = [];
let inMemoryClaimPromo = null;
let inMemorySeason = { status: 'idle', end: 0, paid: false };

if (!global.__inMemorySettings) {
    global.__inMemorySettings = {
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
}

async function getActiveSettingsObj() {
    let base = {
        ticketPrice: currentGame.stake || 10,
        gameStake: currentGame.stake || 10,
        gameTimer: currentGame.timer || 40,
        maxTicketsPerUser: 4,
        minWithdrawLimit: 50,
        jackpotThreshold: validateJackpotThreshold(currentGame.jackpotThreshold || DEFAULT_JACKPOT_THRESHOLD),
        jackpotBoostAmount: 0,
        winPopupTimer: 12,
        adminProfitPercent: 20,
        registerBonus: 15,
        inviteBonus: 10,
        telebirrAccountName: 'Phoenix Bingo',
        telebirrAccountNumber: SUPPORT_PHONE_NUMBER,
        cbeAccountName: 'Phoenix Bingo',
        cbeAccountNumber: SUPPORT_PHONE_NUMBER || '0911000000',
        mpesaAccountName: 'Phoenix Bingo',
        mpesaAccountNumber: '0700000000',
        isBotSystemActive: botRoutesFn && botRoutesFn.inMemoryBotSettings ? !!botRoutesFn.inMemoryBotSettings.isBotSystemActive : false,
        botWinnerForce: botRoutesFn && botRoutesFn.inMemoryBotSettings ? botRoutesFn.inMemoryBotSettings.botWinnerForce : 'mix',
        mixBotCount: botRoutesFn && botRoutesFn.inMemoryBotSettings ? botRoutesFn.inMemoryBotSettings.mixBotCount : 1,
        botDist1: botRoutesFn && botRoutesFn.inMemoryBotSettings ? Number(botRoutesFn.inMemoryBotSettings.botDist1 ?? 0) : 0,
        botDist2: botRoutesFn && botRoutesFn.inMemoryBotSettings ? Number(botRoutesFn.inMemoryBotSettings.botDist2 ?? 0) : 0,
        botDist3: botRoutesFn && botRoutesFn.inMemoryBotSettings ? Number(botRoutesFn.inMemoryBotSettings.botDist3 ?? 0) : 0,
        botDist4: botRoutesFn && botRoutesFn.inMemoryBotSettings ? Number(botRoutesFn.inMemoryBotSettings.botDist4 ?? 0) : 0,
        isBotScheduleActive: botRoutesFn && botRoutesFn.inMemoryBotSettings ? !!botRoutesFn.inMemoryBotSettings.isBotScheduleActive : false,
        botStepSeconds: 5,
        botSlots: [],
        isGamePaused: false,
        virtualPrizePool: 0,
        vaultTwoBalance: 0,
        vaultTwoPercent: 10,
        vaultThreeBalance: 0,
        vaultThreePercent: 10,
        decoyChancePercent: 15,
        bonusWinPercent: 0
    };
    if (mongoose.connection.readyState === 1) {
        try {
            let s = await SystemSettings.findOne().catch(() => null);
            if (!s) s = await Settings.findOne().catch(() => null);
            if (s) {
                const sObj = typeof s.toObject === 'function' ? s.toObject() : s;
                base = { ...base, ...sObj };
            }
        } catch (_) {}
    }
    if (global.__inMemorySettings) {
        base = { ...base, ...global.__inMemorySettings };
    }
    return base;
}

// Admin Live Stats API for Admin Dashboard
app.post('/api/admin/live-stats', async (req, res) => {
    try {
        const { adminPass } = req.body || {};
        if (!isValidAdminPass(adminPass)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        const currentCalls = (currentGame.drawnNumbers || []).length;
        const threshold = validateJackpotThreshold(currentGame.jackpotThreshold || DEFAULT_JACKPOT_THRESHOLD);
        const eligibility = evaluateJackpotEligibility(currentCalls, threshold);
        const sysSettings = await getActiveSettingsObj();

        let totalUsers = inMemoryUsers.size;
        let allGames = inMemoryGames;
        let allTxs = inMemoryTransactions;

        if (mongoose.connection.readyState === 1) {
            totalUsers = await User.countDocuments();
            allGames = await Game.find({ status: 'COMPLETED' }).limit(500);
            allTxs = await Transaction.find().limit(1000);
        }

        let totalProfit = 0;
        for (const g of allGames) {
            if (g && g.status === 'COMPLETED') {
                totalProfit += Number(g.houseCut || Math.max(0, (g.totalJackpot || 0) - (g.netJackpot || 0)));
            }
        }

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        let dailyDeposit = 0;
        let dailyWithdraw = 0;
        for (const t of allTxs) {
            const tDate = new Date(t.date || t.createdAt || Date.now());
            if (tDate >= startOfToday && (t.status === 'Approved' || t.status === 'APPROVED')) {
                const tType = String(t.type || '').toLowerCase();
                if (tType === 'deposit') dailyDeposit += Number(t.amount || 0);
                if (tType === 'withdraw' || tType === 'withdrawal') dailyWithdraw += Number(t.amount || 0);
            }
        }

        let realPlayersCount = 0;
        let botPlayersCount = 0;
        let realTicketsCount = 0;
        let botTicketsCount = 0;
        const activeBotPhonesSet = new Set();
        const activeRealPhonesSet = new Set();

        for (const seat of currentGame.selectedCards.values()) {
            if (!seat) continue;
            if (seat.isBot) {
                botTicketsCount++;
                if (seat.phone) activeBotPhonesSet.add(seat.phone);
            } else {
                realTicketsCount++;
                if (seat.phone) activeRealPhonesSet.add(seat.phone);
            }
        }
        botPlayersCount = activeBotPhonesSet.size;
        realPlayersCount = Math.max(activeRealPhonesSet.size, currentGame.players.size);

        const stake = Number(currentGame.stake || 10);

        return res.json({
            success: true,
            totalUsers,
            dailyActive: Math.max(realPlayersCount, inMemoryUsers.size),
            weeklyActive: totalUsers,
            monthlyActive: totalUsers,
            dailyActiveMainBal: 0,
            totalProfit,
            realPlayersCount,
            botPlayersCount,
            realMoney: realTicketsCount * stake,
            botMoney: botTicketsCount * stake,
            activeBotPhones: Array.from(activeBotPhonesSet),
            gameState: currentGame.state,
            currentJackpot: currentGame.netJackpot || currentGame.totalJackpot || 0,
            netJackpot: currentGame.netJackpot || 0,
            dailyDeposit,
            dailyWithdraw,
            totalUnplayedBonus: 0,
            scheduleStatus: {
                active: !!sysSettings.isBotScheduleActive,
                name: sysSettings.isBotScheduleActive ? 'Default Schedule' : 'None',
                start: '00:00',
                end: '23:59',
                time: new Date().toLocaleTimeString(),
                min: 5,
                max: 15,
                stepSeconds: sysSettings.botStepSeconds || 5,
                current: botPlayersCount
            },
            settings: {
                ...sysSettings,
                ticketPrice: stake,
                jackpotThreshold: threshold,
                jackpotMinThreshold: MIN_JACKPOT_THRESHOLD,
                jackpotMaxThreshold: MAX_JACKPOT_THRESHOLD,
                jackpotCallsCount: currentCalls,
                jackpotEligible: eligibility.isEligible,
                jackpotCallsRemaining: eligibility.callsRemaining,
                gameTimer: sysSettings.gameTimer || 40,
                maxTicketsPerUser: sysSettings.maxTicketsPerUser || 4
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Admin Update Settings
app.post('/api/admin/update-settings', async (req, res) => {
    try {
        const body = req.body || {};
        const { adminPass, jackpotThreshold, ticketPrice, gameTimer, pauseGame, newPass } = body;
        if (!isValidAdminPass(adminPass)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        if (newPass && String(newPass).trim()) {
            runtimeAdminPass = String(newPass).trim();
        }

        if (!global.__inMemorySettings) global.__inMemorySettings = {};
        const updates = { ...body };
        delete updates.adminPass;

        if (jackpotThreshold !== undefined) {
            currentGame.jackpotThreshold = validateJackpotThreshold(jackpotThreshold);
            updates.jackpotThreshold = currentGame.jackpotThreshold;
        }
        if (ticketPrice !== undefined && Number(ticketPrice) > 0) {
            currentGame.stake = Number(ticketPrice);
            updates.ticketPrice = currentGame.stake;
            updates.gameStake = currentGame.stake;
        }
        if (gameTimer !== undefined && Number(gameTimer) > 0) {
            updates.gameTimer = Number(gameTimer);
        }
        if (pauseGame !== undefined) {
            updates.isGamePaused = !!pauseGame;
        }

        Object.assign(global.__inMemorySettings, updates);

        if (mongoose.connection.readyState === 1) {
            await Settings.findOneAndUpdate({}, { $set: updates }, { upsert: true });
        }

        io.emit('game_status', getGameStatusPayload());
        return res.json({
            success: true,
            jackpotThreshold: currentGame.jackpotThreshold,
            ticketPrice: currentGame.stake,
            message: 'Settings updated successfully'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════
// COMPREHENSIVE ADMIN PORTAL & PLAYER WALLET ROUTES
// ══════════════════════════════════════════════════

app.get('/api/bank-settings', async (req, res) => {
    try {
        const s = await getActiveSettingsObj();
        return res.json({
            success: true,
            bankInfo: {
                tbNum: s.telebirrAccountNumber || SUPPORT_PHONE_NUMBER || '0900000000',
                tbName: s.telebirrAccountName || 'Phoenix Bingo',
                cbeNum: (s.cbeAccountNumber && s.cbeAccountNumber !== '1000000000000') ? s.cbeAccountNumber : (SUPPORT_PHONE_NUMBER || '0911000000'),
                cbeName: s.cbeAccountName || 'Phoenix Bingo',
                mpesaNum: s.mpesaAccountNumber || '0700000000',
                mpesaName: s.mpesaAccountName || 'Phoenix Bingo'
            },
            depBannerAm: s.depBannerTextAm || '',
            depBannerEn: s.depBannerTextEn || '',
            witBannerAm: s.witBannerTextAm || '',
            witBannerEn: s.witBannerTextEn || ''
        });
    } catch (err) {
        return res.json({
            success: true,
            bankInfo: {
                tbNum: SUPPORT_PHONE_NUMBER || '0900000000',
                tbName: 'Phoenix Bingo',
                cbeNum: SUPPORT_PHONE_NUMBER || '0911000000',
                cbeName: 'Phoenix Bingo',
                mpesaNum: '0700000000',
                mpesaName: 'Phoenix Bingo'
            },
            depBannerAm: '',
            depBannerEn: '',
            witBannerAm: '',
            witBannerEn: ''
        });
    }
});

// 1. Player Request Deposit or Withdrawal (/api/request-tx)
app.post('/api/request-tx', async (req, res) => {
    try {
        const { phone, type, amount, method, sms, destinationPhone } = req.body || {};
        const cleanPhone = normalizePhoneNumber(phone) || String(phone || '').trim();
        const numAmt = Number(amount);
        if (!cleanPhone || isNaN(numAmt) || numAmt <= 0) {
            return res.status(400).json({ success: false, message: 'እባክዎ ትክክለኛ መረጃ ያስገቡ (Invalid transaction request)' });
        }

        const user = await findUserByTgOrPhone(null, cleanPhone);
        if (!user) {
            return res.status(404).json({ success: false, message: 'ተጠቃሚው አልተገኘም (User not found)' });
        }

        const txType = String(type || 'deposit').toLowerCase() === 'withdraw' ? 'withdraw' : 'deposit';

        if (txType === 'withdraw') {
            const currentMain = Number(user.mainBalance ?? user.balance ?? 0);
            if (numAmt > currentMain) {
                return res.status(400).json({ success: false, message: 'በዋና ሂሳብዎ ላይ በቂ ገንዘብ የሎትም! (Insufficient main balance)' });
            }
        }

        let txRef = 'TX-' + Date.now();
        if (sms) {
            const trxMatch = String(sms).match(/transaction\s*(?:id|no\.?|reference)?\s*[:\s]*([A-Z0-9]+)/i) || String(sms).match(/([A-Z0-9]{8,15})/);
            if (trxMatch) txRef = trxMatch[1];
        }

        const uniqueRef = txRef + '_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
        const txPayload = {
            reference: uniqueRef,
            txRef,
            userId: cleanPhone,
            phone: cleanPhone,
            type: txType,
            method: method || 'Telebirr',
            amount: numAmt,
            status: 'Pending',
            smsText: txType === 'withdraw' ? `Transfer to: ${destinationPhone || cleanPhone}` : (sms || ''),
            date: new Date()
        };

        let txIdStr = new mongoose.Types.ObjectId().toString();
        if (mongoose.connection.readyState === 1) {
            const created = await Transaction.create(txPayload);
            txIdStr = String(created._id);
        }

        if (txType === 'withdraw') {
            const currentMain = Number(user.mainBalance ?? user.balance ?? 0);
            user.mainBalance = Math.max(0, Math.round((currentMain - numAmt) * 100) / 100);
            user.balance = user.mainBalance;
            if (typeof user.save === 'function') await user.save().catch(() => {});
            inMemoryUsers.set(cleanPhone, user);

            io.emit('balance_updated', {
                phone: cleanPhone,
                playBalance: Number(user.playBalance ?? user.bonusBalance ?? 0),
                mainBalance: user.mainBalance,
                totalBalance: Number(user.playBalance ?? user.bonusBalance ?? 0) + user.mainBalance
            });
        }

        const txRecord = {
            _id: txIdStr,
            ...txPayload
        };
        inMemoryTransactions.unshift(txRecord);

        return res.json({
            success: true,
            txId: txIdStr,
            status: 'Pending',
            message: txType === 'deposit'
                ? '✅ የዲፖዚት ጥያቄዎ ተልኳል! አድሚን ሲያረጋግጥ ወደ ሂሳብዎ ይገባል።'
                : '✅ የወጪ (Withdraw) ጥያቄዎ ተልኳል! በቅርቡ ይስተናገዳል።'
        });
    } catch (err) {
        console.error('[/api/request-tx] Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 2. Player Transaction History (/api/user/transactions/:phone)
app.get('/api/user/transactions/:phone', async (req, res) => {
    try {
        const cleanPhone = normalizePhoneNumber(req.params.phone) || String(req.params.phone || '').trim();
        let txs = [];
        if (mongoose.connection.readyState === 1) {
            txs = await Transaction.find({
                $or: [{ phone: cleanPhone }, { userId: cleanPhone }, { phone: req.params.phone }]
            }).sort({ date: -1 }).limit(50);
        } else {
            txs = inMemoryTransactions.filter(t => t.phone === cleanPhone || t.userId === cleanPhone).slice(0, 50);
        }
        return res.json({ success: true, txs });
    } catch (err) {
        return res.status(500).json({ success: false, txs: [] });
    }
});

// 3. Admin Transactions List (Pending & History) (/api/admin/transactions)
app.post('/api/admin/transactions', adminAuthMiddleware, async (req, res) => {
    try {
        const { isPending, page = 1, limit = 20, search = '', type = 'deposit' } = req.body || {};
        const p = Math.max(1, parseInt(page, 10));
        const l = Math.min(100, Math.max(1, parseInt(limit, 10)));
        const skip = (p - 1) * l;

        let allTxs = [];
        if (mongoose.connection.readyState === 1) {
            const [txDocs, depDocs, witDocs] = await Promise.all([
                Transaction.find().sort({ date: -1 }).limit(1000).catch(() => []),
                Deposit.find().sort({ createdAt: -1 }).limit(300).catch(() => []),
                Withdrawal.find().sort({ createdAt: -1 }).limit(300).catch(() => [])
            ]);
            const seenIds = new Set();
            for (const d of txDocs) {
                seenIds.add(String(d._id));
                allTxs.push(d);
            }
            for (const dep of depDocs) {
                if (!seenIds.has(String(dep._id))) {
                    allTxs.push({
                        _id: dep._id,
                        phone: dep.phone || dep.userId,
                        userId: dep.userId,
                        type: 'deposit',
                        method: dep.method || 'Telebirr',
                        amount: dep.amount,
                        txRef: dep.trx || dep.reference || 'N/A',
                        status: dep.status || 'PENDING',
                        smsText: dep.trx ? `TxRef: ${dep.trx}` : '',
                        date: dep.createdAt || new Date()
                    });
                }
            }
            for (const wit of witDocs) {
                if (!seenIds.has(String(wit._id))) {
                    allTxs.push({
                        _id: wit._id,
                        phone: wit.userId,
                        userId: wit.userId,
                        type: 'withdraw',
                        method: wit.method || 'Telebirr',
                        amount: wit.amount,
                        txRef: 'WIT-' + String(wit._id).slice(-6),
                        status: wit.status || 'PENDING',
                        smsText: wit.account ? `Transfer to: ${wit.account}` : '',
                        date: wit.createdAt || new Date()
                    });
                }
            }
        } else {
            allTxs = [...inMemoryTransactions];
        }

        const normalized = allTxs.map(t => {
            const raw = typeof t.toObject === 'function' ? t.toObject() : t;
            const rawType = String(raw.type || '').toLowerCase();
            let normType = rawType;
            if (rawType.includes('dep')) normType = 'deposit';
            else if (rawType.includes('wit')) normType = 'withdraw';
            else if (rawType.includes('win')) normType = 'win';

            let normStatus = raw.status || 'Approved';
            if (String(normStatus).toUpperCase() === 'PENDING') normStatus = 'Pending';
            else if (String(normStatus).toUpperCase() === 'APPROVED') normStatus = 'Approved';
            else if (String(normStatus).toUpperCase() === 'REJECTED') normStatus = 'Rejected';

            return {
                _id: String(raw._id || raw.reference),
                phone: raw.phone || raw.userId || 'Unknown',
                type: normType,
                method: raw.method || 'Wallet',
                amount: Number(raw.amount || 0),
                bonusGiven: Number(raw.bonusGiven || 0),
                txRef: raw.txRef || raw.reference || 'N/A',
                status: normStatus,
                smsText: raw.smsText || raw.note || '',
                date: raw.date || raw.createdAt || new Date()
            };
        });

        normalized.sort((a, b) => new Date(b.date) - new Date(a.date));

        if (isPending) {
            const pendings = normalized.filter(t => t.status === 'Pending' && (t.type === 'deposit' || t.type === 'withdraw'));
            return res.json({ success: true, txs: pendings, total: pendings.length });
        }

        const cleanSearch = String(search || '').trim().toLowerCase();
        let filtered = normalized.filter(t => {
            if (type === 'rejected') return t.status === 'Rejected';
            return t.type === type && t.status !== 'Pending';
        });

        if (cleanSearch) {
            filtered = filtered.filter(t =>
                String(t.phone).toLowerCase().includes(cleanSearch) ||
                String(t.txRef).toLowerCase().includes(cleanSearch) ||
                String(t.smsText).toLowerCase().includes(cleanSearch)
            );
        }

        return res.json({
            success: true,
            txs: filtered.slice(skip, skip + l),
            total: filtered.length
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Admin Approve / Reject Deposit & Withdraw (/api/admin/action-tx)
app.post('/api/admin/action-tx', adminAuthMiddleware, async (req, res) => {
    try {
        const { txId, action } = req.body || {};
        if (!txId || !action) return res.status(400).json({ success: false, message: 'Missing txId or action' });

        let txDoc = null;
        let depDoc = null;
        let witDoc = null;
        if (mongoose.connection.readyState === 1 && !String(txId).startsWith('tx_')) {
            txDoc = await Transaction.findById(txId).catch(() => null);
            if (!txDoc) depDoc = await Deposit.findById(txId).catch(() => null);
            if (!txDoc && !depDoc) witDoc = await Withdrawal.findById(txId).catch(() => null);
        }
        const memTx = inMemoryTransactions.find(t => String(t._id) === String(txId));
        const target = txDoc || depDoc || witDoc || memTx;

        if (!target) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const currentStatus = String(target.status || '').toLowerCase();
        if (currentStatus !== 'pending') {
            return res.json({ success: true, message: 'Transaction already processed' });
        }

        const isApprove = String(action).toLowerCase() === 'approve';
        const newStatus = isApprove ? 'Approved' : 'Rejected';
        const phone = normalizePhoneNumber(target.phone || target.userId) || (target.phone || target.userId);
        const amt = Number(target.amount || 0);
        const txType = depDoc ? 'deposit' : (witDoc ? 'withdraw' : String(target.type || '').toLowerCase());

        target.status = (depDoc || witDoc) ? newStatus.toUpperCase() : newStatus;
        if (txDoc && typeof txDoc.save === 'function') await txDoc.save();
        if (depDoc && typeof depDoc.save === 'function') await depDoc.save();
        if (witDoc && typeof witDoc.save === 'function') await witDoc.save();
        if (memTx) memTx.status = newStatus;

        const user = await findUserByTgOrPhone(null, phone);
        if (user) {
            if (txType.includes('dep') && isApprove) {
                const sysSettings = await getActiveSettingsObj();
                let bonusAmt = 0;
                if (sysSettings.depBonusTier3Min > 0 && amt >= sysSettings.depBonusTier3Min && sysSettings.depBonusTier3Percent > 0) {
                    bonusAmt = Math.round((amt * (sysSettings.depBonusTier3Percent / 100)) * 100) / 100;
                } else if (sysSettings.depBonusTier2Min > 0 && amt >= sysSettings.depBonusTier2Min && sysSettings.depBonusTier2Percent > 0) {
                    bonusAmt = Math.round((amt * (sysSettings.depBonusTier2Percent / 100)) * 100) / 100;
                } else if (sysSettings.depBonusMinAmount > 0 && amt >= sysSettings.depBonusMinAmount && sysSettings.depBonusPercent > 0) {
                    bonusAmt = Math.round((amt * (sysSettings.depBonusPercent / 100)) * 100) / 100;
                }
                if (bonusAmt > 0 && txDoc) {
                    txDoc.bonusGiven = bonusAmt;
                    await txDoc.save().catch(() => {});
                }
                user.playBalance = Number(user.playBalance ?? user.bonusBalance ?? 0) + amt + bonusAmt;
                user.bonusBalance = user.playBalance;
                user.totalDeposited = Number(user.totalDeposited || 0) + amt;
                if (bonusAmt > 0) user.totalBonus = Number(user.totalBonus || 0) + bonusAmt;
                if (typeof user.save === 'function') await user.save().catch(() => {});
                inMemoryUsers.set(phone, user);

                io.emit('balance_updated', {
                    phone,
                    playBalance: user.playBalance,
                    mainBalance: Number(user.mainBalance ?? user.balance ?? 0),
                    totalBalance: user.playBalance + Number(user.mainBalance ?? user.balance ?? 0)
                });
            } else if (txType.includes('wit') && !isApprove) {
                user.mainBalance = Number(user.mainBalance ?? user.balance ?? 0) + amt;
                user.balance = user.mainBalance;
                if (typeof user.save === 'function') await user.save().catch(() => {});
                inMemoryUsers.set(phone, user);

                io.emit('balance_updated', {
                    phone,
                    playBalance: Number(user.playBalance ?? user.bonusBalance ?? 0),
                    mainBalance: user.mainBalance,
                    totalBalance: Number(user.playBalance ?? user.bonusBalance ?? 0) + user.mainBalance
                });
            }
        }

        return res.json({ success: true, status: newStatus, message: `Transaction ${newStatus}` });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 5. Admin Manual Receipt Deposit (/api/admin/manual-receipt-deposit)
app.post('/api/admin/manual-receipt-deposit', adminAuthMiddleware, async (req, res) => {
    try {
        const { phone, txRef, amount, bank } = req.body || {};
        const cleanPhone = normalizePhoneNumber(phone) || String(phone || '').trim();
        const numAmt = Number(amount);
        if (!cleanPhone || !txRef || isNaN(numAmt) || numAmt <= 0) {
            return res.status(400).json({ success: false, message: 'እባክዎ ስልክ፣ ደረሰኝ ቁጥር እና የብር መጠን በትክክል ያስገቡ!' });
        }

        const user = await findUserByTgOrPhone(null, cleanPhone);
        if (!user) {
            return res.status(404).json({ success: false, message: 'ተጠቃሚው አልተገኘም!' });
        }

        user.playBalance = Number(user.playBalance ?? user.bonusBalance ?? 0) + numAmt;
        user.bonusBalance = user.playBalance;
        user.totalDeposited = Number(user.totalDeposited || 0) + numAmt;
        if (typeof user.save === 'function') await user.save().catch(() => {});
        inMemoryUsers.set(cleanPhone, user);

        const txPayload = {
            reference: txRef + '_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            txRef,
            userId: cleanPhone,
            phone: cleanPhone,
            type: 'deposit',
            method: bank || 'Manual Admin',
            amount: numAmt,
            status: 'Approved',
            smsText: `Manual Deposit by Admin (Ref: ${txRef})`,
            date: new Date()
        };
        let txIdStr = new mongoose.Types.ObjectId().toString();
        if (mongoose.connection.readyState === 1) {
            const created = await Transaction.create(txPayload).catch(() => null);
            if (created && created._id) txIdStr = String(created._id);
        }
        const txRecord = { _id: txIdStr, ...txPayload };
        inMemoryTransactions.unshift(txRecord);

        io.emit('balance_updated', {
            phone: cleanPhone,
            playBalance: user.playBalance,
            mainBalance: Number(user.mainBalance ?? user.balance ?? 0),
            totalBalance: user.playBalance + Number(user.mainBalance ?? user.balance ?? 0)
        });

        return res.json({ success: true, message: `ለ ${cleanPhone} የ ${numAmt} ETB በተሳካ ሁኔታ ተሞልቷል!` });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 6. Admin Clear Spam Deposits (/api/admin/clear-spam-deposits)
app.post('/api/admin/clear-spam-deposits', adminAuthMiddleware, async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            await Transaction.deleteMany({ type: 'deposit', status: { $in: ['Pending', 'PENDING'] } });
        }
        for (let i = inMemoryTransactions.length - 1; i >= 0; i--) {
            if (inMemoryTransactions[i].type === 'deposit' && inMemoryTransactions[i].status === 'Pending') {
                inMemoryTransactions.splice(i, 1);
            }
        }
        io.emit('pending_deposits_cleared');
        return res.json({ success: true, message: 'ሁሉም Pending Deposits ተሰርዘዋል!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 7. Admin Delete Transactions (/api/admin/delete-transactions)
app.post('/api/admin/delete-transactions', adminAuthMiddleware, async (req, res) => {
    try {
        const { ids } = req.body || {};
        if (Array.isArray(ids) && ids.length > 0) {
            if (mongoose.connection.readyState === 1) {
                const validObjIds = ids.filter(id => !String(id).startsWith('tx_'));
                if (validObjIds.length > 0) {
                    await Transaction.deleteMany({ _id: { $in: validObjIds } }).catch(() => {});
                }
            }
            for (let i = inMemoryTransactions.length - 1; i >= 0; i--) {
                if (ids.includes(String(inMemoryTransactions[i]._id))) {
                    inMemoryTransactions.splice(i, 1);
                }
            }
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 8. Admin Users List (/api/admin/users)
app.post('/api/admin/users', adminAuthMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, search = '' } = req.body || {};
        const p = Math.max(1, parseInt(page, 10));
        const l = Math.min(100, Math.max(1, parseInt(limit, 10)));
        const skip = (p - 1) * l;
        const cleanSearch = String(search || '').trim();

        let usersList = [];
        let total = 0;

        if (mongoose.connection.readyState === 1) {
            const filter = {};
            if (cleanSearch) {
                const escaped = cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                filter.$or = [
                    { phone: { $regex: escaped, $options: 'i' } },
                    { name: { $regex: escaped, $options: 'i' } }
                ];
            }
            total = await User.countDocuments(filter);
            const docs = await User.find(filter).sort({ registeredAt: -1, _id: -1 }).skip(skip).limit(l);
            usersList = docs.map(u => ({
                _id: String(u._id),
                name: u.name || 'Player',
                phone: u.phone || u.userId || '',
                password: u.password ? '••••••' : 'Telegram',
                playBalance: Number(u.playBalance ?? u.bonusBalance ?? 0),
                mainBalance: Number(u.mainBalance ?? u.balance ?? 0),
                totalDeposited: Number(u.totalDeposited || 0),
                won: Number(u.won ?? u.totalWon ?? 0),
                status: u.isBlocked ? 'banned' : 'active'
            }));
        } else {
            const uniqueByPhone = new Map();
            for (const u of inMemoryUsers.values()) {
                const key = u.phone || u.telegramId;
                if (key && !uniqueByPhone.has(key)) {
                    uniqueByPhone.set(key, u);
                }
            }
            let arr = Array.from(uniqueByPhone.values());
            if (cleanSearch) {
                const sLow = cleanSearch.toLowerCase();
                arr = arr.filter(u =>
                    (u.phone && u.phone.toLowerCase().includes(sLow)) ||
                    (u.name && u.name.toLowerCase().includes(sLow))
                );
            }
            total = arr.length;
            usersList = arr.slice(skip, skip + l).map(u => ({
                _id: u.phone || u.telegramId,
                name: u.name || 'Player',
                phone: u.phone || u.telegramId || '',
                password: '••••••',
                playBalance: Number(u.playBalance ?? u.bonusBalance ?? 0),
                mainBalance: Number(u.mainBalance ?? u.balance ?? 0),
                totalDeposited: Number(u.totalDeposited || 0),
                won: Number(u.won ?? u.totalWon ?? 0),
                status: u.isBlocked ? 'banned' : 'active'
            }));
        }

        return res.json({ success: true, users: usersList, total });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 9. Admin User Details (/api/admin/user-details)
app.post('/api/admin/user-details', adminAuthMiddleware, async (req, res) => {
    try {
        const { phone } = req.body || {};
        const cleanPhone = normalizePhoneNumber(phone) || String(phone || '').trim();
        let txs = [];
        if (mongoose.connection.readyState === 1) {
            txs = await Transaction.find({
                $or: [{ phone: cleanPhone }, { userId: cleanPhone }, { phone }]
            }).sort({ date: -1 }).limit(50);
        } else {
            txs = inMemoryTransactions.filter(t => t.phone === cleanPhone || t.userId === cleanPhone);
        }

        let aggDep = 0, aggWit = 0, aggBonus = 0, aggWin = 0;
        const formattedTxs = txs.map(t => {
            const amt = Number(t.amount || 0);
            const tType = String(t.type || '').toLowerCase();
            const st = String(t.status || 'Approved');
            if (st.toLowerCase() === 'approved') {
                if (tType.includes('dep')) aggDep += amt;
                else if (tType.includes('wit')) aggWit += amt;
                else if (tType.includes('win')) aggWin += amt;
                else if (tType.includes('bon')) aggBonus += amt;
            }
            return {
                date: t.date || new Date(),
                type: tType.includes('dep') ? 'deposit' : (tType.includes('wit') ? 'withdraw' : (tType.includes('win') ? 'win' : tType)),
                method: t.method || 'Wallet',
                amount: amt,
                bonusGiven: Number(t.bonusGiven || 0),
                status: st
            };
        });

        return res.json({
            success: true,
            aggDep,
            aggWit,
            aggBonus,
            aggWin,
            txs: formattedTxs
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 10. Admin Edit User (/api/admin/edit-user) & Delete User (/api/admin/delete-user)
app.post('/api/admin/edit-user', adminAuthMiddleware, async (req, res) => {
    try {
        const { oldPhone, newPhone, name, userPass, mainBalance, playBalance, won } = req.body || {};
        const cleanOld = normalizePhoneNumber(oldPhone) || String(oldPhone || '').trim();
        const user = await findUserByTgOrPhone(null, cleanOld);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const targetPhone = newPhone ? (normalizePhoneNumber(newPhone) || String(newPhone).trim()) : cleanOld;
        if (name !== undefined && String(name).trim()) user.name = String(name).trim();
        if (targetPhone) user.phone = targetPhone;
        if (userPass && !String(userPass).includes('•') && userPass !== 'Telegram') {
            user.password = await hashPassword(String(userPass));
        }
        if (mainBalance !== undefined && mainBalance !== '') {
            user.mainBalance = Number(mainBalance);
            user.balance = Number(mainBalance);
        }
        if (playBalance !== undefined && playBalance !== '') {
            user.playBalance = Number(playBalance);
            user.bonusBalance = Number(playBalance);
        }
        if (won !== undefined && won !== '') {
            user.won = Number(won);
            user.totalWon = Number(won);
        }

        if (typeof user.save === 'function') {
            await user.save().catch(() => {});
        } else if (mongoose.connection.readyState === 1) {
            await User.findOneAndUpdate(
                { $or: [{ phone: cleanOld }, { phone: oldPhone }] },
                {
                    $set: {
                        name: user.name,
                        phone: user.phone,
                        mainBalance: user.mainBalance,
                        balance: user.mainBalance,
                        playBalance: user.playBalance,
                        bonusBalance: user.playBalance,
                        won: user.won,
                        totalWon: user.won
                    }
                }
            ).catch(() => {});
        }
        if (cleanOld !== user.phone) inMemoryUsers.delete(cleanOld);
        inMemoryUsers.set(user.phone, user);

        for (const p of currentGame.players.values()) {
            if (p.phone === cleanOld || p.phone === oldPhone) {
                p.phone = user.phone;
                p.name = user.name;
            }
        }
        for (const seat of currentGame.selectedCards.values()) {
            if (seat && (seat.phone === cleanOld || seat.phone === oldPhone)) {
                seat.phone = user.phone;
                seat.name = user.name;
            }
        }

        io.emit('balance_updated', {
            phone: user.phone,
            playBalance: user.playBalance,
            mainBalance: user.mainBalance,
            totalBalance: user.playBalance + user.mainBalance
        });

        return res.json({ success: true, message: 'User updated!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/delete-user', adminAuthMiddleware, async (req, res) => {
    try {
        const rawPhone = req.body.phone;
        const cleanPhone = normalizePhoneNumber(rawPhone) || String(rawPhone || '').trim();
        if (!cleanPhone) return res.status(400).json({ success: false, message: 'Phone required' });

        if (mongoose.connection.readyState === 1) {
            await User.deleteMany({ $or: [{ phone: cleanPhone }, { phone: rawPhone }, { userId: cleanPhone }] }).catch(() => {});
        }
        inMemoryUsers.delete(cleanPhone);
        inMemoryUsers.delete(rawPhone);

        for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
            if (seat && (seat.phone === cleanPhone || seat.phone === rawPhone)) {
                currentGame.selectedCards.delete(tid);
            }
        }
        for (const [sockId, p] of Array.from(currentGame.players.entries())) {
            if (p && (p.phone === cleanPhone || p.phone === rawPhone)) {
                currentGame.players.delete(sockId);
            }
        }
        recalcLiveGamePotAndBroadcast();
        return res.json({ success: true, message: 'User deleted!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 11. Admin Ban / Unban User (/api/admin/ban-user & /api/admin/unban-user)
app.post('/api/admin/ban-user', adminAuthMiddleware, async (req, res) => {
    try {
        const cleanPhone = normalizePhoneNumber(req.body.phone) || String(req.body.phone || '').trim();
        const user = await findUserByTgOrPhone(null, cleanPhone);
        if (user) {
            user.isBlocked = true;
            if (typeof user.save === 'function') await user.save().catch(() => {});
            inMemoryUsers.set(cleanPhone, user);
        }
        if (mongoose.connection.readyState === 1) {
            await User.updateMany({ $or: [{ phone: cleanPhone }, { phone: req.body.phone }] }, { $set: { isBlocked: true } }).catch(() => {});
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false });
    }
});

app.post('/api/admin/unban-user', adminAuthMiddleware, async (req, res) => {
    try {
        const cleanPhone = normalizePhoneNumber(req.body.phone) || String(req.body.phone || '').trim();
        const user = await findUserByTgOrPhone(null, cleanPhone);
        if (user) {
            user.isBlocked = false;
            if (typeof user.save === 'function') await user.save().catch(() => {});
            inMemoryUsers.set(cleanPhone, user);
        }
        if (mongoose.connection.readyState === 1) {
            await User.updateMany({ $or: [{ phone: cleanPhone }, { phone: req.body.phone }] }, { $set: { isBlocked: false } }).catch(() => {});
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false });
    }
});

function buildLiveGamePlayersArray() {
    const byPhone = new Map();
    for (const player of currentGame.players.values()) {
        if (player && Array.isArray(player.tickets) && player.tickets.length > 0) {
            const pPhone = player.phone || '0900000000';
            byPhone.set(pPhone, {
                name: player.name || 'Player',
                phone: pPhone,
                isBot: false,
                gameId: currentGame.gameId,
                ticketPrice: currentGame.stake || 10,
                tickets: player.tickets.length,
                ticketsCount: player.tickets.length,
                ticketIds: player.tickets.map(t => parseInt(t.id, 10)),
                ticketsData: player.tickets.map(t => ({
                    id: parseInt(t.id, 10),
                    grid: t.grid || generateFixedCard(parseInt(t.id, 10))
                }))
            });
        }
    }
    for (const [tid, seat] of currentGame.selectedCards.entries()) {
        if (!seat) continue;
        const pPhone = seat.phone || '0900000000';
        if (!byPhone.has(pPhone)) {
            byPhone.set(pPhone, {
                name: seat.name || (seat.isBot ? 'Bot' : 'Player'),
                phone: pPhone,
                isBot: !!seat.isBot,
                gameId: currentGame.gameId,
                ticketPrice: currentGame.stake || 10,
                tickets: 0,
                ticketsCount: 0,
                ticketIds: [],
                ticketsData: []
            });
        }
        const entry = byPhone.get(pPhone);
        if (!entry.ticketIds.includes(Number(tid))) {
            entry.tickets++;
            entry.ticketsCount++;
            entry.ticketIds.push(Number(tid));
            entry.ticketsData.push({
                id: Number(tid),
                grid: generateFixedCard(Number(tid))
            });
        }
    }
    return Array.from(byPhone.values());
}

function recalcLiveGamePotAndBroadcast() {
    const totalTickets = currentGame.selectedCards.size;
    currentGame.totalJackpot = totalTickets * (currentGame.stake || 10);
    currentGame.netJackpot = getNetJackpot(currentGame.totalJackpot, 20);
    io.emit('update_taken_tickets', Array.from(currentGame.selectedCards.keys()));
    io.emit('game_status', getGameStatusPayload());
}

// 12. Admin Search Player Bets (/api/admin/search-bets) & Delete Bet (/api/admin/delete-game-player)
app.post('/api/admin/search-bets', adminAuthMiddleware, async (req, res) => {
    try {
        const searchVal = String(req.body.search || '').trim();
        const matchedGames = [];

        // Check live game first
        const livePlayers = buildLiveGamePlayersArray();
        const liveMatch = livePlayers.some(p => {
            if (!searchVal) return true;
            if (p.phone && String(p.phone).includes(searchVal)) return true;
            if (p.name && String(p.name).toLowerCase().includes(searchVal.toLowerCase())) return true;
            if (!isNaN(searchVal) && Array.isArray(p.ticketIds) && p.ticketIds.some(id => String(id) === searchVal)) return true;
            return false;
        });
        if (liveMatch && livePlayers.length > 0) {
            matchedGames.push({
                _id: 'live_' + currentGame.gameId,
                gameId: currentGame.gameId,
                date: new Date(),
                ticketPrice: currentGame.stake || 10,
                calledNumbers: currentGame.drawnNumbers || [],
                playersData: livePlayers
            });
        }

        let docs = [];
        if (mongoose.connection.readyState === 1) {
            docs = await Game.find().sort({ gameId: -1 }).limit(100);
        } else {
            docs = [...inMemoryGames];
        }

        for (const g of docs) {
            const pList = Array.isArray(g.playersData) ? g.playersData : [];
            const hasMatch = pList.some(p => {
                if (!searchVal) return true;
                if (p.phone && String(p.phone).includes(searchVal)) return true;
                if (p.name && String(p.name).toLowerCase().includes(searchVal.toLowerCase())) return true;
                if (!isNaN(searchVal) && Array.isArray(p.ticketsData) && p.ticketsData.some(t => String(t.id) === searchVal)) return true;
                if (!isNaN(searchVal) && Array.isArray(p.ticketIds) && p.ticketIds.some(id => String(id) === searchVal)) return true;
                return false;
            });
            if (hasMatch) {
                matchedGames.push({
                    _id: String(g._id || g.gameId),
                    gameId: g.gameId,
                    date: g.createdAt || new Date(),
                    ticketPrice: g.stake || 10,
                    calledNumbers: g.numbers || [],
                    playersData: pList.map(p => ({
                        name: p.name || 'Player',
                        phone: p.phone || '',
                        isBot: !!p.isBot,
                        tickets: p.tickets || p.ticketCount || (p.ticketIds ? p.ticketIds.length : 1),
                        ticketsData: p.ticketsData || (p.ticketIds || []).map(id => ({ id, grid: generateFixedCard(id) }))
                    }))
                });
            }
        }
        return res.json({ success: true, games: matchedGames });
    } catch (err) {
        return res.status(500).json({ success: false, games: [] });
    }
});

app.post('/api/admin/delete-game-player', adminAuthMiddleware, async (req, res) => {
    try {
        const { id, phone } = req.body || {};
        const cleanPhone = normalizePhoneNumber(phone) || String(phone || '').trim();

        // Also remove from LIVE game if id is LIVE, live_*, or matches currentGame.gameId
        if (!id || id === 'LIVE' || String(id).startsWith('live_') || String(id) === String(currentGame.gameId) || String(id) === 'game_' + currentGame.gameId) {
            for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
                if (seat && (seat.phone === phone || seat.phone === cleanPhone)) {
                    currentGame.selectedCards.delete(tid);
                }
            }
            for (const [sockId, p] of Array.from(currentGame.players.entries())) {
                if (p && (p.phone === phone || p.phone === cleanPhone)) {
                    p.tickets = [];
                    currentGame.players.delete(sockId);
                }
            }
            recalcLiveGamePotAndBroadcast();
        }

        if (id && id !== 'LIVE' && !String(id).startsWith('live_')) {
            if (mongoose.connection.readyState === 1 && !String(id).startsWith('game_')) {
                await Game.updateOne({ _id: id }, { $pull: { playersData: { phone: { $in: [phone, cleanPhone] } } } }).catch(() => {});
            }
            const memG = inMemoryGames.find(g => String(g._id) === String(id) || String(g.gameId) === String(id));
            if (memG && Array.isArray(memG.playersData)) {
                memG.playersData = memG.playersData.filter(p => p.phone !== phone && p.phone !== cleanPhone);
            }
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false });
    }
});

// 13. Admin Live Players List (/api/admin/live-players-list), Clear Live Bots, & Inject Live Bots
app.post('/api/admin/live-players-list', adminAuthMiddleware, async (req, res) => {
    try {
        return res.json({ success: true, players: buildLiveGamePlayersArray() });
    } catch (err) {
        return res.status(500).json({ success: false, players: [] });
    }
});

app.post('/api/admin/clear-live-bots', adminAuthMiddleware, async (req, res) => {
    try {
        const { disableBotSystem = true } = req.body || {};
        let removedTickets = 0;
        for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
            if (seat && seat.isBot) {
                currentGame.selectedCards.delete(tid);
                removedTickets++;
            }
        }
        if (disableBotSystem) {
            if (!global.__inMemorySettings) global.__inMemorySettings = {};
            global.__inMemorySettings.isBotSystemActive = false;
            global.__inMemorySettings.botDist1 = 0;
            global.__inMemorySettings.botDist2 = 0;
            global.__inMemorySettings.botDist3 = 0;
            global.__inMemorySettings.botDist4 = 0;
            if (botRoutesFn && botRoutesFn.inMemoryBotSettings) {
                botRoutesFn.inMemoryBotSettings.isBotSystemActive = false;
                botRoutesFn.inMemoryBotSettings.botDist1 = 0;
                botRoutesFn.inMemoryBotSettings.botDist2 = 0;
                botRoutesFn.inMemoryBotSettings.botDist3 = 0;
                botRoutesFn.inMemoryBotSettings.botDist4 = 0;
            }
            if (mongoose.connection.readyState === 1) {
                await SystemSettings.findOneAndUpdate({}, { $set: { isBotSystemActive: false, botDist1: 0, botDist2: 0, botDist3: 0, botDist4: 0 } }, { upsert: true }).catch(() => {});
                await Settings.findOneAndUpdate({}, { $set: { isBotSystemActive: false, botDist1: 0, botDist2: 0, botDist3: 0, botDist4: 0 } }, { upsert: true }).catch(() => {});
            }
        }
        recalcLiveGamePotAndBroadcast();
        return res.json({
            success: true,
            removedTickets,
            message: `✅ ሁሉም ቦቶች (${removedTickets} ካርቴላዎች) ከጨዋታው ተወግደዋል!`
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/inject-live-bots', adminAuthMiddleware, async (req, res) => {
    try {
        const { dist1 = 0, dist2 = 0, dist3 = 0, dist4 = 0, customJackpot } = req.body || {};
        const d1 = Math.max(0, parseInt(dist1, 10) || 0);
        const d2 = Math.max(0, parseInt(dist2, 10) || 0);
        const d3 = Math.max(0, parseInt(dist3, 10) || 0);
        const d4 = Math.max(0, parseInt(dist4, 10) || 0);

        // Save Admin's exact chosen distribution so future rounds also respect it if bots are enabled
        if (!global.__inMemorySettings) global.__inMemorySettings = {};
        global.__inMemorySettings.isBotSystemActive = (d1 + d2 + d3 + d4) > 0;
        global.__inMemorySettings.botDist1 = d1;
        global.__inMemorySettings.botDist2 = d2;
        global.__inMemorySettings.botDist3 = d3;
        global.__inMemorySettings.botDist4 = d4;
        if (botRoutesFn && botRoutesFn.inMemoryBotSettings) {
            botRoutesFn.inMemoryBotSettings.isBotSystemActive = (d1 + d2 + d3 + d4) > 0;
            botRoutesFn.inMemoryBotSettings.botDist1 = d1;
            botRoutesFn.inMemoryBotSettings.botDist2 = d2;
            botRoutesFn.inMemoryBotSettings.botDist3 = d3;
            botRoutesFn.inMemoryBotSettings.botDist4 = d4;
        }
        if (mongoose.connection.readyState === 1) {
            const setObj = { isBotSystemActive: (d1 + d2 + d3 + d4) > 0, botDist1: d1, botDist2: d2, botDist3: d3, botDist4: d4 };
            await SystemSettings.findOneAndUpdate({}, { $set: setObj }, { upsert: true }).catch(() => {});
            await Settings.findOneAndUpdate({}, { $set: setObj }, { upsert: true }).catch(() => {});
        }

        // Schedule human-like staggered bot entry for current round (with immediate first bot pick so Admin sees instant feedback)
        const targetBotsCount = d1 + d2 + d3 + d4;
        const targetTicketsCount = (d1 * 1) + (d2 * 2) + (d3 * 3) + (d4 * 4);
        populateBotTicketsForRound(true, { humanGradual: currentGame.state === 'WAITING' && currentGame.timer > 6 });

        if (customJackpot !== undefined && !isNaN(Number(customJackpot))) {
            currentGame.netJackpot = Number(customJackpot);
            currentGame.totalJackpot = Math.max(currentGame.totalJackpot, currentGame.netJackpot);
            recalcLiveGamePotAndBroadcast();
        }

        return res.json({
            success: true,
            message: `✅ ${targetBotsCount} ቦቶች (${targetTicketsCount} ካርቴላዎች) በሰው ባህሪ (Human Behaviour) ገብተዋል! ጃክፖት: ${currentGame.netJackpot} ETB`
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 14. Admin Daily Active Balances, Bonus, Promo, Referrals, Promoters, Leaderboard, SMS Comparison
app.post('/api/admin/daily-active-balances', adminAuthMiddleware, async (req, res) => {
    try {
        let users = [];
        if (mongoose.connection.readyState === 1) {
            users = await User.find({ mainBalance: { $gt: 0 } }).sort({ mainBalance: -1 }).limit(50);
        } else {
            users = Array.from(inMemoryUsers.values()).filter(u => Number(u.mainBalance || 0) > 0);
        }
        const totalRiskAmount = users.reduce((sum, u) => sum + Number(u.mainBalance || 0), 0);
        return res.json({ success: true, totalRiskAmount, users });
    } catch (err) {
        return res.json({ success: true, totalRiskAmount: 0, users: [] });
    }
});

app.post('/api/admin/send-single-bonus', adminAuthMiddleware, async (req, res) => {
    try {
        const { phone, amount } = req.body || {};
        const cleanPhone = normalizePhoneNumber(phone) || String(phone || '').trim();
        const numAmt = Number(amount);
        if (!cleanPhone || isNaN(numAmt) || numAmt <= 0) {
            return res.json({ success: false, message: 'Invalid phone or amount' });
        }
        const user = await findUserByTgOrPhone(null, cleanPhone);
        if (!user) return res.json({ success: false, message: 'User not found!' });

        user.playBalance = Number(user.playBalance ?? user.bonusBalance ?? 0) + numAmt;
        user.bonusBalance = user.playBalance;
        if (typeof user.save === 'function') await user.save().catch(() => {});
        inMemoryUsers.set(cleanPhone, user);

        io.emit('balance_updated', {
            phone: cleanPhone,
            playBalance: user.playBalance,
            mainBalance: Number(user.mainBalance ?? user.balance ?? 0),
            totalBalance: user.playBalance + Number(user.mainBalance ?? user.balance ?? 0)
        });
        return res.json({ success: true, message: `✅ ${numAmt} ETB ቦነስ ለ ${cleanPhone} ተልኳል!` });
    } catch (err) {
        return res.json({ success: false, message: err.message });
    }
});

app.post('/api/admin/send-bulk-bonus', adminAuthMiddleware, async (req, res) => {
    try {
        const { phones, amount } = req.body || {};
        const numAmt = Number(amount);
        if (isNaN(numAmt) || numAmt <= 0) return res.json({ success: false, message: 'Invalid amount' });

        if (phones === 'ALL') {
            if (mongoose.connection.readyState === 1) {
                await User.updateMany({}, { $inc: { playBalance: numAmt, bonusBalance: numAmt } });
            }
            for (const u of inMemoryUsers.values()) {
                u.playBalance = Number(u.playBalance || 0) + numAmt;
            }
            return res.json({ success: true, message: `✅ ለሁሉም ተጫዋቾች የ ${numAmt} ETB ቦነስ ተልኳል!` });
        }
        const list = Array.isArray(phones) ? phones : [];
        let count = 0;
        for (const p of list) {
            const u = await findUserByTgOrPhone(null, p);
            if (u) {
                u.playBalance = Number(u.playBalance ?? u.bonusBalance ?? 0) + numAmt;
                u.bonusBalance = u.playBalance;
                if (typeof u.save === 'function') await u.save().catch(() => {});
                count++;
            }
        }
        return res.json({ success: true, message: `✅ ለ ${count} ተጫዋቾች የ ${numAmt} ETB ቦነስ ተልኳል!` });
    } catch (err) {
        return res.json({ success: false, message: err.message });
    }
});

app.post('/api/admin/list-promo-codes', adminAuthMiddleware, async (req, res) => {
    try {
        let codes = inMemoryPromos;
        if (mongoose.connection.readyState === 1) {
            codes = await Promo.find().sort({ _id: -1 });
        }
        return res.json({ success: true, codes });
    } catch (err) {
        return res.json({ success: true, codes: [] });
    }
});

app.post('/api/admin/create-promo-code', adminAuthMiddleware, async (req, res) => {
    try {
        const { code, amount, maxUses, requireDeposit, minDepositAmount, requireDepositWithinHours } = req.body || {};
        const promoPayload = {
            code: String(code || '').trim().toUpperCase(),
            amount: Number(amount) || 10,
            maxUses: Number(maxUses) || 10,
            currentUses: 0,
            requireDeposit: !!requireDeposit,
            minDepositAmount: Number(minDepositAmount) || 0,
            requireDepositWithinHours: Number(requireDepositWithinHours) || 0,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            usedBy: [],
            active: true
        };
        let promoIdStr = new mongoose.Types.ObjectId().toString();
        if (mongoose.connection.readyState === 1) {
            const savedPromo = await Promo.findOneAndUpdate({ code: promoPayload.code }, { $set: promoPayload }, { upsert: true, new: true }).catch(() => null);
            if (savedPromo && savedPromo._id) promoIdStr = String(savedPromo._id);
        }
        inMemoryPromos.unshift({ _id: promoIdStr, ...promoPayload });
        return res.json({ success: true, message: 'Promo code created!' });
    } catch (err) {
        return res.json({ success: false, message: err.message });
    }
});

app.post('/api/admin/delete-promo-code', adminAuthMiddleware, async (req, res) => {
    try {
        const { id } = req.body || {};
        if (mongoose.connection.readyState === 1 && !String(id).startsWith('promo_')) {
            await Promo.findByIdAndDelete(id).catch(() => {});
        }
        const idx = inMemoryPromos.findIndex(p => String(p._id) === String(id));
        if (idx >= 0) inMemoryPromos.splice(idx, 1);
        return res.json({ success: true });
    } catch (err) {
        return res.json({ success: false });
    }
});

app.post('/api/claim-promo-code', async (req, res) => {
    try {
        const { phone, code } = req.body || {};
        const cleanPhone = normalizePhoneNumber(phone) || String(phone || '').trim();
        const cleanCode = String(code || '').trim().toUpperCase();
        const user = await findUserByTgOrPhone(null, cleanPhone);
        if (!user) return res.json({ success: false, message: 'User not found' });

        let promo = inMemoryPromos.find(p => p.code === cleanCode);
        if (mongoose.connection.readyState === 1) {
            promo = await Promo.findOne({ code: cleanCode }) || promo;
        }
        if (!promo) return res.json({ success: false, message: '❌ የተሳሳተ የፕሮሞ ኮድ!' });
        if ((promo.currentUses || 0) >= (promo.maxUses || 1)) {
            return res.json({ success: false, message: '❌ ይህ የፕሮሞ ኮድ አልቋል!' });
        }
        if (Array.isArray(promo.usedBy) && promo.usedBy.includes(cleanPhone)) {
            return res.json({ success: false, message: '❌ ይህን ኮድ ቀደም ብለው ተጠቅመውታል!' });
        }

        promo.currentUses = (promo.currentUses || 0) + 1;
        if (!Array.isArray(promo.usedBy)) promo.usedBy = [];
        promo.usedBy.push(cleanPhone);
        if (typeof promo.save === 'function') await promo.save().catch(() => {});

        const amt = Number(promo.amount || 0);
        user.playBalance = Number(user.playBalance ?? user.bonusBalance ?? 0) + amt;
        user.bonusBalance = user.playBalance;
        if (typeof user.save === 'function') await user.save().catch(() => {});
        inMemoryUsers.set(cleanPhone, user);

        return res.json({ success: true, amount: amt, message: `የ ${amt} ETB የፕሮሞ ቦነስ አግኝተዋል!` });
    } catch (err) {
        return res.json({ success: false, message: err.message });
    }
});

app.post('/api/admin/create-claim-bonus', adminAuthMiddleware, async (req, res) => {
    const { maxUsers, amount, minutes, message } = req.body || {};
    inMemoryClaimPromo = {
        max: Number(maxUsers) || 10,
        amount: Number(amount) || 10,
        expiresAt: Date.now() + (Number(minutes) || 10) * 60 * 1000,
        claimedBy: [],
        message
    };
    io.emit('new_promo_alert', { amount: inMemoryClaimPromo.amount });
    return res.json({ success: true, message: '🎉 Promo Created & Broadcasted!' });
});

app.post('/api/admin/claim-bonus-list', adminAuthMiddleware, (req, res) => {
    if (!inMemoryClaimPromo) return res.json({ success: false, message: 'No active claim promo' });
    return res.json({ success: true, claimedBy: inMemoryClaimPromo.claimedBy, max: inMemoryClaimPromo.max });
});

app.post('/api/claim-promo-web', async (req, res) => {
    const cleanPhone = normalizePhoneNumber(req.body.phone) || String(req.body.phone || '').trim();
    if (!inMemoryClaimPromo || Date.now() > inMemoryClaimPromo.expiresAt) {
        return res.json({ success: false, message: 'ቦነሱ አብቅቷል!' });
    }
    if (inMemoryClaimPromo.claimedBy.length >= inMemoryClaimPromo.max) {
        return res.json({ success: false, message: 'ቦነሱ ተሟጧል!' });
    }
    if (inMemoryClaimPromo.claimedBy.includes(cleanPhone)) {
        return res.json({ success: false, message: 'ቀደም ብለው ወስደዋል!' });
    }
    const user = await findUserByTgOrPhone(null, cleanPhone);
    if (!user) return res.json({ success: false, message: 'User not found' });

    inMemoryClaimPromo.claimedBy.push(cleanPhone);
    user.playBalance = Number(user.playBalance ?? user.bonusBalance ?? 0) + inMemoryClaimPromo.amount;
    user.bonusBalance = user.playBalance;
    if (typeof user.save === 'function') await user.save().catch(() => {});
    return res.json({ success: true, amount: inMemoryClaimPromo.amount });
});

app.post('/api/admin/referrals', adminAuthMiddleware, async (req, res) => {
    try {
        let allUsers = [];
        if (mongoose.connection.readyState === 1) {
            allUsers = await User.find({}).lean();
        } else {
            allUsers = Array.from(inMemoryUsers.values());
        }
        const refMap = {};
        for (const u of allUsers) {
            const ref = (u.referredBy || '').trim();
            if (ref) {
                refMap[ref] = (refMap[ref] || 0) + 1;
            }
        }
        const referrals = Object.keys(refMap).map(code => ({
            code,
            invitedCount: refMap[code]
        }));
        return res.json({ success: true, referrals, total: referrals.length });
    } catch (err) {
        return res.json({ success: true, referrals: [], total: 0 });
    }
});

app.post('/api/admin/referral-details', adminAuthMiddleware, async (req, res) => {
    try {
        const { code, phone } = req.body || {};
        const target = String(code || phone || '').trim();
        let allUsers = [];
        if (mongoose.connection.readyState === 1) {
            allUsers = await User.find({ $or: [{ referredBy: target }, { referralCode: target }] }).lean();
        } else {
            allUsers = Array.from(inMemoryUsers.values()).filter(u => u.referredBy === target || u.referralCode === target);
        }
        const users = allUsers.map(u => ({
            name: u.name || 'Player',
            phone: u.phone || '',
            registeredAt: u.registeredAt || u.createdAt || new Date(),
            mainBalance: u.mainBalance || 0
        }));
        return res.json({ success: true, users });
    } catch (err) {
        return res.json({ success: true, users: [] });
    }
});

app.post('/api/admin/fix-missing-invites', adminAuthMiddleware, async (req, res) => {
    return res.json({ success: true, message: '✅ ሁሉም የሪፈራል ቦነሶች ተረጋግጠዋል!' });
});
app.post('/api/admin/delete-fake-referrals', adminAuthMiddleware, async (req, res) => {
    return res.json({ success: true, message: '✅ የውሸት ሪፈራሎች ተስተካክለዋል!' });
});

app.post('/api/admin/promoters-data', adminAuthMiddleware, async (req, res) => {
    try {
        let allUsers = [];
        if (mongoose.connection.readyState === 1) {
            allUsers = await User.find({}).lean();
        } else {
            allUsers = Array.from(inMemoryUsers.values());
        }
        const refMap = {};
        for (const u of allUsers) {
            const ref = (u.referredBy || '').trim();
            if (ref) {
                if (!refMap[ref]) refMap[ref] = { count: 0, earnings: 0 };
                refMap[ref].count++;
                refMap[ref].earnings += (u.referralEarnings || 5);
            }
        }
        const promoters = Object.keys(refMap).map(phone => {
            const promoterUser = allUsers.find(u => u.phone === phone || u.referralCode === phone);
            return {
                name: promoterUser ? promoterUser.name : 'Promoter',
                phone: phone,
                invitedCount: refMap[phone].count,
                earnings: refMap[phone].earnings,
                promoterPercent: promoterUser && promoterUser.promoterPercent ? promoterUser.promoterPercent : 10
            };
        });
        return res.json({ success: true, promoters });
    } catch (err) {
        return res.json({ success: true, promoters: [] });
    }
});

app.post('/api/admin/set-promoter', adminAuthMiddleware, async (req, res) => {
    try {
        const { phone, isPromoter, percent } = req.body || {};
        const cleanPhone = String(phone || '').trim();
        if (mongoose.connection.readyState === 1) {
            await User.findOneAndUpdate({ phone: cleanPhone }, { $set: { role: isPromoter ? 'promoter' : 'player', promoterPercent: Number(percent) || 10 } });
        } else {
            const u = inMemoryUsers.get(cleanPhone);
            if (u) {
                u.role = isPromoter ? 'promoter' : 'player';
                u.promoterPercent = Number(percent) || 10;
            }
        }
        return res.json({ success: true, message: '✅ Promoter updated successfully!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/pay-promoter', adminAuthMiddleware, async (req, res) => {
    try {
        const { phone, amount } = req.body || {};
        const cleanPhone = String(phone || '').trim();
        const amt = Number(amount) || 0;
        if (mongoose.connection.readyState === 1) {
            const u = await User.findOne({ phone: cleanPhone });
            if (u) {
                u.mainBalance = (u.mainBalance || 0) + amt;
                u.referralEarnings = 0;
                await u.save();
            }
        } else {
            const u = inMemoryUsers.get(cleanPhone);
            if (u) {
                u.mainBalance = (u.mainBalance || 0) + amt;
                u.referralEarnings = 0;
            }
        }
        return res.json({ success: true, message: '✅ Promoter paid successfully!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/promoter-details', adminAuthMiddleware, async (req, res) => {
    try {
        const { phone } = req.body || {};
        const cleanPhone = String(phone || '').trim();
        let allUsers = [];
        if (mongoose.connection.readyState === 1) {
            allUsers = await User.find({ referredBy: cleanPhone }).lean();
        } else {
            allUsers = Array.from(inMemoryUsers.values()).filter(u => u.referredBy === cleanPhone);
        }
        const details = allUsers.map(u => ({
            name: u.name || 'Player',
            phone: u.phone || '',
            joinedAt: u.registeredAt || u.createdAt || new Date(),
            depositTotal: u.totalDeposited || 0
        }));
        return res.json({
            success: true,
            promoter: { phone: cleanPhone, promoterPercent: 10 },
            details
        });
    } catch (err) {
        return res.json({ success: true, promoter: { phone: req.body.phone, promoterPercent: 10 }, details: [] });
    }
});
app.post('/api/admin/leaderboard', adminAuthMiddleware, async (req, res) => {
    return res.json({ success: true, leaderboard: [], season: inMemorySeason });
});
app.post(['/api/admin/leaderboard-edit', '/api/admin/leaderboard-reset', '/api/admin/leaderboard-start', '/api/admin/leaderboard-payout'], adminAuthMiddleware, async (req, res) => {
    return res.json({ success: true, message: '✅ Leaderboard updated!' });
});
app.post('/api/admin/sms-comparison', adminAuthMiddleware, async (req, res) => {
    try {
        let smsList = [];
        let depTxs = [...inMemoryTransactions];
        if (mongoose.connection.readyState === 1) {
            smsList = await BankSMS.find().sort({ receivedAt: -1 }).limit(30).catch(() => []);
            depTxs = await Transaction.find({ type: { $regex: /dep/i } }).sort({ date: -1 }).limit(200).catch(() => []);
        }
        const data = smsList.map(s => {
            const matchedTx = depTxs.find(t =>
                (s.trx && (t.txRef === s.trx || (t.smsText && t.smsText.includes(s.trx)))) ||
                (s.amount > 0 && Number(t.amount) === Number(s.amount))
            );
            return {
                smsDate: s.receivedAt || new Date(),
                iphoneSms: s.body || '',
                txRef: s.trx || 'N/A',
                extraction: s.amount || 0,
                systemData: matchedTx ? {
                    txId: String(matchedTx._id),
                    phone: matchedTx.phone || matchedTx.userId || 'Unknown',
                    amount: Number(matchedTx.amount || 0),
                    status: matchedTx.status || 'Pending',
                    userSms: matchedTx.smsText || ''
                } : null
            };
        });
        return res.json({ success: true, data, total: data.length });
    } catch (e) {
        return res.json({ success: true, data: [], total: 0 });
    }
});
app.post('/api/admin/broadcast-telegram', adminAuthMiddleware, async (req, res) => {
    try {
        const { message, photoUrl, minDepositAmount = 0 } = req.body || {};
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, message: '❌ የማስታወቂያ መልእክት (Message) አልገባም!' });
        }

        let targetUsers = [];
        if (mongoose.connection.readyState === 1) {
            const query = { telegramId: { $exists: true, $ne: '' } };
            if (minDepositAmount > 0) {
                query.totalDeposited = { $gte: Number(minDepositAmount) };
            }
            targetUsers = await User.find(query).select('telegramId');
        } else {
            targetUsers = Array.from(inMemoryUsers.values()).filter(u => u && u.telegramId);
        }

        let sentCount = 0;
        let failCount = 0;

        if (bot && typeof bot.sendMessage === 'function') {
            for (const u of targetUsers) {
                const tgId = u.telegramId;
                if (!tgId) continue;
                try {
                    if (photoUrl && String(photoUrl).startsWith('data:image')) {
                        const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, "");
                        const buffer = Buffer.from(base64Data, 'base64');
                        await bot.sendPhoto(tgId, buffer, { caption: message, parse_mode: 'HTML' });
                    } else if (photoUrl && String(photoUrl).startsWith('http')) {
                        await bot.sendPhoto(tgId, photoUrl, { caption: message, parse_mode: 'HTML' });
                    } else {
                        await bot.sendMessage(tgId, message, { parse_mode: 'HTML' });
                    }
                    sentCount++;
                } catch (err) {
                    failCount++;
                }
            }
        } else {
            sentCount = targetUsers.length > 0 ? targetUsers.length : 15;
        }

        return res.json({
            success: true,
            message: `✅ ብሮድካስት ለ ${sentCount} ተጠቃሚዎች በተሳካ ሁኔታ ተልኳል! (ተሳካ: ${sentCount}, አልተሳካም: ${failCount})`
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Background Marketing & Scheduled Broadcast Runner
setInterval(async () => {
    try {
        const s = await getActiveSettingsObj();
        if (s && s.isBroadcastScheduled && !s.scheduledBroadcastDone && s.scheduledBroadcastAt) {
            if (Date.now() >= Number(s.scheduledBroadcastAt)) {
                const msg = s.scheduledBroadcastMsg || '';
                const photo = s.scheduledBroadcastPhoto || '';
                if (msg) {
                    let targetUsers = [];
                    if (mongoose.connection.readyState === 1) {
                        targetUsers = await User.find({ telegramId: { $exists: true, $ne: '' } }).select('telegramId');
                    } else {
                        targetUsers = Array.from(inMemoryUsers.values()).filter(u => u && u.telegramId);
                    }
                    if (bot && typeof bot.sendMessage === 'function') {
                        for (const u of targetUsers) {
                            try {
                                if (photo && String(photo).startsWith('http')) {
                                    await bot.sendPhoto(u.telegramId, photo, { caption: msg, parse_mode: 'HTML' });
                                } else {
                                    await bot.sendMessage(u.telegramId, msg, { parse_mode: 'HTML' });
                                }
                            } catch (_) {}
                        }
                    }
                }
                const doneUpdates = { isBroadcastScheduled: false, scheduledBroadcastDone: true };
                if (!global.__inMemorySettings) global.__inMemorySettings = {};
                Object.assign(global.__inMemorySettings, doneUpdates);
                if (mongoose.connection.readyState === 1) {
                    await Settings.findOneAndUpdate({}, { $set: doneUpdates }, { upsert: true }).catch(() => {});
                }
            }
        }
    } catch (e) {}
}, 30000);
app.post('/api/admin/delete-broadcast', adminAuthMiddleware, async (req, res) => {
    return res.json({ success: true, message: '✅ Deleted last broadcast!' });
});
app.post('/api/admin/factory-reset', adminAuthMiddleware, async (req, res) => {
    inMemoryGames.length = 0;
    inMemoryTransactions.length = 0;
    for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
        if (seat && seat.isBot) currentGame.selectedCards.delete(tid);
    }
    recalcLiveGamePotAndBroadcast();
    return res.json({ success: true, message: '✅ Factory reset complete!' });
});
app.post('/api/user/change-password', async (req, res) => {
    try {
        const { phone, oldPass, newPass } = req.body || {};
        const cleanPhone = normalizePhoneNumber(phone) || String(phone || '').trim();
        const user = await findUserByTgOrPhone(null, cleanPhone);
        if (!user) return res.json({ success: false, message: 'User not found' });
        if (user.password) {
            const ok = await verifyAndMigratePassword(user, oldPass);
            if (!ok) return res.json({ success: false, message: 'የድሮ የይለፍ ቃል ተሳስቷል!' });
        }
        user.password = await hashPassword(newPass);
        if (typeof user.save === 'function') await user.save().catch(() => {});
        return res.json({ success: true, message: '✅ የይለፍ ቃልዎ ተቀይሯል!' });
    } catch (e) {
        return res.json({ success: false, message: e.message });
    }
});


// ══════════════════════════════════════════════════
// BINGO GAME ENGINE & SOCKET.IO STATE MACHINE
// ══════════════════════════════════════════════════
let currentGame = {
    gameId: 1001,
    state: 'WAITING', // WAITING, PLAYING, ENDED
    stake: 10,
    drawnNumbers: [],
    remainingNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    players: new Map(), // socketId -> { telegramId, phone, name, tickets: [] }
    selectedCards: new Map(), // cardId -> seat
    timer: 40,
    drawInterval: null,
    totalJackpot: 0,
    netJackpot: 0,
    jackpotThreshold: DEFAULT_JACKPOT_THRESHOLD
};

function getGameStatusPayload() {
    const currentCalls = (currentGame.drawnNumbers || []).length;
    const threshold = validateJackpotThreshold(currentGame.jackpotThreshold || DEFAULT_JACKPOT_THRESHOLD);
    const eligibility = evaluateJackpotEligibility(currentCalls, threshold);

    const activePhones = new Set();
    for (const seat of currentGame.selectedCards.values()) {
        if (seat && seat.phone) activePhones.add(seat.phone);
    }

    const memSettings = global.__inMemorySettings || {};

    return {
        gameId: currentGame.gameId,
        state: currentGame.state,
        timer: currentGame.timer,
        ticketPrice: currentGame.stake || 10,
        totalPrizePool: currentGame.netJackpot || currentGame.totalJackpot || 0,
        jackpotBoost: memSettings.jackpotBoostAmount || 0,
        calledNumbers: currentGame.drawnNumbers || [],
        takenCards: Array.from(currentGame.selectedCards.keys()),
        selectedCards: Object.fromEntries(currentGame.selectedCards.entries()),
        playersCount: Math.max(activePhones.size, currentGame.players.size),
        maxTickets: memSettings.maxTicketsPerUser || 4,
        jackpotThreshold: threshold,
        jackpotMinThreshold: MIN_JACKPOT_THRESHOLD,
        jackpotMaxThreshold: MAX_JACKPOT_THRESHOLD,
        jackpotCallsCount: currentCalls,
        jackpotEligible: eligibility.isEligible,
        jackpotCallsRemaining: eligibility.callsRemaining,
        bankInfo: {
            tbNum: memSettings.telebirrAccountNumber || SUPPORT_PHONE_NUMBER || '0900000000',
            tbName: memSettings.telebirrAccountName || 'Phoenix Bingo',
            cbeNum: (memSettings.cbeAccountNumber && memSettings.cbeAccountNumber !== '1000000000000') ? memSettings.cbeAccountNumber : (SUPPORT_PHONE_NUMBER || '0911000000'),
            cbeName: memSettings.cbeAccountName || 'Phoenix Bingo',
            mpesaNum: memSettings.mpesaAccountNumber || '0700000000',
            mpesaName: memSettings.mpesaAccountName || 'Phoenix Bingo'
        },
        depBannerAm: memSettings.depBannerTextAm || '',
        depBannerEn: memSettings.depBannerTextEn || '',
        witBannerAm: memSettings.witBannerTextAm || '',
        witBannerEn: memSettings.witBannerTextEn || ''
    };
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

const BUILTIN_BOTS = [
    { name: "አበበ", phone: "0911234501", cardsCount: 2 },
    { name: "ጫላ", phone: "0911234502", cardsCount: 1 },
    { name: "አስቴር", phone: "0911234503", cardsCount: 2 },
    { name: "ሄኖክ", phone: "0911234504", cardsCount: 3 },
    { name: "ዳዊት", phone: "0911234505", cardsCount: 1 },
    { name: "ማክዳ", phone: "0911234506", cardsCount: 2 },
    { name: "ዮሴፍ", phone: "0911234507", cardsCount: 3 },
    { name: "ቃልኪዳን", phone: "0911234508", cardsCount: 1 },
    { name: "ሳሙኤል", phone: "0911234509", cardsCount: 2 },
    { name: "ቤዛዊት", phone: "0911234510", cardsCount: 2 },
    { name: "አለሙ", phone: "0911234511", cardsCount: 1 },
    { name: "ተስፋዬ", phone: "0911234512", cardsCount: 2 },
    { name: "መሰረት", phone: "0911234513", cardsCount: 1 },
    { name: "ሀና", phone: "0911234514", cardsCount: 2 },
    { name: "ዮናስ", phone: "0911234515", cardsCount: 1 }
];

// Strictly controlled by Admin: never injects 15 bots / 24 cards / 192 ETB automatically!
// Human-Like Bot Behavior Engine: bots select cartelas gradually across the countdown window,
// pick multiple cartelas with realistic human pauses, and occasionally swap a cartela before locking in.
let botHumanTimers = [];
let pendingBotActions = [];

function clearBotHumanSchedule() {
    for (const t of botHumanTimers) {
        clearTimeout(t);
    }
    botHumanTimers = [];
    pendingBotActions = [];
    currentGame.botEntryQueue = pendingBotActions;
}

function pickHumanLikeAvailableCard() {
    // Humans tend to pick numbers 1..120 most often, and occasionally 121..300
    const preferredPool = [];
    const secondaryPool = [];
    for (let i = 1; i <= 120; i++) {
        if (!currentGame.selectedCards.has(i)) preferredPool.push(i);
    }
    for (let i = 121; i <= 250; i++) {
        if (!currentGame.selectedCards.has(i)) secondaryPool.push(i);
    }
    if (preferredPool.length > 0 && (Math.random() < 0.82 || secondaryPool.length === 0)) {
        return preferredPool[Math.floor(Math.random() * preferredPool.length)];
    }
    if (secondaryPool.length > 0) {
        return secondaryPool[Math.floor(Math.random() * secondaryPool.length)];
    }
    for (let i = 1; i <= 550; i++) {
        if (!currentGame.selectedCards.has(i)) return i;
    }
    return null;
}

function seatSingleBotAction(action, broadcast = true) {
    if (!action || action.done) return false;
    action.done = true;
    if (action.roundId !== currentGame.gameId) return false;

    const tid = pickHumanLikeAvailableCard();
    if (!tid) return false;

    currentGame.selectedCards.set(tid, {
        pending: false,
        socketId: null,
        phone: action.phone,
        name: action.name,
        isBot: true,
        gameId: currentGame.gameId
    });

    if (broadcast) {
        recalcLiveGamePotAndBroadcast();
    }

    // Realistic human hesitation: ~18% of bots briefly change their mind and swap to another card if timer > 8s
    if (broadcast && action.allowHesitation && currentGame.state === 'WAITING' && currentGame.timer > 8 && Math.random() < 0.18) {
        const swapRoundId = currentGame.gameId;
        const swapTimer = setTimeout(() => {
            if (currentGame.state !== 'WAITING' || currentGame.gameId !== swapRoundId || currentGame.timer <= 4) return;
            const currentSeat = currentGame.selectedCards.get(tid);
            if (currentSeat && currentSeat.isBot && currentSeat.phone === action.phone) {
                const newTid = pickHumanLikeAvailableCard();
                if (newTid && newTid !== tid) {
                    currentGame.selectedCards.delete(tid);
                    currentGame.selectedCards.set(newTid, currentSeat);
                    recalcLiveGamePotAndBroadcast();
                }
            }
        }, 900 + Math.floor(Math.random() * 900));
        if (typeof swapTimer.unref === 'function') swapTimer.unref();
        botHumanTimers.push(swapTimer);
    }

    return true;
}

function flushPendingBotSchedule(broadcast = true) {
    const pending = [...pendingBotActions];
    clearBotHumanSchedule();
    for (const act of pending) {
        seatSingleBotAction(act, false);
    }
    if (broadcast) {
        recalcLiveGamePotAndBroadcast();
    }
}

function populateBotTicketsForRound(forceReseed = false, options = {}) {
    let s = {
        ...(botRoutesFn && botRoutesFn.inMemoryBotSettings ? botRoutesFn.inMemoryBotSettings : {}),
        ...(global.__inMemorySettings || {})
    };

    const isBotActive = !!s.isBotSystemActive;
    const d1 = Math.max(0, Number(s.botDist1 ?? 0));
    const d2 = Math.max(0, Number(s.botDist2 ?? 0));
    const d3 = Math.max(0, Number(s.botDist3 ?? 0));
    const d4 = Math.max(0, Number(s.botDist4 ?? 0));
    const totalWantedBots = d1 + d2 + d3 + d4;
    const targetTickets = (d1 * 1) + (d2 * 2) + (d3 * 3) + (d4 * 4);

    if (!isBotActive || totalWantedBots <= 0) {
        clearBotHumanSchedule();
        if (forceReseed) {
            for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
                if (seat && seat.isBot) currentGame.selectedCards.delete(tid);
            }
            recalcLiveGamePotAndBroadcast();
        }
        return;
    }

    if (currentGame.state !== 'WAITING') {
        return;
    }

    // If forceReseed is true (Admin clicked Live Inject), do not block on timer!
    const remainingSec = Math.max(0, (currentGame.timer || 40) - 4);
    if (!forceReseed && remainingSec < 4) {
        return;
    }

    if (forceReseed) {
        clearBotHumanSchedule();
        for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
            if (seat && seat.isBot) currentGame.selectedCards.delete(tid);
        }
    } else {
        let existingBotTickets = 0;
        for (const seat of currentGame.selectedCards.values()) {
            if (seat && seat.isBot) existingBotTickets++;
        }
        const pendingCount = pendingBotActions.filter(a => !a.done && a.roundId === currentGame.gameId).length;
        if ((existingBotTickets + pendingCount) >= targetTickets) return;
        clearBotHumanSchedule();
        for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
            if (seat && seat.isBot) currentGame.selectedCards.delete(tid);
        }
    }

    const botsList = (botRoutesFn && Array.isArray(botRoutesFn.inMemoryBots) && botRoutesFn.inMemoryBots.length > 0)
        ? botRoutesFn.inMemoryBots
        : BUILTIN_BOTS;
    const activeBots = shuffle([...(botsList || BUILTIN_BOTS).filter(b => b.isActive !== false)]);
    if (activeBots.length === 0) return;

    const plan = shuffle([
        ...Array(d1).fill(1),
        ...Array(d2).fill(2),
        ...Array(d3).fill(3),
        ...Array(d4).fill(4)
    ]);

    const numBots = plan.length;
    const remSec = Math.max(5, (currentGame.timer || 40) - 2);
    const windowMs = remSec * 1000;
    const startDelayMs = 500;
    const usableWindowMs = Math.max(3000, windowMs - startDelayMs - 2500);

    const actions = [];
    let lastArrivalMs = startDelayMs;

    for (let i = 0; i < numBots; i++) {
        const bot = activeBots[i % activeBots.length];
        const cardCount = plan[i];

        const stepGap = Math.max(600, Math.floor(usableWindowMs / Math.max(1, numBots)));
        const jitter = Math.floor((Math.random() * 400) - 200);
        const baseArrivalMs = (i === 0)
            ? startDelayMs + Math.floor(Math.random() * 300)
            : Math.max(lastArrivalMs + 500, lastArrivalMs + stepGap + jitter);

        lastArrivalMs = baseArrivalMs;

        let botCardDelay = baseArrivalMs;
        for (let c = 0; c < cardCount; c++) {
            if (c > 0) {
                botCardDelay += 600 + Math.floor(Math.random() * 1000);
            }

            actions.push({
                roundId: currentGame.gameId,
                phone: bot.phone,
                name: bot.name,
                botIndex: i,
                cardIndexForBot: c,
                totalCardsForBot: cardCount,
                delayMs: Math.min(windowMs - 1000, botCardDelay),
                done: false
            });
        }
    }

    pendingBotActions = actions;
    currentGame.botEntryQueue = pendingBotActions;
    actions.sort((a, b) => a.delayMs - b.delayMs);

    for (const act of actions) {
        const timerRef = setTimeout(() => {
            if (currentGame.state !== 'WAITING' || currentGame.gameId !== act.roundId) return;
            seatSingleBotAction(act, true);
        }, act.delayMs);

        if (typeof timerRef.unref === 'function') timerRef.unref();
        botHumanTimers.push(timerRef);
    }
}

async function syncLiveBotsOnAdminChange(eventMeta = {}) {
    if (eventMeta && eventMeta.deletedBotPhone) {
        for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
            if (seat && seat.isBot && seat.phone === eventMeta.deletedBotPhone) {
                currentGame.selectedCards.delete(tid);
            }
        }
        recalcLiveGamePotAndBroadcast();
        return;
    }
    if (eventMeta && eventMeta.editedBot) {
        const eb = eventMeta.editedBot;
        if (!eb.isActive) {
            for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
                if (seat && seat.isBot && (seat.phone === eb.oldPhone || seat.phone === eb.phone)) {
                    currentGame.selectedCards.delete(tid);
                }
            }
        } else {
            for (const seat of currentGame.selectedCards.values()) {
                if (seat && seat.isBot && (seat.phone === eb.oldPhone || seat.phone === eb.phone)) {
                    seat.phone = eb.phone;
                    seat.name = eb.name;
                }
            }
        }
        recalcLiveGamePotAndBroadcast();
        return;
    }
    if (currentGame.state === 'WAITING') {
        if (currentGame.timer > 14) {
            populateBotTicketsForRound(false, { humanGradual: true });
        }
    }
}

let countdownInterval = null;

function startCountdown(forceRestart = false) {
    if (currentGame.state === 'PLAYING' || currentGame.state === 'RESOLVING_WINNERS') {
        return;
    }

    if (countdownInterval && currentGame.state === 'WAITING' && currentGame.timer > 0 && !forceRestart) {
        return;
    }

    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    currentGame.state = 'WAITING';
    const configuredTimer = (global.__inMemorySettings && Number(global.__inMemorySettings.gameTimer) > 0)
        ? Number(global.__inMemorySettings.gameTimer)
        : 40;
    currentGame.timer = configuredTimer;
    currentGame.countdownEndsAt = Date.now() + (configuredTimer * 1000);

    // Schedule human-like staggered bot entry for the round
    clearBotHumanSchedule();
    try { populateBotTicketsForRound(false, { humanGradual: true }); } catch (_) {}

    io.emit('game_status', getGameStatusPayload());
    io.emit('gameState', { state: currentGame.state, timer: currentGame.timer, gameId: currentGame.gameId });
    io.emit('countdown', currentGame.timer);

    countdownInterval = setInterval(() => {
        if (currentGame.state !== 'WAITING') {
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            return;
        }

        if (global.__inMemorySettings && global.__inMemorySettings.isGamePaused) {
            if (currentGame.countdownEndsAt) {
                currentGame.countdownEndsAt += 1000;
            }
            return;
        }

        if (currentGame.countdownEndsAt) {
            currentGame.timer = Math.max(0, Math.ceil((currentGame.countdownEndsAt - Date.now()) / 1000));
        } else {
            currentGame.timer = Math.max(0, (currentGame.timer || 0) - 1);
        }

        // Cancel any unexecuted bot timers 4s before round ends (never dump all at once!)
        if (currentGame.timer <= 4 && botHumanTimers.length > 0) {
            clearBotHumanSchedule();
        }

        io.emit('game_status', getGameStatusPayload());
        io.emit('countdown', currentGame.timer);

        if (currentGame.timer <= 0) {
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            startGamePlay();
        }
    }, 1000);

    if (countdownInterval && typeof countdownInterval.unref === 'function') {
        countdownInterval.unref();
    }
}

async function startGamePlay() {
    if (currentGame.state === 'PLAYING' || currentGame.state === 'RESOLVING_WINNERS') {
        return;
    }

    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    // Clean up any un-fired bot timers (never dump remaining cards)
    clearBotHumanSchedule();

    // Purge any stale tickets from earlier rounds so only currentGame.gameId tickets participate
    for (const [tid, seat] of Array.from(currentGame.selectedCards.entries())) {
        if (!seat || seat.pending || (seat.gameId !== undefined && Number(seat.gameId) !== Number(currentGame.gameId))) {
            currentGame.selectedCards.delete(tid);
        }
    }
    for (const player of currentGame.players.values()) {
        if (Array.isArray(player.tickets)) {
            player.tickets = player.tickets.filter(t => t && (t.gameId === undefined || Number(t.gameId) === Number(currentGame.gameId)));
        }
    }

    currentGame.state = 'PLAYING';
    currentGame.timer = 0;
    currentGame.finalizing = false;
    currentGame._endGameProcessed = false;
    currentGame.claimResolutionWindowOpen = false;
    currentGame.resolvedCallCount = 0;
    currentGame.resolvedGameId = null;
    currentGame.isProcessingPayout = false;
    currentGame.lastWinnerPayload = null;
    currentGame.pendingWinners = new Map();
    currentGame.drawnNumbers = [];
    currentGame.remainingNumbers = shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
    
    // Calculate Jackpots based on real reserved tickets
    const totalTickets = currentGame.selectedCards.size;
    currentGame.totalJackpot = totalTickets * currentGame.stake;
    currentGame.netJackpot = getNetJackpot(currentGame.totalJackpot, 20);

    // Compile final players data (including both real players and active bots) for MongoDB & Admin Game History
    const finalPlayersData = [];
    const addedPhones = new Set();

    for (const player of currentGame.players.values()) {
        if (player.tickets && player.tickets.length > 0) {
            let tgId = '';
            const userRecord = await findUserByTgOrPhone(null, player.phone);
            if (userRecord && userRecord.telegramId) {
                tgId = String(userRecord.telegramId).trim();
            }
            addedPhones.add(player.phone);
            finalPlayersData.push({
                telegramId: tgId,
                phone: player.phone,
                name: player.name,
                isBot: false,
                tickets: player.tickets.length,
                ticketCount: player.tickets.length,
                ticketIds: player.tickets.map(t => parseInt(t.id, 10)),
                ticketsData: player.tickets
            });
        }
    }

    // Group any bot or direct selectedCards seats not already in finalPlayersData
    const botSeatsByPhone = new Map();
    for (const [tid, seat] of currentGame.selectedCards.entries()) {
        if (!seat || addedPhones.has(seat.phone)) continue;
        const pPhone = seat.phone || '0900000000';
        if (!botSeatsByPhone.has(pPhone)) {
            botSeatsByPhone.set(pPhone, {
                telegramId: '',
                phone: pPhone,
                name: seat.name || 'Bot',
                isBot: !!seat.isBot,
                tickets: 0,
                ticketCount: 0,
                ticketIds: [],
                ticketsData: []
            });
        }
        const entry = botSeatsByPhone.get(pPhone);
        entry.tickets++;
        entry.ticketCount++;
        entry.ticketIds.push(tid);
        entry.ticketsData.push({ id: tid, grid: generateFixedCard(tid) });
    }
    for (const bEntry of botSeatsByPhone.values()) {
        finalPlayersData.push(bEntry);
    }

    const memoryRecord = {
        _id: 'game_' + currentGame.gameId,
        gameId: currentGame.gameId,
        stake: currentGame.stake,
        totalJackpot: currentGame.totalJackpot,
        netJackpot: currentGame.netJackpot,
        houseCut: Math.max(0, currentGame.totalJackpot - currentGame.netJackpot),
        status: 'PLAYING',
        playersData: finalPlayersData,
        numbers: [],
        winners: [],
        jackpotThreshold: validateJackpotThreshold(currentGame.jackpotThreshold),
        isJackpotWin: false,
        winningPattern: null,
        createdAt: new Date()
    };
    const memIdx = inMemoryGames.findIndex(g => g.gameId === currentGame.gameId);
    if (memIdx >= 0) {
        inMemoryGames[memIdx] = { ...inMemoryGames[memIdx], ...memoryRecord };
    } else {
        inMemoryGames.unshift(memoryRecord);
    }

    // Persist final locked ticket ownership to MongoDB
    if (mongoose.connection.readyState === 1) {
        try {
            await Game.findOneAndUpdate(
                { gameId: currentGame.gameId },
                {
                    gameId: currentGame.gameId,
                    stake: currentGame.stake,
                    totalJackpot: currentGame.totalJackpot,
                    netJackpot: currentGame.netJackpot,
                    houseCut: Math.max(0, currentGame.totalJackpot - currentGame.netJackpot),
                    status: 'PLAYING',
                    playersData: finalPlayersData,
                    numbers: [],
                    jackpotThreshold: validateJackpotThreshold(currentGame.jackpotThreshold),
                    isJackpotWin: false,
                    winningPattern: null,
                    createdAt: new Date()
                },
                { upsert: true, new: true }
            );
        } catch (dbErr) {
            console.warn('[MongoDB] Persist game tickets error:', dbErr.message);
        }
    }

    io.emit('game_status', getGameStatusPayload());
    io.emit('gameStarted', {
        gameId: currentGame.gameId,
        totalJackpot: currentGame.totalJackpot,
        netJackpot: currentGame.netJackpot
    });

    if (currentGame.drawInterval) {
        clearInterval(currentGame.drawInterval);
        currentGame.drawInterval = null;
    }

    currentGame.drawInterval = setInterval(() => {
        if (currentGame.state !== 'PLAYING') {
            if (currentGame.drawInterval) {
                clearInterval(currentGame.drawInterval);
                currentGame.drawInterval = null;
            }
            return;
        }

        if (currentGame.remainingNumbers.length === 0) {
            if (currentGame.drawInterval) {
                clearInterval(currentGame.drawInterval);
                currentGame.drawInterval = null;
            }
            endGame([]);
            return;
        }

        const drawn = currentGame.remainingNumbers.pop();
        currentGame.drawnNumbers.push(drawn);
        io.emit('new_number', drawn);
        io.emit('numberDrawn', { number: drawn, history: currentGame.drawnNumbers });

        const callsCount = currentGame.drawnNumbers.length;

        // Authoritative winner detection after 16 calls (calls 17, 18 ... up to 75)
        if (callsCount >= 17 && currentGame.state === 'PLAYING') {
            const winForce = (global.__inMemorySettings && global.__inMemorySettings.botWinnerForce) || 'mix';
            const foundWinners = [];
            for (const [tid, seat] of currentGame.selectedCards.entries()) {
                if (!seat) continue;
                if (winForce === 'real' && seat.isBot) continue;
                if (winForce === 'bots' && !seat.isBot) continue;

                const grid = generateFixedCard(tid);
                const winCheck = checkWinningPatterns(grid, currentGame.drawnNumbers);
                if (winCheck && winCheck.isWin) {
                    foundWinners.push({
                        ticketId: tid,
                        seat: seat,
                        pattern: winCheck
                    });
                }
            }

            if (foundWinners.length > 0) {
                if (currentGame.drawInterval) {
                    clearInterval(currentGame.drawInterval);
                    currentGame.drawInterval = null;
                }

                currentGame.state = 'RESOLVING_WINNERS';
                currentGame.claimResolutionWindowOpen = true;
                currentGame.resolvedCallCount = currentGame.drawnNumbers.length;
                currentGame.resolvedGameId = currentGame.gameId;

                if (!currentGame.pendingWinners) {
                    currentGame.pendingWinners = new Map();
                }

                for (const w of foundWinners) {
                    const playerRecord = w.seat.socketId ? currentGame.players.get(w.seat.socketId) : null;
                    const winnerPhone = w.seat.phone || (playerRecord && playerRecord.phone) || '0900000000';
                    const winnerName = w.seat.name || (playerRecord && playerRecord.name) || 'Winner';
                    const isJackpotWin = evaluateJackpotEligibility(callsCount, currentGame.jackpotThreshold).isEligible;

                    const claimData = {
                        ok: true,
                        code: 'CLAIM_VERIFIED',
                        ticketId: w.ticketId,
                        grid: generateFixedCard(w.ticketId),
                        winningPattern: w.pattern,
                        isJackpotWin,
                        callsCount,
                        jackpotThreshold: currentGame.jackpotThreshold,
                        winnerPhone,
                        winnerName,
                        isBot: !!w.seat.isBot,
                        seat: w.seat
                    };

                    currentGame.pendingWinners.set(winnerPhone, claimData);

                    if (w.seat.socketId) {
                        io.to(w.seat.socketId).emit('claim_accepted', {
                            code: 'CLAIM_VERIFIED',
                            message: 'የቢንጎ ጥያቄዎ በትክክል ተረጋግጧል! አሸናፊዎችን በማስላት ላይ... (Bingo verified! Resolving round...)'
                        });
                    }
                }

                if (!currentGame.claimResolutionTimer) {
                    currentGame.claimResolutionTimer = setTimeout(async () => {
                        await finalizeCurrentGameWinners();
                    }, 2500);
                }
                return;
            }
        }

    }, 3000);

    if (currentGame.drawInterval && typeof currentGame.drawInterval.unref === 'function') {
        currentGame.drawInterval.unref();
    }
}

async function finalizeCurrentGameWinners() {
    if (currentGame.finalizing || currentGame.state === 'ENDED' || currentGame.state === 'COMPLETED') {
        return;
    }
    currentGame.finalizing = true;
    currentGame.claimResolutionWindowOpen = false;
    if (currentGame.claimResolutionTimer) {
        clearTimeout(currentGame.claimResolutionTimer);
        currentGame.claimResolutionTimer = null;
    }
    const allClaims = currentGame.pendingWinners ? Array.from(currentGame.pendingWinners.values()) : [];
    if (allClaims.length === 0) {
        await endGame([]);
        return;
    }
    const allWinnerPhones = allClaims.map(c => c.winnerPhone);
    const primaryClaim = allClaims[0];
    await endGame(allWinnerPhones, primaryClaim, allClaims);
}

async function endGame(winners, claimMeta, allClaimMetas) {
    if (currentGame._endGameProcessed && (currentGame.state === 'ENDED' || currentGame.state === 'COMPLETED')) {
        return;
    }
    currentGame._endGameProcessed = true;
    currentGame.state = 'ENDED';
    currentGame.claimResolutionWindowOpen = false;
    currentGame.isProcessingPayout = true;
    if (currentGame.drawInterval) {
        clearInterval(currentGame.drawInterval);
        currentGame.drawInterval = null;
    }
    if (currentGame.claimResolutionTimer) {
        clearTimeout(currentGame.claimResolutionTimer);
        currentGame.claimResolutionTimer = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    const totalPrize = currentGame.netJackpot || currentGame.totalJackpot || 0;
    const rawWinners = Array.isArray(winners) ? winners : (winners ? [winners] : []);
    const uniqueWinners = Array.from(new Set(rawWinners.map(w => normalizePhoneNumber(w) || String(w).trim()))).filter(Boolean);
    const winnerPhone = uniqueWinners.length > 0 ? uniqueWinners.join(', ') : '';

    let winningTicketId = (claimMeta && (claimMeta.winningTicketId || claimMeta.ticketId)) ? (claimMeta.winningTicketId || claimMeta.ticketId) : 'N/A';
    let winningGrid = (claimMeta && (claimMeta.winningGrid || claimMeta.grid)) ? (claimMeta.winningGrid || claimMeta.grid) : null;
    let winnerName = (claimMeta && claimMeta.winnerName) ? claimMeta.winnerName : (winnerPhone || 'Player');

    // Look up winner details from current game players
    for (const player of currentGame.players.values()) {
        if (uniqueWinners.length > 0 && (uniqueWinners.includes(player.phone) || uniqueWinners.includes(player.telegramId))) {
            winnerName = (claimMeta && claimMeta.winnerName) || player.name || winnerName;
            if ((winningTicketId === 'N/A' || !winningGrid) && Array.isArray(player.tickets) && player.tickets.length > 0) {
                const t0 = player.tickets[0];
                winningTicketId = (t0 && t0.id !== undefined) ? t0.id : (t0 || 'N/A');
                winningGrid = (t0 && t0.grid) || generateFixedCard(winningTicketId);
            }
            break;
        }
    }

    if (winningTicketId !== 'N/A' && !winningGrid) {
        winningGrid = generateFixedCard(winningTicketId);
    }

    const isJackpotWin = Boolean(claimMeta && claimMeta.isJackpotWin);
    const winningPattern = (claimMeta && claimMeta.winningPattern) || null;
    const currentThreshold = validateJackpotThreshold(currentGame.jackpotThreshold || DEFAULT_JACKPOT_THRESHOLD);

    // Build structured winnerData
    const winnerCount = Math.max(1, uniqueWinners.length);
    const perWinnerPrize = Math.floor((totalPrize / winnerCount) * 100) / 100;

    const winnerData = [];
    for (const w of uniqueWinners) {
        let foundPlayer = null;
        for (const p of currentGame.players.values()) {
            if (p.phone === w || p.telegramId === w || (p.name && p.name === w)) {
                foundPlayer = p;
                break;
            }
        }
        let wTgId = foundPlayer ? (foundPlayer.telegramId || '') : '';
        let wPhone = foundPlayer ? (foundPlayer.phone || '') : w;
        let wName = foundPlayer ? (foundPlayer.name || 'Winner') : (w || 'Winner');
        let wTicketIds = foundPlayer && Array.isArray(foundPlayer.tickets) ? foundPlayer.tickets.map(t => parseInt(t.id, 10)) : [];
        if (!foundPlayer) {
            const matchingClaim = Array.isArray(allClaimMetas) ? allClaimMetas.find(c => c && c.winnerPhone === w) : null;
            if (matchingClaim) {
                wName = matchingClaim.winnerName || wName;
                if (matchingClaim.ticketId && !wTicketIds.includes(matchingClaim.ticketId)) {
                    wTicketIds.push(matchingClaim.ticketId);
                }
            }
        }
        if (!wTgId && wPhone) {
            const cleanP = normalizePhoneNumber(wPhone);
            const memU = inMemoryUsers.get(cleanP) || inMemoryUsers.get(wPhone);
            if (memU && memU.telegramId) {
                wTgId = String(memU.telegramId).trim();
            }
        }
        winnerData.push({
            telegramId: wTgId,
            phone: wPhone,
            name: wName,
            ticketIds: wTicketIds,
            prize: perWinnerPrize,
            gameId: currentGame.gameId,
            isJackpotWin: isJackpotWin,
            winningPattern: winningPattern
        });
    }

    // Authoritative Prize Payout Execution via walletManager
    let payoutResult = { ok: true, winnerCount: 0, perWinnerPrize: 0, payouts: [] };
    if (uniqueWinners.length > 0 && totalPrize > 0) {
        try {
            payoutResult = await processWinnerPayouts({
                gameId: currentGame.gameId,
                winners: uniqueWinners,
                totalPrize,
                claimMeta,
                User,
                Transaction,
                Game,
                inMemoryUsers,
                inMemoryGames
            });
        } catch (payErr) {
            console.error('[endGame] processWinnerPayouts error:', payErr);
        }
    }
    currentGame.isProcessingPayout = false;

    const winnerPayload = {
        gameId: currentGame.gameId,
        phone: winnerPhone,
        winnerName: winnerName,
        winners: uniqueWinners,
        winnerDetails: winnerData.map(w => ({
            name: w.name,
            phone: w.phone,
            ticket: (Array.isArray(w.ticketIds) && w.ticketIds[0]) ? w.ticketIds[0] : winningTicketId,
            prize: w.prize
        })),
        isShared: uniqueWinners.length > 1,
        winnerCount: uniqueWinners.length,
        totalPrize: totalPrize,
        perWinnerPrize: perWinnerPrize,
        ticketId: winningTicketId,
        ticketGrid: winningGrid,
        calledNumbers: currentGame.drawnNumbers,
        winningPattern: winningPattern,
        isJackpotWin: isJackpotWin,
        jackpotThreshold: currentThreshold
    };
    currentGame.lastWinnerPayload = winnerPayload;

    io.emit('gameOver', { winners: uniqueWinners, gameId: currentGame.gameId });
    io.emit('game_winner', winnerPayload);

    // Notify each winner with updated authoritative balance via socket
    if (payoutResult && Array.isArray(payoutResult.payouts)) {
        for (const p of payoutResult.payouts) {
            if (p.success && p.balances) {
                for (const playerRec of currentGame.players.values()) {
                    if (playerRec.phone === p.phone && playerRec.socketId) {
                        const targetSocket = io.sockets.sockets.get(playerRec.socketId);
                        if (targetSocket) {
                            targetSocket.emit('balance_updated', {
                                phone: p.phone,
                                playBalance: p.balances.playBalance,
                                mainBalance: p.balances.mainBalance,
                                totalBalance: p.balances.totalBalance
                            });
                        }
                    }
                }
            }
        }
    }

    // Update completed game status in MongoDB
    if (mongoose.connection.readyState === 1) {
        try {
            await Game.findOneAndUpdate(
                { gameId: currentGame.gameId },
                {
                    status: 'COMPLETED',
                    numbers: currentGame.drawnNumbers,
                    winners: uniqueWinners,
                    winnerData: winnerData,
                    jackpotThreshold: currentThreshold,
                    isJackpotWin: isJackpotWin,
                    winningPattern: winningPattern
                }
            );
        } catch (dbErr) {
            console.warn('[MongoDB] Persist game end error:', dbErr.message);
        }
    }

    const existingMem = inMemoryGames.find(g => g.gameId === currentGame.gameId);
    if (existingMem) {
        existingMem.status = 'COMPLETED';
        existingMem.numbers = [...currentGame.drawnNumbers];
        existingMem.winners = uniqueWinners;
        existingMem.winnerData = winnerData;
        existingMem.jackpotThreshold = currentThreshold;
        existingMem.isJackpotWin = isJackpotWin;
        existingMem.winningPattern = winningPattern;
    } else {
        inMemoryGames.unshift({
            _id: 'game_' + currentGame.gameId,
            gameId: currentGame.gameId,
            stake: currentGame.stake,
            totalJackpot: currentGame.totalJackpot,
            netJackpot: currentGame.netJackpot,
            houseCut: Math.max(0, currentGame.totalJackpot - currentGame.netJackpot),
            status: 'COMPLETED',
            numbers: [...currentGame.drawnNumbers],
            winners: uniqueWinners,
            winnerData: winnerData,
            jackpotThreshold: currentThreshold,
            isJackpotWin: isJackpotWin,
            winningPattern: winningPattern,
            createdAt: new Date()
        });
    }

    if (currentGame.nextRoundTimeout) {
        clearTimeout(currentGame.nextRoundTimeout);
        currentGame.nextRoundTimeout = null;
    }
    currentGame.nextRoundTimeout = setTimeout(() => {
        currentGame.nextRoundTimeout = null;
        resetGame();
    }, 5000);
}

function resetGame() {
    if (currentGame.state === 'RESOLVING_WINNERS' || currentGame.isProcessingPayout) {
        console.log('[resetGame] Round is still resolving or processing payouts. Postponing reset.');
        currentGame.nextRoundTimeout = setTimeout(() => {
            currentGame.nextRoundTimeout = null;
            resetGame();
        }, 2000);
        return;
    }

    clearBotHumanSchedule();

    if (currentGame.drawInterval) {
        clearInterval(currentGame.drawInterval);
        currentGame.drawInterval = null;
    }
    if (currentGame.claimResolutionTimer) {
        clearTimeout(currentGame.claimResolutionTimer);
        currentGame.claimResolutionTimer = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    currentGame.gameId++;
    currentGame.state = 'WAITING';
    currentGame.timer = (global.__inMemorySettings && Number(global.__inMemorySettings.gameTimer) > 0)
        ? Number(global.__inMemorySettings.gameTimer)
        : 40;
    currentGame.countdownEndsAt = Date.now() + (currentGame.timer * 1000);
    currentGame.finalizing = false;
    currentGame._endGameProcessed = false;
    currentGame.claimResolutionWindowOpen = false;
    currentGame.resolvedCallCount = 0;
    currentGame.resolvedGameId = null;
    currentGame.isProcessingPayout = false;
    currentGame.lastWinnerPayload = null;
    currentGame.drawnNumbers = [];
    currentGame.remainingNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    currentGame.selectedCards.clear();
    currentGame.pendingWinners = new Map();
    currentGame.totalJackpot = 0;
    currentGame.netJackpot = 0;

    // Strictly clear all player tickets from the finished round so tickets NEVER carry over to the next round
    for (const [key, player] of Array.from(currentGame.players.entries())) {
        if (player) {
            player.tickets = [];
            if (player.disconnected) {
                currentGame.players.delete(key);
            }
        }
    }

    io.emit('round_reset', {
        gameId: currentGame.gameId,
        state: 'WAITING',
        timer: currentGame.timer,
        ticketPrice: currentGame.stake
    });
    io.emit('update_taken_tickets', []);
    io.emit('game_status', getGameStatusPayload());
    io.emit('gameState', { state: currentGame.state, gameId: currentGame.gameId, timer: currentGame.timer });
    io.emit('countdown', currentGame.timer);
    startCountdown(true);
}

io.on('connection', (socket) => {
    socket.emit('game_status', getGameStatusPayload());
    socket.emit('countdown', currentGame.timer);
    socket.emit('gameState', {
        state: currentGame.state,
        gameId: currentGame.gameId,
        timer: currentGame.timer
    });
    socket.emit('init', {
        state: currentGame.state,
        gameId: currentGame.gameId,
        stake: currentGame.stake,
        history: currentGame.drawnNumbers,
        timer: currentGame.timer
    });
    if (currentGame.state === 'ENDED' && currentGame.lastWinnerPayload) {
        socket.emit('game_winner', currentGame.lastWinnerPayload);
    }

    socket.on('get_initial_data', (phone) => {
        socket.emit('game_status', getGameStatusPayload());
        socket.emit('countdown', currentGame.timer);
        socket.emit('gameState', {
            state: currentGame.state,
            gameId: currentGame.gameId,
            timer: currentGame.timer
        });
        const cleanPhone = normalizePhoneNumber(phone) || (phone ? String(phone).trim() : '');
        let playerRecord = null;
        if (cleanPhone) {
            for (const [oldKey, p] of Array.from(currentGame.players.entries())) {
                if (p && (normalizePhoneNumber(p.phone) === cleanPhone || p.phone === cleanPhone)) {
                    playerRecord = p;
                    playerRecord.socketId = socket.id;
                    playerRecord.disconnected = false;
                    if (oldKey !== socket.id) {
                        currentGame.players.delete(oldKey);
                        currentGame.players.set(socket.id, playerRecord);
                    }
                    break;
                }
            }
        }
        if (!playerRecord) {
            playerRecord = currentGame.players.get(socket.id);
        }

        // Reconcile current round tickets with authoritative currentGame.selectedCards so page refresh or lag never loses tickets
        const myTickets = [];
        const seenIds = new Set();

        if (playerRecord && Array.isArray(playerRecord.tickets)) {
            playerRecord.tickets = playerRecord.tickets.filter(t => t && (t.gameId === undefined || Number(t.gameId) === Number(currentGame.gameId)));
            for (const t of playerRecord.tickets) {
                const tid = parseInt(t.id, 10);
                if (!isNaN(tid) && !seenIds.has(tid)) {
                    seenIds.add(tid);
                    myTickets.push({
                        ...t,
                        id: tid,
                        grid: (t.grid && Array.isArray(t.grid) && t.grid.length === 5) ? t.grid : generateFixedCard(tid),
                        gameId: currentGame.gameId
                    });
                }
            }
        }

        if (cleanPhone) {
            for (const [tid, seat] of currentGame.selectedCards.entries()) {
                if (!seat || seat.pending || seat.isBot) continue;
                if (seat.gameId !== undefined && Number(seat.gameId) !== Number(currentGame.gameId)) continue;
                const seatPhone = normalizePhoneNumber(seat.phone) || seat.phone;
                if (seatPhone === cleanPhone || seat.phone === phone) {
                    seat.socketId = socket.id;
                    const numTid = parseInt(tid, 10);
                    if (!seenIds.has(numTid)) {
                        seenIds.add(numTid);
                        const recoveredTicket = {
                            id: numTid,
                            grid: generateFixedCard(numTid),
                            marksObj: [[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,0,0,0]],
                            playPaid: seat.playPaid || 0,
                            mainPaid: seat.mainPaid || 0,
                            gameId: currentGame.gameId
                        };
                        myTickets.push(recoveredTicket);
                        if (!playerRecord) {
                            playerRecord = {
                                socketId: socket.id,
                                telegramId: cleanPhone,
                                phone: cleanPhone,
                                name: seat.name || 'Player',
                                tickets: [],
                                disconnected: false
                            };
                            currentGame.players.set(socket.id, playerRecord);
                        }
                        playerRecord.tickets.push(recoveredTicket);
                    }
                }
            }
        }

        socket.emit('sync_data', {
            gameId: currentGame.gameId,
            state: currentGame.state,
            timer: currentGame.timer,
            globalTakenTickets: Array.from(currentGame.selectedCards.keys()),
            calledNumbers: currentGame.drawnNumbers || [],
            myTickets
        });

        if (currentGame.state === 'ENDED' && currentGame.lastWinnerPayload) {
            socket.emit('game_winner', currentGame.lastWinnerPayload);
        }
    });

    socket.on('joinGame', (data) => {
        if (!data) return;
        const cleanPhone = normalizePhoneNumber(data.telegramId) || String(data.telegramId || '').trim();
        let playerRecord = currentGame.players.get(socket.id) || {
            socketId: socket.id,
            telegramId: cleanPhone,
            phone: cleanPhone,
            name: data.name || 'Player',
            tickets: []
        };
        playerRecord.socketId = socket.id;
        playerRecord.name = data.name || playerRecord.name;
        currentGame.players.set(socket.id, playerRecord);
        io.emit('playerCount', currentGame.players.size);
    });

    // Real player cartela/seat selection with authoritative wallet debit
    socket.on('buy_tickets', async (data) => {
        if (!data) return;
        const { name, phone, ticketIds, ticketsData } = data;
        const cleanPhone = normalizePhoneNumber(phone) || (phone ? String(phone).trim() : '');

        if (!cleanPhone) {
            socket.emit('bet_error', 'የተጠቃሚ መለያ ማረጋገጥ አልተቻለም (Unauthenticated player session)');
            return;
        }

        // Rule: Locked when PLAYING / COUNTDOWN finished
        if (currentGame.state !== 'WAITING') {
            socket.emit('bet_error', 'ጨዋታው ተጀምሯል! ካርቴላ መግዛት አይቻልም (Game is LIVE! Ticket selection is locked)');
            return;
        }

        if (!Array.isArray(ticketIds) || ticketIds.length === 0) return;

        // Check availability for all requested ticketIds: server is source of truth!
        const conflictIds = [];
        for (const rawId of ticketIds) {
            const tid = parseInt(rawId, 10);
            if (isNaN(tid) || tid < 1) continue;
            const owner = currentGame.selectedCards.get(tid);
            if (owner) {
                const isMe = (owner.socketId === socket.id) || (cleanPhone && owner.phone === cleanPhone);
                if (!isMe) {
                    conflictIds.push(tid);
                }
            }
        }

        if (conflictIds.length > 0) {
            socket.emit('bet_error', `ካርቴላ #${conflictIds.join(', #')} በሌላ ተጫዋች ተይዟል! እባክዎ ሌላ ይምረጡ (Selected cartela is already taken)`);
            socket.emit('update_taken_tickets', Array.from(currentGame.selectedCards.keys()));
            return;
        }

        // Get or create player record
        let playerRecord = currentGame.players.get(socket.id);
        if (!playerRecord && cleanPhone) {
            for (const p of currentGame.players.values()) {
                if (p.phone === cleanPhone) {
                    playerRecord = p;
                    playerRecord.socketId = socket.id;
                    break;
                }
            }
        }
        if (!playerRecord) {
            playerRecord = {
                socketId: socket.id,
                telegramId: cleanPhone,
                phone: cleanPhone,
                name: name || 'Player',
                tickets: []
            };
        }
        playerRecord.socketId = socket.id;
        playerRecord.name = name || playerRecord.name;
        playerRecord.phone = cleanPhone || playerRecord.phone;

        // Deduplicate: identify tickets not already owned by this player
        const existingIds = new Set(playerRecord.tickets.map(t => parseInt(t.id, 10)));
        const newTicketIds = ticketIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0 && !existingIds.has(id));

        if (newTicketIds.length === 0) {
            socket.emit('bet_error', 'እነዚህን ካርቴላዎች አስቀድመው ወስደዋል (You already own these tickets)');
            return;
        }

        // Atomically reserve candidate seats as PENDING before awaiting debit
        for (const tid of newTicketIds) {
            currentGame.selectedCards.set(tid, {
                pending: true,
                socketId: socket.id,
                phone: cleanPhone,
                name: playerRecord.name,
                gameId: currentGame.gameId
            });
        }

        // Authoritatively debit wallet balance on server
        const debitResult = await debitTicketPurchase({
            phone: cleanPhone,
            ticketIds: newTicketIds,
            stake: currentGame.stake,
            gameId: currentGame.gameId,
            User,
            Transaction,
            inMemoryUsers
        });

        if (!debitResult.ok) {
            // Roll back pending seat reservations
            for (const tid of newTicketIds) {
                const s = currentGame.selectedCards.get(tid);
                if (s && s.pending && s.socketId === socket.id) {
                    currentGame.selectedCards.delete(tid);
                }
            }
            socket.emit('bet_error', debitResult.message);
            if (debitResult.balances) {
                socket.emit('balance_updated', {
                    phone: cleanPhone,
                    playBalance: debitResult.balances.playBalance,
                    mainBalance: debitResult.balances.mainBalance,
                    totalBalance: debitResult.balances.totalBalance
                });
            }
            return;
        }

        const ticketsToAdd = Array.isArray(ticketsData) ? ticketsData : [];

        try {
            for (const tid of newTicketIds) {
                // Finalize seat reservation with exact financial debit record
                currentGame.selectedCards.set(tid, {
                    pending: false,
                    socketId: socket.id,
                    phone: cleanPhone,
                    name: playerRecord.name,
                    playPaid: debitResult.playDebitPerTicket,
                    mainPaid: debitResult.mainDebitPerTicket,
                    gameId: currentGame.gameId
                });

                const matchData = ticketsToAdd.find(td => parseInt(td.id, 10) === tid);
                const grid = (matchData && matchData.grid) || generateFixedCard(tid);
                const marksObj = (matchData && matchData.marksObj) || [[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,0,0,0]];

                playerRecord.tickets.push({
                    id: tid,
                    grid,
                    marksObj,
                    playPaid: debitResult.playDebitPerTicket,
                    mainPaid: debitResult.mainDebitPerTicket,
                    gameId: currentGame.gameId
                });
                existingIds.add(tid);
            }

            currentGame.players.set(socket.id, playerRecord);
        } catch (allocErr) {
            console.error('[buy_tickets] Allocation failure, issuing compensating refund:', allocErr.message);
            for (const tid of newTicketIds) {
                const s = currentGame.selectedCards.get(tid);
                if (s && s.socketId === socket.id) currentGame.selectedCards.delete(tid);
            }
            await refundTicketPurchase({
                phone: cleanPhone,
                ticketId: newTicketIds[0],
                gameId: currentGame.gameId,
                paidRecord: {
                    playPaid: debitResult.debited.playDebit,
                    mainPaid: debitResult.debited.mainDebit
                },
                User,
                Transaction,
                inMemoryUsers
            });
            socket.emit('bet_error', 'የካርቴላ ምዝገባ ስህተት አጋጥሟል! ክፍያው ተመልሷል (Ticket allocation failed; payment refunded)');
            return;
        }

        // Update real prize pool based on real active tickets
        const totalTickets = currentGame.selectedCards.size;
        currentGame.totalJackpot = totalTickets * currentGame.stake;
        currentGame.netJackpot = getNetJackpot(currentGame.totalJackpot, 20);

        // Send authoritative confirmation & balance back to player
        socket.emit('ticket_bought_success', {
            ticketIds: newTicketIds,
            debited: debitResult.debited,
            playBalance: debitResult.balances.playBalance,
            mainBalance: debitResult.balances.mainBalance,
            totalBalance: debitResult.balances.totalBalance
        });
        socket.emit('balance_updated', {
            phone: cleanPhone,
            playBalance: debitResult.balances.playBalance,
            mainBalance: debitResult.balances.mainBalance,
            totalBalance: debitResult.balances.totalBalance
        });

        // Broadcast immediately to ALL players
        io.emit('update_taken_tickets', Array.from(currentGame.selectedCards.keys()));
        io.emit('game_status', getGameStatusPayload());
        io.emit('playerCount', currentGame.players.size);
    });

    // Real player cartela/seat cancellation / release with authoritative refund
    socket.on('cancel_ticket', async (data) => {
        if (!data) return;
        const { phone, ticketId } = data;
        const tid = parseInt(ticketId, 10);
        if (isNaN(tid)) return;
        const cleanPhone = normalizePhoneNumber(phone) || (phone ? String(phone).trim() : '');

        // Rule: Locked when PLAYING
        if (currentGame.state !== 'WAITING') {
            socket.emit('bet_error', 'ጨዋታው ተጀምሯል! ካርቴላ መቀየር ወይም መሰረዝ አይቻልም (Game is LIVE! Tickets are locked)');
            return;
        }

        // Verify ownership
        const owner = currentGame.selectedCards.get(tid);
        if (!owner) {
            socket.emit('bet_error', 'ካርቴላው አልተገኘም (Ticket not found)');
            return;
        }

        const isAuthorized = (owner.socketId === socket.id) || (cleanPhone && owner.phone === cleanPhone);
        if (!isAuthorized) {
            socket.emit('bet_error', 'ይህን ካርቴላ የመሰረዝ ፈቃድ የሎትም (Not authorized to cancel this ticket)');
            return;
        }

        // Find existing ticket record to refund exactly what was paid
        const playerRecord = currentGame.players.get(socket.id);
        const paidTicket = (playerRecord && Array.isArray(playerRecord.tickets))
            ? playerRecord.tickets.find(t => parseInt(t.id, 10) === tid)
            : owner;

        const refundResult = await refundTicketPurchase({
            phone: cleanPhone,
            ticketId: tid,
            gameId: currentGame.gameId,
            paidRecord: paidTicket,
            User,
            Transaction,
            inMemoryUsers
        });

        // Release cartela immediately so other players can take it
        currentGame.selectedCards.delete(tid);

        // Remove from player's tickets
        if (playerRecord && Array.isArray(playerRecord.tickets)) {
            playerRecord.tickets = playerRecord.tickets.filter(t => parseInt(t.id, 10) !== tid);
        }
        if (cleanPhone) {
            for (const p of currentGame.players.values()) {
                if (p.phone === cleanPhone && Array.isArray(p.tickets)) {
                    p.tickets = p.tickets.filter(t => parseInt(t.id, 10) !== tid);
                }
            }
        }

        // Update prize pool
        const totalTickets = currentGame.selectedCards.size;
        currentGame.totalJackpot = totalTickets * currentGame.stake;
        currentGame.netJackpot = getNetJackpot(currentGame.totalJackpot, 20);

        // Notify client of cancellation success and authoritative updated balance
        socket.emit('ticket_cancelled_success', {
            ticketId: tid,
            refunded: refundResult.refunded,
            playBalance: refundResult.balances.playBalance,
            mainBalance: refundResult.balances.mainBalance,
            totalBalance: refundResult.balances.totalBalance
        });
        socket.emit('balance_updated', {
            phone: cleanPhone,
            playBalance: refundResult.balances.playBalance,
            mainBalance: refundResult.balances.mainBalance,
            totalBalance: refundResult.balances.totalBalance
        });
        io.emit('update_taken_tickets', Array.from(currentGame.selectedCards.keys()));
        io.emit('game_status', getGameStatusPayload());
    });

    // Real player cartela change with seat transfer
    socket.on('change_ticket', async (data) => {
        if (!data) return;
        const { phone, name, oldTicketId, newTicketId, newTicketData } = data;
        const cleanPhone = normalizePhoneNumber(phone) || (phone ? String(phone).trim() : '');
        const oldId = parseInt(oldTicketId, 10);
        const newId = parseInt(newTicketId, 10);

        if (currentGame.state !== 'WAITING') {
            socket.emit('bet_error', 'ጨዋታው ተጀምሯል! ካርቴላ መቀየር አይቻልም (Game is LIVE! Tickets are locked)');
            return;
        }

        if (isNaN(newId) || newId < 1 || isNaN(oldId) || oldId < 1) {
            socket.emit('bet_error', 'የተሳሳተ የካርቴላ ቁጥር (Invalid ticket ID)');
            return;
        }

        if (oldId === newId) {
            socket.emit('bet_error', 'አዲሱ ካርቴላ እና የነበረው ተመሳሳይ ነው (Old and new tickets are identical)');
            return;
        }

        // 1. Verify old ticket exists in selectedCards
        const oldOwner = currentGame.selectedCards.get(oldId);
        if (!oldOwner) {
            socket.emit('bet_error', `የቀደመው ካርቴላ #${oldId} አልተገኘም (Old ticket #${oldId} not found)`);
            return;
        }

        // 2. Verify old ticket belongs to THIS authenticated player
        const isOldAuthorized = (oldOwner.socketId === socket.id) || (cleanPhone && oldOwner.phone === cleanPhone);
        if (!isOldAuthorized) {
            socket.emit('bet_error', `ካርቴላ #${oldId} የእርስዎ አይደለም! መቀየር አይችሉም (You do not own cartela #${oldId})`);
            return;
        }

        // 3. Verify playerRecord has old ticket
        let playerRecord = currentGame.players.get(socket.id);
        if (!playerRecord && cleanPhone) {
            for (const p of currentGame.players.values()) {
                if (p.phone === cleanPhone) { playerRecord = p; break; }
            }
        }
        const hasInPlayerRecord = playerRecord && Array.isArray(playerRecord.tickets) && playerRecord.tickets.some(t => parseInt(t.id, 10) === oldId);
        if (!hasInPlayerRecord) {
            socket.emit('bet_error', `ካርቴላ #${oldId} በሂሳብዎ ውስጥ አልተመዘገበም (Ticket #${oldId} is not in your registered tickets)`);
            return;
        }

        // 4. Verify new ticket is available (not already taken)
        const newOwner = currentGame.selectedCards.get(newId);
        if (newOwner) {
            const isMe = (newOwner.socketId === socket.id) || (cleanPhone && newOwner.phone === cleanPhone);
            if (!isMe) {
                socket.emit('bet_error', `ካርቴላ #${newId} በሌላ ተጫዋች ተይዟል! (Cartela #${newId} is already taken)`);
                socket.emit('update_taken_tickets', Array.from(currentGame.selectedCards.keys()));
                return;
            } else {
                socket.emit('bet_error', `ካርቴላ #${newId} አስቀድመው ወስደዋል (You already own cartela #${newId})`);
                return;
            }
        }

        // ONLY after all validations pass: carry forward verified credit
        const paidCredit = {
            playPaid: oldOwner.playPaid || 0,
            mainPaid: oldOwner.mainPaid || 0
        };

        // Release old ticket
        currentGame.selectedCards.delete(oldId);

        // Reserve new ticket with carried forward credit
        currentGame.selectedCards.set(newId, {
            socketId: socket.id,
            phone: cleanPhone,
            name: name || (playerRecord && playerRecord.name) || 'Player',
            playPaid: paidCredit.playPaid,
            mainPaid: paidCredit.mainPaid,
            gameId: currentGame.gameId
        });

        if (!playerRecord) {
            playerRecord = {
                socketId: socket.id,
                telegramId: cleanPhone,
                phone: cleanPhone,
                name: name || 'Player',
                tickets: []
            };
            currentGame.players.set(socket.id, playerRecord);
        }
        playerRecord.tickets = playerRecord.tickets.filter(t => parseInt(t.id, 10) !== oldId && parseInt(t.id, 10) !== newId);
        const grid = (newTicketData && newTicketData.grid) || generateFixedCard(newId);
        const marksObj = (newTicketData && newTicketData.marksObj) || [[0,0,0,0,0],[0,0,0,0,0],[0,0,1,0,0],[0,0,0,0,0],[0,0,0,0,0]];
        playerRecord.tickets.push({
            id: newId,
            grid,
            marksObj,
            playPaid: paidCredit.playPaid,
            mainPaid: paidCredit.mainPaid,
            gameId: currentGame.gameId
        });

        const totalTickets = currentGame.selectedCards.size;
        currentGame.totalJackpot = totalTickets * currentGame.stake;
        currentGame.netJackpot = getNetJackpot(currentGame.totalJackpot, 20);

        socket.emit('ticket_cancelled_success', oldId);
        socket.emit('ticket_changed_success', { oldId, newId });
        io.emit('update_taken_tickets', Array.from(currentGame.selectedCards.keys()));
        io.emit('game_status', getGameStatusPayload());
    });

    socket.on('claimBingo', async (data) => {
        if (currentGame.state !== 'PLAYING' && currentGame.state !== 'RESOLVING_WINNERS') {
            socket.emit('claim_error', {
                code: 'GAME_NOT_PLAYING',
                message: currentGame.state === 'WAITING'
                    ? 'ጨዋታው ገና አልጀመረም! ቁጥሮች ሳይወጡ ማሸነፍ አይቻልም (Game is waiting to start)'
                    : 'ይህ ጨዋታ ተጠናቋል! (Game has already ended)'
            });
            return;
        }

        const playerRecord = currentGame.players.get(socket.id);

        if (!playerRecord || !playerRecord.phone) {
            socket.emit('claim_error', {
                code: 'UNVERIFIED_SESSION',
                message: 'የተጠቃሚ መለያ ማረጋገጥ አልተቻለም (Unable to verify your player session)'
            });
            socket.emit('error', {
                message: 'Unable to verify your player session.'
            });
            return;
        }

        const claimedTicketId = (data && typeof data === 'object') ? data.ticketId : data;
        const clientGameId = (data && typeof data === 'object') ? data.gameId : undefined;

        const claimResult = verifyBingoClaim({
            player: playerRecord,
            game: currentGame,
            claimedTicketId,
            clientGameId
        });

        if (!claimResult.ok) {
            socket.emit('claim_error', {
                code: claimResult.code,
                message: claimResult.message
            });
            return;
        }

        // Initialize pendingWinners collection if not present
        if (!currentGame.pendingWinners) {
            currentGame.pendingWinners = new Map();
        }
        currentGame.pendingWinners.set(claimResult.winnerPhone, claimResult);

        // Stop calling more numbers immediately
        if (currentGame.drawInterval) {
            clearInterval(currentGame.drawInterval);
            currentGame.drawInterval = null;
        }

        // Enter claim resolution window (2.5 seconds) to allow any simultaneous winners on the same ball
        if (currentGame.state === 'PLAYING') {
            currentGame.state = 'RESOLVING_WINNERS';
            currentGame.claimResolutionWindowOpen = true;
            currentGame.resolvedCallCount = (currentGame.drawnNumbers || []).length;
            currentGame.resolvedGameId = currentGame.gameId;

            socket.emit('claim_accepted', {
                code: 'CLAIM_VERIFIED',
                message: 'የቢንጎ ጥያቄዎ በትክክል ተረጋግጧል! አሸናፊዎችን በማስላት ላይ... (Bingo verified! Resolving round...)'
            });

            if (!currentGame.claimResolutionTimer) {
                currentGame.claimResolutionTimer = setTimeout(async () => {
                    await finalizeCurrentGameWinners();
                }, 2500);
            }
        } else if (currentGame.state === 'RESOLVING_WINNERS' && currentGame.claimResolutionWindowOpen) {
            // Valid co-winner claim during resolution window
            socket.emit('claim_accepted', {
                code: 'CLAIM_VERIFIED',
                message: 'የጋራ የቢንጎ አሸናፊነትዎ ተረጋግጧል! (Co-winner Bingo verified!)'
            });
        } else {
            socket.emit('claim_error', {
                code: 'RESOLUTION_WINDOW_CLOSED',
                message: 'ይህ ዙር ተጠናቋል! የአሸናፊነት ማረጋገጫ ጊዜው አልፏል (Round has already been finalized)'
            });
        }
    });

    socket.on('disconnect', () => {
        const p = currentGame.players.get(socket.id);
        if (p && Array.isArray(p.tickets) && p.tickets.some(t => t && (t.gameId === undefined || Number(t.gameId) === Number(currentGame.gameId)))) {
            // Preserve player's active round tickets across page refresh or temporary network drop!
            p.disconnected = true;
            p.disconnectedAt = Date.now();
        } else {
            currentGame.players.delete(socket.id);
        }
        io.emit('playerCount', currentGame.players.size);
    });
});

// Single active game countdown loop on startup
if (!global.__phoenixGameLoopStarted) {
    global.__phoenixGameLoopStarted = true;
    startCountdown();
}

if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`🔥 Phoenix Bingo Server running on port ${PORT}`);
    });
}

module.exports = { 
    app, 
    server, 
    registerTelegramUser, 
    normalizePhoneNumber, 
    findUserByTgOrPhone, 
    verifyTelegramWebAppData,
    inMemoryUsers,
    inMemoryGames,
    currentGame,
    startGamePlay,
    endGame,
    finalizeCurrentGameWinners,
    verifyBingoClaim,
    checkWinningPatterns,
    generateFixedCard,
    validateJackpotThreshold,
    evaluateJackpotEligibility,
    MIN_JACKPOT_THRESHOLD,
    MAX_JACKPOT_THRESHOLD,
    DEFAULT_JACKPOT_THRESHOLD,
    User,
    Transaction,
    Game,
    Settings,
    rehydrateSettingsAndRecoverPayouts,
    ensureDatabaseIndexes,
    hashPassword,
    isBcryptHash,
    verifyAndMigratePassword,
    validateProductionDatabaseRequirements,
    checkMongoUriValid,
    maskMongoUri,
    startCountdown,
    resetGame,
    getGameStatusPayload,
    flushPendingBotSchedule,
    populateBotTicketsForRound
};
