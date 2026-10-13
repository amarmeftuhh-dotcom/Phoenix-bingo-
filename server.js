const express = require('express');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
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
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-secret, x-webhook-secret');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    userId: { type: String, index: true },
    type: String, // DEPOSIT, WITHDRAWAL, BET, WIN, BONUS, REFUND
    amount: Number,
    balanceAfter: Number,
    date: { type: Date, default: Date.now, index: true },
    note: String
});

const SettingsSchema = new mongoose.Schema({
    gameStake: { type: Number, default: 10 },
    jackpotThreshold: { type: Number, default: 16 },
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
            const savedSettings = await Settings.findOne();
            if (savedSettings) {
                if (savedSettings.jackpotThreshold) {
                    currentGame.jackpotThreshold = validateJackpotThreshold(savedSettings.jackpotThreshold);
                }
                if (savedSettings.gameStake && Number(savedSettings.gameStake) > 0) {
                    currentGame.stake = Number(savedSettings.gameStake);
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
const adminAuthMiddleware = (req, res, next) => {
    const adminPass = req.headers['x-admin-pass'] || 
                      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) || 
                      (req.body && (req.body.adminPass || req.body.password));
    if (!ADMIN_DEFAULT_PASS || !adminPass) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Admin credentials required' });
    }
    try {
        const bufA = Buffer.from(String(adminPass));
        const bufB = Buffer.from(String(ADMIN_DEFAULT_PASS));
        if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
            return next();
        }
    } catch (_) {}
    if (adminPass === ADMIN_DEFAULT_PASS) {
        return next();
    }
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid admin credentials' });
};

const botRoutesFn = typeof botRoutes === 'function' ? botRoutes(Settings, async () => {}, adminAuthMiddleware) : botRoutes;
app.use('/api/bot', adminAuthMiddleware, botRoutesFn);

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
        const user = await findUserByTgOrPhone(verifiedTgId, null);

        if (!user || !user.phone) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not registered. Please start the bot in Telegram and share your phone number.' 
            });
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
        if (ADMIN_DEFAULT_PASS && adminPass && adminPass === ADMIN_DEFAULT_PASS) {
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

        // Authoritative server-side reservation lookup for this authenticated user only
        let myTickets = [];
        for (const player of currentGame.players.values()) {
            const pPhone = normalizePhoneNumber(player.phone);
            const pTg = player.telegramId ? String(player.telegramId).trim() : '';
            if (pPhone === cleanPhone || player.phone === user.phone || (pTg && pTg === verifiedTgId)) {
                myTickets = Array.isArray(player.tickets) ? player.tickets : [];
                break;
            }
        }

        return res.json({
            success: true,
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
        if (!ADMIN_DEFAULT_PASS || adminPass !== ADMIN_DEFAULT_PASS) {
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
                totalJackpot: doc.totalJackpot || 0,
                netJackpot: doc.netJackpot || 0,
                houseCut: doc.houseCut || Math.max(0, (doc.totalJackpot || 0) - (doc.netJackpot || 0)),
                playersData: doc.playersData || [],
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
        if (!ADMIN_DEFAULT_PASS || adminPass !== ADMIN_DEFAULT_PASS) {
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
        if (!ADMIN_DEFAULT_PASS || adminPass !== ADMIN_DEFAULT_PASS) {
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
        if (!ADMIN_DEFAULT_PASS || adminPass !== ADMIN_DEFAULT_PASS) {
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

// Admin Live Stats API for Admin Dashboard
app.post('/api/admin/live-stats', async (req, res) => {
    try {
        const { adminPass } = req.body || {};
        if (!ADMIN_DEFAULT_PASS || adminPass !== ADMIN_DEFAULT_PASS) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        const currentCalls = (currentGame.drawnNumbers || []).length;
        const threshold = validateJackpotThreshold(currentGame.jackpotThreshold || DEFAULT_JACKPOT_THRESHOLD);
        const eligibility = evaluateJackpotEligibility(currentCalls, threshold);

        let totalUsers = inMemoryUsers.size;
        if (mongoose.connection.readyState === 1) {
            totalUsers = await User.countDocuments();
        }

        return res.json({
            success: true,
            totalUsers,
            dailyActive: inMemoryUsers.size,
            realPlayersCount: currentGame.players.size,
            botPlayersCount: 0,
            gameState: currentGame.state,
            currentJackpot: currentGame.totalJackpot || 0,
            netJackpot: currentGame.netJackpot || 0,
            settings: {
                ticketPrice: currentGame.stake || 10,
                jackpotThreshold: threshold,
                jackpotMinThreshold: MIN_JACKPOT_THRESHOLD,
                jackpotMaxThreshold: MAX_JACKPOT_THRESHOLD,
                jackpotCallsCount: currentCalls,
                jackpotEligible: eligibility.isEligible,
                jackpotCallsRemaining: eligibility.callsRemaining,
                gameTimer: currentGame.timer || 40,
                maxTicketsPerUser: 4
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Admin Update Settings
app.post('/api/admin/update-settings', async (req, res) => {
    try {
        const { adminPass, jackpotThreshold, ticketPrice, gameTimer } = req.body || {};
        if (!ADMIN_DEFAULT_PASS || adminPass !== ADMIN_DEFAULT_PASS) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        if (jackpotThreshold !== undefined) {
            currentGame.jackpotThreshold = validateJackpotThreshold(jackpotThreshold);
        }
        if (ticketPrice !== undefined && Number(ticketPrice) > 0) {
            currentGame.stake = Number(ticketPrice);
        }
        if (gameTimer !== undefined && Number(gameTimer) > 0) {
            currentGame.timer = Number(gameTimer);
        }

        if (mongoose.connection.readyState === 1) {
            await Settings.findOneAndUpdate({}, {
                jackpotThreshold: currentGame.jackpotThreshold,
                gameStake: currentGame.stake
            }, { upsert: true });
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
// BINGO GAME ENGINE & SOCKET.IO STATE MACHINE
// ══════════════════════════════════════════════════
let currentGame = {
    gameId: 1001,
    state: 'WAITING', // WAITING, PLAYING, ENDED
    stake: 10,
    drawnNumbers: [],
    remainingNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
    players: new Map(), // socketId -> { telegramId, phone, name, tickets: [] }
    selectedCards: new Map(), // cardId -> socketId
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

    return {
        gameId: currentGame.gameId,
        state: currentGame.state,
        timer: currentGame.timer,
        ticketPrice: currentGame.stake || 10,
        totalPrizePool: currentGame.totalJackpot || 0,
        jackpotBoost: 0,
        calledNumbers: currentGame.drawnNumbers || [],
        playersCount: currentGame.players.size,
        maxTickets: 4,
        jackpotThreshold: threshold,
        jackpotMinThreshold: MIN_JACKPOT_THRESHOLD,
        jackpotMaxThreshold: MAX_JACKPOT_THRESHOLD,
        jackpotCallsCount: currentCalls,
        jackpotEligible: eligibility.isEligible,
        jackpotCallsRemaining: eligibility.callsRemaining,
        bankInfo: {
            tbNum: SUPPORT_PHONE_NUMBER,
            tbName: 'Phoenix Bingo',
            cbeNum: '1000...',
            cbeName: 'Phoenix Bingo',
            mpesaNum: '0700000000',
            mpesaName: 'Phoenix Bingo'
        }
    };
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
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
    currentGame.timer = 40;
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

        currentGame.timer = Math.max(0, (currentGame.timer || 0) - 1);
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

    currentGame.state = 'PLAYING';
    currentGame.timer = 0;
    currentGame.finalizing = false;
    currentGame._endGameProcessed = false;
    currentGame.claimResolutionWindowOpen = false;
    currentGame.resolvedCallCount = 0;
    currentGame.resolvedGameId = null;
    currentGame.isProcessingPayout = false;
    currentGame.pendingWinners = new Map();
    currentGame.drawnNumbers = [];
    currentGame.remainingNumbers = shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
    
    // Calculate Jackpots based on real reserved tickets
    const totalTickets = currentGame.selectedCards.size;
    currentGame.totalJackpot = totalTickets * currentGame.stake;
    currentGame.netJackpot = getNetJackpot(currentGame.totalJackpot, 20);

    // Compile final real players data for MongoDB persistence
    const finalPlayersData = [];
    for (const player of currentGame.players.values()) {
        if (player.tickets && player.tickets.length > 0) {
            let tgId = '';
            const userRecord = await findUserByTgOrPhone(null, player.phone);
            if (userRecord && userRecord.telegramId) {
                tgId = String(userRecord.telegramId).trim();
            }
            finalPlayersData.push({
                telegramId: tgId,
                phone: player.phone,
                name: player.name,
                ticketCount: player.tickets.length,
                ticketIds: player.tickets.map(t => parseInt(t.id, 10)),
                ticketsData: player.tickets
            });
        }
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

    let winningTicketId = (claimMeta && claimMeta.winningTicketId) ? claimMeta.winningTicketId : 'N/A';
    let winningGrid = (claimMeta && claimMeta.winningGrid) ? claimMeta.winningGrid : null;
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

    io.emit('gameOver', { winners: uniqueWinners, gameId: currentGame.gameId });
    io.emit('game_winner', {
        phone: winnerPhone,
        winnerName: winnerName,
        winners: uniqueWinners,
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
    });

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
    currentGame.timer = 40;
    currentGame.finalizing = false;
    currentGame._endGameProcessed = false;
    currentGame.claimResolutionWindowOpen = false;
    currentGame.resolvedCallCount = 0;
    currentGame.resolvedGameId = null;
    currentGame.isProcessingPayout = false;
    currentGame.drawnNumbers = [];
    currentGame.remainingNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    currentGame.selectedCards.clear();
    currentGame.pendingWinners = new Map();
    currentGame.totalJackpot = 0;
    currentGame.netJackpot = 0;

    for (const player of currentGame.players.values()) {
        player.tickets = [];
    }

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
            for (const p of currentGame.players.values()) {
                if (p.phone === cleanPhone) {
                    playerRecord = p;
                    playerRecord.socketId = socket.id;
                    break;
                }
            }
        }
        if (!playerRecord) {
            playerRecord = currentGame.players.get(socket.id);
        }
        const myTickets = (playerRecord && playerRecord.tickets) || [];
        socket.emit('sync_data', {
            globalTakenTickets: Array.from(currentGame.selectedCards.keys()),
            calledNumbers: currentGame.drawnNumbers || [],
            myTickets
        });
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
        currentGame.players.delete(socket.id);
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
    getGameStatusPayload
};
