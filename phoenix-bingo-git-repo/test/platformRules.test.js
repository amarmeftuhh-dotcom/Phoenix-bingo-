const assert = require('assert');
const rules = require('../lib/platformRules');

function testReferralCap() {
    const open = rules.evaluateReferralAttempt({
        hasReferral: true,
        hasFingerprint: true,
        linkCount: 4,
        ipCount: 1,
        fingerprintCount: 1,
        sameFingerprintOnLink: false
    });
    assert.strictEqual(open.ok, true);

    const capped = rules.evaluateReferralAttempt({
        hasReferral: true,
        hasFingerprint: true,
        linkCount: 5,
        ipCount: 0,
        fingerprintCount: 0
    });
    assert.strictEqual(capped.ok, false);
    assert.strictEqual(capped.reason, 'cap');
    assert.ok(rules.referralBlockMessage('cap').includes('5'));

    const device = rules.evaluateReferralAttempt({
        hasReferral: true,
        hasFingerprint: false,
        linkCount: 0
    });
    assert.strictEqual(device.reason, 'fingerprint');

    const sameDevice = rules.evaluateReferralAttempt({
        hasReferral: true,
        hasFingerprint: true,
        sameFingerprintOnLink: true,
        linkCount: 1
    });
    assert.strictEqual(sameDevice.ok, false);

    const ip = rules.evaluateReferralAttempt({
        hasReferral: true,
        hasFingerprint: true,
        ipCount: 3,
        fingerprintCount: 0,
        linkCount: 1
    });
    assert.strictEqual(ip.reason, 'ip');

    const plain = rules.evaluateReferralAttempt({ hasReferral: false });
    assert.strictEqual(plain.ok, true);
}

function testBonusPayout() {
    assert.strictEqual(rules.bonusPayoutAllowed({ percent: 0, stake: 1000, paid: 0, extraPrize: 10 }), false);
    assert.strictEqual(rules.bonusPayoutAllowed({ percent: 10, stake: 1000, paid: 0, extraPrize: 100 }), true);
    assert.strictEqual(rules.bonusPayoutAllowed({ percent: 10, stake: 1000, paid: 0, extraPrize: 101 }), false);
    assert.strictEqual(rules.bonusPayoutAllowed({ percent: 10, stake: 1000, paid: 90, extraPrize: 20 }), false);
    assert.strictEqual(rules.bonusPayoutAllowed({ percent: 50, stake: 0, paid: 0, extraPrize: 1 }), false);

    const used = rules.bonusFundsUsed({ playBalance: 30, unplayedRealDeposit: 30 }, 12);
    assert.strictEqual(used.usesBonus, false);

    const bonus = rules.bonusFundsUsed({ playBalance: 20, unplayedRealDeposit: 0 }, 12);
    assert.strictEqual(bonus.usesBonus, true);
    assert.strictEqual(bonus.bonusFromPlay, 12);

    const bypass = rules.bonusFundsUsed({ playBalance: 50, unplayedRealDeposit: 1 }, 12);
    assert.strictEqual(bypass.usesBonus, true);
    assert.ok(bypass.bonusFromPlay > 0);
}

function testCooldownStrip() {
    assert.strictEqual(rules.isWinRestricted({ cooldownLeft: 3, banUntil: 0, now: 100 }), true);
    assert.strictEqual(rules.isWinRestricted({ cooldownLeft: 0, banUntil: 500, now: 100 }), true);
    assert.strictEqual(rules.isWinRestricted({ cooldownLeft: 0, banUntil: 50, now: 100 }), false);

    const winners = [
        { player: { phone: '0911000001', isBot: false, bonusFunded: false } },
        { player: { phone: '0911000002', isBot: true } }
    ];
    const stripped = rules.stripIllegalWinners(winners, {
        pot: 100,
        isRestricted: (p) => p.phone === '0911000001',
        isBonusPlayer: () => false,
        payoutAllowed: () => true
    });
    assert.strictEqual(stripped.length, 1);
    assert.strictEqual(stripped[0].player.isBot, true);

    const bonusRound = [
        { player: { phone: '0911000003', isBot: false, bonusFunded: true } }
    ];
    const blocked = rules.stripIllegalWinners(bonusRound, {
        pot: 500,
        isRestricted: () => false,
        isBonusPlayer: (p) => !!p.bonusFunded,
        payoutAllowed: () => false
    });
    assert.strictEqual(blocked.length, 0);

    const allowed = rules.stripIllegalWinners(bonusRound, {
        pot: 20,
        isRestricted: () => false,
        isBonusPlayer: (p) => !!p.bonusFunded,
        payoutAllowed: (take) => take <= 20
    });
    assert.strictEqual(allowed.length, 1);
}

function testFeesAndHistory() {
    const one = rules.cardCharge(rules.CARD_PRICE, 1);
    assert.strictEqual(one.total, 10);
    assert.strictEqual(one.regFee, 2);
    assert.strictEqual(one.stake, 8);
    assert.strictEqual(rules.CARD_POT_SHARE, 8);

    const charge = rules.cardCharge(10, 3, 2);
    assert.strictEqual(charge.stake, 24);
    assert.strictEqual(charge.regFee, 6);
    assert.strictEqual(charge.total, 30);
    assert.strictEqual(rules.botPotContribution(10, 2, 2), 16);
    assert.strictEqual(rules.botPotContribution(10, 1), rules.cardCharge(10, 1).stake);
    assert.strictEqual(rules.potDeltaAfterFee(20, 4), 16);

    const solo = rules.describePayout(80, ['0911'], '0911');
    assert.strictEqual(solo.outcome, 'win');
    assert.strictEqual(solo.solo, true);
    assert.strictEqual(solo.share, 80);

    const split = rules.describePayout(90, '0911, 0922, 0933', '0922');
    assert.strictEqual(split.isShared, true);
    assert.strictEqual(split.coWinners, 3);
    assert.strictEqual(split.share, 30);
    assert.strictEqual(split.totalPot, 90);

    const loss = rules.buildPlayerRoundView({
        gameId: 12,
        prize: 40,
        winnerPhone: '0999',
        calledNumbers: [1, 2, 3],
        playersData: [{ phone: '0911', ticketsData: [{ id: 7 }, { id: 8 }] }]
    }, '0911');
    assert.deepStrictEqual(loss.ticketIds, [7, 8]);
    assert.strictEqual(loss.outcome, 'loss');
    assert.deepStrictEqual(loss.calledNumbers, [1, 2, 3]);

    const cutoff = rules.historyCutoff(Date.UTC(2026, 0, 15));
    assert.strictEqual(cutoff.toISOString(), new Date(Date.UTC(2026, 0, 1)).toISOString());
}

function testWeekAndRamp() {
    // Wednesday 2026-01-07 12:00 UTC is 15:00 EAT, still the week that started Sunday 2026-01-04 EAT.
    const wed = rules.weekKeyFromMs(Date.UTC(2026, 0, 7, 12, 0, 0));
    assert.strictEqual(wed.key, '2026-01-04');
    assert.strictEqual(wed.endLabel, '2026-01-10');

    // Saturday 2026-01-10 21:30 UTC is Sunday 2026-01-11 00:30 EAT, a new week.
    const sun = rules.weekKeyFromMs(Date.UTC(2026, 0, 10, 21, 30, 0));
    assert.strictEqual(sun.key, '2026-01-11');

    let tracker = { from: 0, to: 0, startedAt: 0, durationMs: 1000 };
    let step = rules.stepRamp(tracker, 10, 1000, 1000);
    assert.strictEqual(step.value, 0);
    tracker = step.tracker;
    step = rules.stepRamp(tracker, 10, 1500, 1000);
    assert.strictEqual(step.value, 5);
    step = rules.stepRamp(tracker, 10, 2000, 1000);
    assert.strictEqual(step.value, 10);

    const down = rules.stepRamp(step.tracker, 0, 2000, 1000);
    assert.strictEqual(down.value, 10);
    const mid = rules.stepRamp(down.tracker, 0, 2500, 1000);
    assert.strictEqual(mid.value, 5);

    const slots = rules.normalizeBotSlots([
        { start: '08:00', end: '12:00', count: 7 }
    ]);
    assert.strictEqual(slots.length, 8);
    assert.strictEqual(slots[0].count, 7);
    assert.strictEqual(slots[0].min, 7);
    assert.strictEqual(slots[0].max, 7);
    const ranged = rules.normalizeBotSlots([
        { start: '18:00', end: '21:00', min: 60, max: 70 }
    ]);
    assert.strictEqual(ranged[0].min, 60);
    assert.strictEqual(ranged[0].max, 70);
    const active = rules.getActiveBotSlot(slots, 9 * 60);
    assert.strictEqual(active.slotNumber, 1);
    assert.strictEqual(active.count, 7);
    assert.strictEqual(rules.resolveSlotRangeTarget({ min: 10, max: 40 }, 25), 25);
    assert.strictEqual(rules.resolveSlotRangeTarget({ min: 10, max: 40 }, 65), 40);
    assert.strictEqual(rules.resolveSlotRangeTarget({ min: 60, max: 70 }, 15), 60);
    assert.strictEqual(rules.resolveSlotRangeTarget(null, 20), 0);
    const overnight = rules.getActiveBotSlot([{ start: '22:00', end: '02:00', count: 4 }], 23 * 60);
    assert.strictEqual(overnight.count, 4);
    assert.strictEqual(rules.getActiveBotSlot(slots, 3 * 60).slotNumber, 2);

    const range = rules.clampBotRange(40, 10);
    assert.strictEqual(range.min, 10);
    assert.strictEqual(range.max, 40);
    assert.strictEqual(rules.clampBotTarget(5, 10, 40), 10);
    assert.strictEqual(rules.clampBotTarget(55, 10, 40), 40);
    assert.strictEqual(rules.clampBotTarget(25, 10, 40), 25);

    let intervalTracker = { value: 10, target: 10, lastStepAt: 0 };
    let stepped = rules.stepIntervalRamp(intervalTracker, 14, 0, 1000);
    assert.strictEqual(stepped.value, 10);
    intervalTracker = stepped.tracker;
    stepped = rules.stepIntervalRamp(intervalTracker, 14, 1000, 1000);
    assert.strictEqual(stepped.value, 11);
    stepped = rules.stepIntervalRamp(stepped.tracker, 14, 4000, 1000);
    assert.strictEqual(stepped.value, 14);

    const downStep = rules.stepIntervalRamp(stepped.tracker, 12, 4000, 1000);
    assert.strictEqual(downStep.value, 14);
    const downMid = rules.stepIntervalRamp(downStep.tracker, 12, 5000, 1000);
    assert.strictEqual(downMid.value, 13);

    const instant = rules.stepIntervalRamp({ value: 8, target: 8, lastStepAt: 0 }, 20, 50, 0);
    assert.strictEqual(instant.value, 20);

    const fromHigh = 65;
    const nextTarget = rules.resolveSlotRangeTarget({ min: 10, max: 40 }, fromHigh);
    assert.strictEqual(nextTarget, 40);
    let cross = rules.stepIntervalRamp({ value: fromHigh, target: fromHigh, lastStepAt: 0 }, nextTarget, 0, 2000);
    assert.strictEqual(cross.value, 65);
    cross = rules.stepIntervalRamp(cross.tracker, nextTarget, 2000, 2000);
    assert.strictEqual(cross.value, 64);
    cross = rules.stepIntervalRamp(cross.tracker, nextTarget, 10000, 2000);
    assert.strictEqual(cross.value, 60);

    const season = rules.startSeason(1_000, rules.SEASON_MS);
    assert.strictEqual(season.status, 'active');
    assert.strictEqual(season.end - season.start, rules.SEASON_MS);
    const live = rules.seasonState({ start: season.start, end: season.end, now: season.start + 1000, id: season.id });
    assert.strictEqual(live.active, true);
    assert.ok(live.remainingMs < rules.SEASON_MS);
    const frozen = rules.seasonState({ start: season.start, end: season.end, now: season.end, id: season.id });
    assert.strictEqual(frozen.status, 'frozen');
    assert.strictEqual(frozen.active, false);
    assert.strictEqual(rules.formatCountdown(61 * 1000), '00:01:01');
    assert.ok(rules.formatCountdown(rules.SEASON_MS).startsWith('7d'));
    assert.deepStrictEqual(rules.normalizePrizeList([100, '50', -3]), [100, 50, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function testDepositsAndBroadcastTime() {
    const rows = [
        { _id: 'a', amount: 100, smsText: 'FT123456 received', txRef: 'FT123456' },
        { _id: 'b', amount: 0, smsText: '', txRef: '' },
        { _id: 'c', amount: 50, smsText: 'short', txRef: 'ABC' },
        { _id: 'd', amount: 80, smsText: 'duplicate receipt text', txRef: 'FT123456' },
        { _id: 'e', amount: 70, smsText: 'CBE987654 confirmed', txRef: 'CBE987654' }
    ];
    const parts = rules.partitionPendingDeposits(rows);
    assert.deepStrictEqual(parts.keep.map((t) => t._id), ['a', 'e']);
    assert.deepStrictEqual(parts.clear.map((t) => t._id), ['b', 'c', 'd']);

    const utc = rules.eatLocalToUtcMs('2026-04-01', '15:30');
    assert.strictEqual(new Date(utc).toISOString(), '2026-04-01T12:30:00.000Z');
    assert.strictEqual(rules.eatLocalToUtcMs('bad', '15:30'), 0);
}

function testPurchaseOrder() {
    const phones = [];
    let chain = Promise.resolve();
    function enqueue(phone, task) {
        const run = chain.then(task);
        chain = run.then(() => {}, () => {});
        return run;
    }
    const done = Promise.all([
        enqueue('u', async () => { phones.push('a'); }),
        enqueue('u', async () => { phones.push('b'); }),
        enqueue('u', async () => { phones.push('c'); })
    ]);
    return done.then(() => {
        assert.deepStrictEqual(phones, ['a', 'b', 'c']);
    });
}

Promise.resolve()
    .then(() => {
        testReferralCap();
        testBonusPayout();
        testCooldownStrip();
        testFeesAndHistory();
        testWeekAndRamp();
        testDepositsAndBroadcastTime();
        return testPurchaseOrder();
    })
    .then(() => {
        console.log('platformRules tests passed');
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
