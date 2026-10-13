/**
 * Pure rules for referral caps, bonus payout limits, cooldown blocks,
 * weekly ranks, card fees, bot ramp, and pending-deposit cleanup.
 */

const REFERRAL_DAILY_CAP = 5;
const REFERRAL_IP_DAILY_CAP = 3;
const REFERRAL_FINGERPRINT_DAILY_CAP = 2;
const CARD_PRICE = 10;
const CARD_REG_FEE = 2;
const CARD_POT_SHARE = CARD_PRICE - CARD_REG_FEE;
const TX_HISTORY_DAYS = 14;
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

const DEFAULT_BOT_SLOTS = [
    { start: '00:00', end: '03:00', min: 8, max: 12, count: 10 },
    { start: '03:00', end: '06:00', min: 10, max: 14, count: 12 },
    { start: '06:00', end: '09:00', min: 15, max: 20, count: 18 },
    { start: '09:00', end: '12:00', min: 20, max: 28, count: 25 },
    { start: '12:00', end: '15:00', min: 26, max: 34, count: 30 },
    { start: '15:00', end: '18:00', min: 30, max: 40, count: 35 },
    { start: '18:00', end: '21:00', min: 40, max: 50, count: 45 },
    { start: '21:00', end: '24:00', min: 16, max: 24, count: 20 }
];

const SEASON_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BOT_MIN = 10;
const DEFAULT_BOT_MAX = 40;
const DEFAULT_BOT_STEP_SECONDS = 5;

function evaluateReferralAttempt(stats) {
    const hasReferral = !!stats.hasReferral;
    if (!hasReferral) return { ok: true, reason: '' };

    if (!stats.hasFingerprint) return { ok: false, reason: 'fingerprint' };
    if (stats.sameFingerprintOnLink) return { ok: false, reason: 'fingerprint' };
    if ((stats.fingerprintCount || 0) >= REFERRAL_FINGERPRINT_DAILY_CAP) return { ok: false, reason: 'fingerprint' };
    if ((stats.ipCount || 0) >= REFERRAL_IP_DAILY_CAP) return { ok: false, reason: 'ip' };
    if ((stats.linkCount || 0) >= REFERRAL_DAILY_CAP) return { ok: false, reason: 'cap' };
    return { ok: true, reason: '' };
}

function referralBlockMessage(reason) {
    if (reason === 'cap') {
        return '❌ ይህ የግብዣ ሊንክ በ24 ሰዓት ውስጥ ከፍተኛውን 5 ምዝገባ ደርሷል። እባክዎ ነገ ይሞክሩ። (This invite link is limited to 5 registrations every 24 hours.)';
    }
    return '❌ ከዚህ መሳሪያ ወይም ኢንተርኔት ብዙ የግብዣ ምዝገባ ተደርጓል። እባክዎ ቆይተው ይሞክሩ። (Too many invite signups from this device or network.)';
}

function bonusPayoutAllowed({ percent, stake, paid, extraPrize }) {
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct <= 0) return false;
    const stakeN = Number(stake) || 0;
    const paidN = Number(paid) || 0;
    const extra = Number(extraPrize) || 0;
    if (stakeN <= 0) return false;
    if (extra < 0) return false;
    const projected = ((paidN + extra) / stakeN) * 100;
    return projected <= pct + 1e-6;
}

function isWinRestricted(state) {
    const cooldownLeft = Number(state && state.cooldownLeft) || 0;
    const banUntil = Number(state && state.banUntil) || 0;
    const now = Number(state && state.now) || Date.now();
    if (cooldownLeft > 0) return true;
    if (banUntil > now) return true;
    return false;
}

function bonusFundsUsed(user, totalCharge) {
    const play = Math.max(0, Number(user.playBalance) || 0);
    const realAvail = Math.min(play, Math.max(0, Number(user.unplayedRealDeposit) || 0));
    const charge = Math.max(0, Number(totalCharge) || 0);
    const fromPlay = Math.min(play, charge);
    const realFromPlay = Math.min(fromPlay, realAvail);
    const bonusFromPlay = fromPlay - realFromPlay;
    return {
        usesBonus: bonusFromPlay > 0.0001,
        bonusFromPlay
    };
}

function cardCharge(ticketPrice, count, fee = CARD_REG_FEE) {
    const n = Math.max(0, parseInt(count, 10) || 0);
    const price = Math.max(0, Number(ticketPrice) || 0);
    const perFee = Math.min(price, Math.max(0, Number(fee) || 0));
    const total = n * price;
    const regFee = n * perFee;
    const stake = total - regFee;
    return { count: n, stake, regFee, total };
}

function potDeltaAfterFee(stakePortion, regFee) {
    const portion = Number(stakePortion) || 0;
    const fee = Math.max(0, Number(regFee) || 0);
    return portion - fee;
}

function botPotContribution(ticketPrice, count, fee = CARD_REG_FEE) {
    const charge = cardCharge(ticketPrice, count, fee);
    return charge.stake;
}

function calculateNetJackpot(totalJackpot = 0, houseCutPercent = 20) {
    const total = Math.max(0, Number(totalJackpot) || 0);
    const cut = Math.max(0, Math.min(100, Number(houseCutPercent) || 0));
    return Math.round(total * (1 - cut / 100) * 100) / 100;
}

function weekKeyFromMs(ms) {
    const eat = new Date(Number(ms) + EAT_OFFSET_MS);
    const day = eat.getUTCDay();
    const start = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - day);
    const end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return { key: fmt(start), startLabel: fmt(start), endLabel: fmt(end) };
}

function historyCutoff(now = Date.now()) {
    return new Date(Number(now) - TX_HISTORY_DAYS * 24 * 60 * 60 * 1000);
}

function describePayout(totalPot, winnerPhones, phone) {
    const winners = (Array.isArray(winnerPhones) ? winnerPhones : String(winnerPhones || '').split(','))
        .map((p) => String(p).trim())
        .filter(Boolean);
    const won = winners.includes(String(phone));
    const coWinners = winners.length;
    const pot = Number(totalPot) || 0;
    const share = won && coWinners > 0 ? Math.round((pot / coWinners) * 100) / 100 : 0;
    return {
        outcome: won ? 'win' : 'loss',
        isShared: won && coWinners > 1,
        solo: won && coWinners === 1,
        totalPot: pot,
        coWinners,
        share
    };
}

function buildPlayerRoundView(game, phone) {
    const players = Array.isArray(game.playersData) ? game.playersData : [];
    const me = players.find((p) => String(p.phone) === String(phone));
    const ticketIds = me && Array.isArray(me.ticketsData) ? me.ticketsData.map((t) => t.id) : [];
    const payout = describePayout(game.prize, game.winnerPhone, phone);
    return {
        gameId: game.gameId,
        date: game.date,
        calledNumbers: Array.isArray(game.calledNumbers) ? game.calledNumbers : [],
        ticketIds,
        outcome: payout.outcome,
        isShared: payout.isShared,
        solo: payout.solo,
        totalPot: payout.totalPot,
        coWinners: payout.coWinners,
        share: payout.share
    };
}

function parseClockToMinutes(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        const hour = Math.max(0, Math.min(24, value));
        return Math.round(hour * 60);
    }
    const text = String(value).trim();
    const clock = text.match(/^(\d{1,2}):(\d{2})$/);
    if (clock) {
        const h = Number(clock[1]);
        const m = Number(clock[2]);
        if (h === 24 && m === 0) return 24 * 60;
        if (h < 0 || h > 23 || m < 0 || m > 59) return null;
        return h * 60 + m;
    }
    const asNum = Number(text);
    if (Number.isFinite(asNum) && text !== '') return parseClockToMinutes(asNum);
    return null;
}

function formatMinutes(mins) {
    const clamped = Math.max(0, Math.min(24 * 60, Math.round(mins)));
    if (clamped === 24 * 60) return '24:00';
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function slotRangeFromRaw(raw, fallback) {
    const src = raw || {};
    const fb = fallback || {};
    const hasMin = src.min !== undefined && src.min !== '';
    const hasMax = src.max !== undefined && src.max !== '';
    const hasCount = src.count !== undefined && src.count !== '';
    const count = hasCount ? Math.max(0, parseInt(src.count, 10) || 0) : Math.max(0, parseInt(fb.count, 10) || 0);
    const minRaw = hasMin ? src.min : (hasCount ? count : (fb.min !== undefined ? fb.min : count));
    const maxRaw = hasMax ? src.max : (hasCount ? count : (fb.max !== undefined ? fb.max : count));
    const range = clampBotRange(minRaw, maxRaw);
    return { ...range, count: Math.max(range.min, Math.min(range.max, count || range.max)) };
}

function normalizeBotSlots(input) {
    const src = Array.isArray(input) ? input : [];
    const slots = [];
    for (let i = 0; i < 8; i++) {
        const raw = src[i] || DEFAULT_BOT_SLOTS[i];
        const startM = parseClockToMinutes(raw.start);
        const endM = parseClockToMinutes(raw.end);
        const fallback = DEFAULT_BOT_SLOTS[i];
        const range = slotRangeFromRaw(raw, fallback);
        slots.push({
            start: formatMinutes(startM === null ? parseClockToMinutes(fallback.start) : startM),
            end: formatMinutes(endM === null ? parseClockToMinutes(fallback.end) : endM),
            min: range.min,
            max: range.max,
            count: range.count
        });
    }
    return slots;
}

function resolveSlotRangeTarget(slot, current) {
    if (!slot) return 0;
    const range = clampBotRange(
        slot.min !== undefined ? slot.min : slot.count,
        slot.max !== undefined ? slot.max : slot.count
    );
    const cur = Math.max(0, Math.round(Number(current) || 0));
    if (cur < range.min) return range.min;
    if (cur > range.max) return range.max;
    return cur;
}

function getActiveBotSlot(slots, minutesOfDay) {
    const list = normalizeBotSlots(slots);
    const now = Number(minutesOfDay) || 0;
    for (let i = 0; i < list.length; i++) {
        const start = parseClockToMinutes(list[i].start);
        const end = parseClockToMinutes(list[i].end);
        if (start === null || end === null || start === end) continue;
        const inside = start < end
            ? (now >= start && now < end)
            : (now >= start || now < end);
        if (inside) return { ...list[i], index: i, slotNumber: i + 1 };
    }
    return null;
}

function rampValue({ from, to, startedAt, now, durationMs }) {
    const span = Number(durationMs) || 0;
    const target = Math.round(Number(to) || 0);
    if (span <= 0) return target;
    const elapsed = Math.min(span, Math.max(0, Number(now) - Number(startedAt)));
    const t = elapsed / span;
    return Math.round((Number(from) || 0) + (target - (Number(from) || 0)) * t);
}

function stepRamp(tracker, target, now, durationMs) {
    const prev = tracker || { from: 0, to: 0, startedAt: now, durationMs };
    const nextTarget = Math.max(0, Math.round(Number(target) || 0));
    const span = Math.max(0, Number(durationMs) || 0);
    if (prev.to === nextTarget) {
        const value = rampValue({
            from: prev.from,
            to: prev.to,
            startedAt: prev.startedAt,
            now,
            durationMs: prev.durationMs != null ? prev.durationMs : span
        });
        return { tracker: prev, value };
    }
    const current = rampValue({
        from: prev.from,
        to: prev.to,
        startedAt: prev.startedAt,
        now,
        durationMs: prev.durationMs != null ? prev.durationMs : span
    });
    const next = { from: current, to: nextTarget, startedAt: now, durationMs: span };
    const value = rampValue({ ...next, now });
    return { tracker: next, value };
}

function clampInt(value, fallback = 0) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? n : fallback;
}

function clampBotRange(min, max) {
    let lo = Math.max(0, clampInt(min, DEFAULT_BOT_MIN));
    let hi = Math.max(0, clampInt(max, DEFAULT_BOT_MAX));
    if (hi < lo) {
        const swap = lo;
        lo = hi;
        hi = swap;
    }
    return { min: lo, max: hi };
}

function clampBotTarget(target, min, max) {
    const range = clampBotRange(min, max);
    const t = Math.max(0, clampInt(target, range.min));
    return Math.max(range.min, Math.min(range.max, t));
}

function currentRampValue(tracker, now) {
    if (!tracker) return 0;
    if (tracker.value !== undefined && Number.isFinite(Number(tracker.value))) {
        return Math.max(0, Math.round(Number(tracker.value)));
    }
    return rampValue({
        from: tracker.from,
        to: tracker.to,
        startedAt: tracker.startedAt,
        now,
        durationMs: tracker.durationMs
    });
}

function stepIntervalRamp(tracker, target, now, intervalMs) {
    const nextTarget = Math.max(0, Math.round(Number(target) || 0));
    const interval = Math.max(0, Number(intervalMs) || 0);
    const nowMs = Number(now) || 0;
    let value = currentRampValue(tracker, nowMs);

    if (interval <= 0) {
        return { tracker: { value: nextTarget, target: nextTarget, lastStepAt: nowMs }, value: nextTarget };
    }

    const sameTarget = !!(tracker && tracker.target === nextTarget);
    const lastStepAt = Number(tracker && tracker.lastStepAt);
    const started = sameTarget && Number.isFinite(lastStepAt) ? lastStepAt : nowMs;

    if (value === nextTarget) {
        return { tracker: { value, target: nextTarget, lastStepAt: started }, value };
    }

    const elapsed = Math.max(0, nowMs - started);
    const steps = Math.floor(elapsed / interval);
    if (steps <= 0) {
        return { tracker: { value, target: nextTarget, lastStepAt: started }, value };
    }

    const dir = nextTarget > value ? 1 : -1;
    const applied = Math.min(steps, Math.abs(nextTarget - value));
    value += dir * applied;
    return {
        tracker: { value, target: nextTarget, lastStepAt: started + applied * interval },
        value
    };
}

function seasonState({ start, end, now, status, id }) {
    const n = Number(now) || Date.now();
    const s = Number(start) || 0;
    const e = Number(end) || 0;
    const seasonId = String(id || (s ? String(s) : ''));
    if (!s || !e) {
        return { status: 'idle', remainingMs: 0, frozen: true, active: false, start: 0, end: 0, id: seasonId };
    }
    if (n >= e || status === 'frozen') {
        return { status: 'frozen', remainingMs: 0, frozen: true, active: false, start: s, end: e, id: seasonId };
    }
    if (n >= s) {
        return { status: 'active', remainingMs: Math.max(0, e - n), frozen: false, active: true, start: s, end: e, id: seasonId };
    }
    return { status: 'idle', remainingMs: 0, frozen: true, active: false, start: s, end: e, id: seasonId };
}

function startSeason(now, durationMs = SEASON_MS) {
    const start = Number(now) || Date.now();
    const span = Math.max(1, Number(durationMs) || SEASON_MS);
    return { start, end: start + span, status: 'active', id: String(start) };
}

function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(Number(ms) || 0));
    const sec = Math.floor(total / 1000);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function normalizePrizeList(input) {
    const src = Array.isArray(input) ? input : [];
    const prizes = [];
    for (let i = 0; i < 10; i++) {
        const raw = src[i];
        const amount = Math.max(0, Math.round((Number(raw && raw.amount !== undefined ? raw.amount : raw) || 0) * 100) / 100);
        prizes.push(amount);
    }
    return prizes;
}

function eatLocalToUtcMs(dateStr, timeStr) {
    const dm = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const tm = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!dm || !tm) return 0;
    const y = Number(dm[1]);
    const mo = Number(dm[2]);
    const d = Number(dm[3]);
    const hh = Number(tm[1]);
    const mm = Number(tm[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return 0;
    return Date.UTC(y, mo - 1, d, hh - 3, mm, 0, 0);
}

function isKeepablePendingDeposit(tx) {
    const amount = Number(tx && tx.amount);
    const sms = String((tx && tx.smsText) || '').trim();
    const ref = String((tx && tx.txRef) || '').trim();
    if (!(amount > 0)) return false;
    if (sms.length < 6) return false;
    if (!/^[A-Z0-9]{6,20}$/i.test(ref)) return false;
    return true;
}

function partitionPendingDeposits(list) {
    const seen = new Set();
    const keep = [];
    const clear = [];
    const ordered = Array.isArray(list) ? list : [];
    for (const tx of ordered) {
        if (!isKeepablePendingDeposit(tx)) {
            clear.push(tx);
            continue;
        }
        const key = String(tx.txRef).toUpperCase();
        if (seen.has(key)) {
            clear.push(tx);
            continue;
        }
        seen.add(key);
        keep.push(tx);
    }
    return { keep, clear };
}

function stripIllegalWinners(winners, opts) {
    const list = Array.isArray(winners) ? winners.slice() : [];
    const isRestricted = (opts && opts.isRestricted) || (() => false);
    const isBonusPlayer = (opts && opts.isBonusPlayer) || (() => false);
    const payoutAllowed = (opts && opts.payoutAllowed) || (() => false);
    let next = list.filter((w) => {
        if (!w || !w.player || w.player.isBot) return true;
        return !isRestricted(w.player);
    });
    const bonusOnes = next.filter((w) => w.player && !w.player.isBot && isBonusPlayer(w.player));
    if (bonusOnes.length > 0) {
        const pot = Number(opts && opts.pot) || 0;
        const shareEach = next.length > 0 ? pot / next.length : pot;
        const bonusTake = shareEach * bonusOnes.length;
        if (!payoutAllowed(bonusTake)) {
            next = next.filter((w) => !w.player || w.player.isBot || !isBonusPlayer(w.player));
        }
    }
    return next;
}

module.exports = {
    REFERRAL_DAILY_CAP,
    REFERRAL_IP_DAILY_CAP,
    REFERRAL_FINGERPRINT_DAILY_CAP,
    CARD_PRICE,
    CARD_REG_FEE,
    CARD_POT_SHARE,
    TX_HISTORY_DAYS,
    EAT_OFFSET_MS,
    DEFAULT_BOT_SLOTS,
    SEASON_MS,
    DEFAULT_BOT_MIN,
    DEFAULT_BOT_MAX,
    DEFAULT_BOT_STEP_SECONDS,
    evaluateReferralAttempt,
    referralBlockMessage,
    bonusPayoutAllowed,
    isWinRestricted,
    bonusFundsUsed,
    cardCharge,
    potDeltaAfterFee,
    botPotContribution,
    weekKeyFromMs,
    historyCutoff,
    describePayout,
    buildPlayerRoundView,
    parseClockToMinutes,
    formatMinutes,
    normalizeBotSlots,
    slotRangeFromRaw,
    resolveSlotRangeTarget,
    getActiveBotSlot,
    rampValue,
    stepRamp,
    clampBotRange,
    clampBotTarget,
    stepIntervalRamp,
    seasonState,
    startSeason,
    formatCountdown,
    normalizePrizeList,
    eatLocalToUtcMs,
    isKeepablePendingDeposit,
    partitionPendingDeposits,
    stripIllegalWinners,
    calculateNetJackpot
};

const GAME_RULES = Object.freeze({
    CARD_PRICE,
    CARD_REG_FEE,
    CARD_POT_SHARE,
    MIN_CALLS_FOR_WIN: 4,
    MIN_JACKPOT_THRESHOLD: 14,
    MAX_JACKPOT_THRESHOLD: 18,
    DEFAULT_JACKPOT_THRESHOLD: 16,
    COUNTDOWN_SECONDS: 40
});

const FINANCE_LIMITS = Object.freeze({
    MIN_DEPOSIT: 10,
    MAX_DEPOSIT: 100000,
    MIN_WITHDRAWAL: 50,
    MAX_WITHDRAWAL: 50000,
    DAILY_WITHDRAWAL_CAP: 100000
});

const REFERRAL_SYSTEM = Object.freeze({
    REFERRAL_DAILY_CAP,
    REFERRAL_IP_DAILY_CAP,
    REFERRAL_FINGERPRINT_DAILY_CAP,
    COMMISSION_RATE: 0.05
});

const BOT_CONSTRAINTS = Object.freeze({
    DEFAULT_BOT_MIN,
    DEFAULT_BOT_MAX,
    DEFAULT_BOT_STEP_SECONDS
});

const ADMIN_PRIVILEGES = Object.freeze({
    ROLES: ['admin', 'finance', 'support'],
    CAN_EDIT_SETTINGS: ['admin'],
    CAN_PROCESS_FINANCE: ['admin', 'finance']
});

function calculatePayoutPerWinner(netJackpot, winnerCount) {
    const pot = Number(netJackpot) || 0;
    const count = parseInt(winnerCount, 10) || 0;
    if (count <= 0 || pot <= 0) return 0;
    return Math.round((pot / count) * 100) / 100;
}

function calculateReferralCommission(amount, rate = REFERRAL_SYSTEM.COMMISSION_RATE) {
    const val = Number(amount) || 0;
    const r = Number(rate) || 0;
    if (val <= 0 || r <= 0) return 0;
    return Math.round(val * r * 100) / 100;
}

function validateWithdrawalLimits(amount, min = FINANCE_LIMITS.MIN_WITHDRAWAL, max = FINANCE_LIMITS.MAX_WITHDRAWAL) {
    const val = Number(amount);
    if (!Number.isFinite(val) || isNaN(val)) {
        return { valid: false, reason: 'INVALID_AMOUNT', message: 'ትክክለኛ ያልሆነ የገንዘብ መጠን (Invalid withdrawal amount)' };
    }
    if (val < min) {
        return { valid: false, reason: 'BELOW_MINIMUM', message: `ዝቅተኛው የማውጣት መጠን ${min} ብር ነው (Minimum withdrawal is ${min} ETB)` };
    }
    if (val > max) {
        return { valid: false, reason: 'EXCEEDS_MAXIMUM', message: `ከፍተኛው የማውጣት መጠን በአንድ ጊዜ ${max} ብር ነው (Maximum withdrawal is ${max} ETB)` };
    }
    return { valid: true, amount: val };
}

function detectFraudPatterns(user, action = {}) {
    if (!user) return { suspicious: true, reason: 'NO_USER' };
    const flags = [];
    if (user.isBanned) flags.push('BANNED_USER');
    if (user.status === 'suspended') flags.push('SUSPENDED_USER');
    return {
        suspicious: flags.length > 0,
        flags,
        userPhone: user.phone || ''
    };
}

Object.assign(module.exports, {
    GAME_RULES,
    FINANCE_LIMITS,
    REFERRAL_SYSTEM,
    BOT_CONSTRAINTS,
    ADMIN_PRIVILEGES,
    calculatePayoutPerWinner,
    calculateReferralCommission,
    validateWithdrawalLimits,
    detectFraudPatterns
});
