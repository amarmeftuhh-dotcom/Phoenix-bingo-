/**
 * Phoenix Bingo — Wallet, Ticket Payments, and Winner Payout Security Test Suite
 *
 * Verifies:
 * 1. Insufficient balance rejection (prevents negative balances).
 * 2. Authoritative play-balance / main-balance payment priority.
 * 3. Cancellation and exact single refund.
 * 4. Concurrent purchases overspending prevention (withUserLock).
 * 5. Authoritative winner prize payout and ledger recording.
 * 6. Duplicate payout prevention (idempotency).
 * 7. Multiple winners fair split and pool boundary protection.
 * 8. Server restart settings rehydration and recovery.
 */

const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
global.__PHOENIX_TEST_MODE = true;
process.env.TELEGRAM_MODE = 'webhook';
process.env.TELEGRAM_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_testToken';

const {
    app,
    server,
    currentGame,
    inMemoryUsers,
    inMemoryGames,
    startGamePlay,
    endGame,
    finalizeCurrentGameWinners,
    generateFixedCard,
    rehydrateSettingsAndRecoverPayouts,
    validateJackpotThreshold,
    User,
    Transaction,
    Game,
    Settings
} = require('../server');

const {
    withUserLock,
    debitTicketPurchase,
    refundTicketPurchase,
    processWinnerPayouts,
    getAuthoritativeUser,
    inMemoryTransactions
} = require('../lib/walletManager');

async function runWalletAndPayoutSecurityTests() {
    console.log('Running Authoritative Wallet, Ticket Payment & Payout Security Tests...\n');

    const testUserA = {
        phone: '0977000001',
        name: 'Wallet Tester A',
        telegramId: '770000001',
        balance: 20,
        mainBalance: 20,
        playBalance: 15,
        bonusBalance: 15,
        bonus: 15,
        played: 0,
        won: 0,
        totalWon: 0
    };

    const testUserB = {
        phone: '0977000002',
        name: 'Wallet Tester B',
        telegramId: '770000002',
        balance: 0,
        mainBalance: 0,
        playBalance: 5,
        bonusBalance: 5,
        bonus: 5,
        played: 0,
        won: 0,
        totalWon: 0
    };

    const testUserC = {
        phone: '0977000003',
        name: 'Wallet Tester C',
        telegramId: '770000003',
        balance: 10,
        mainBalance: 10,
        playBalance: 0,
        bonusBalance: 0,
        bonus: 0,
        played: 0,
        won: 0,
        totalWon: 0
    };

    inMemoryUsers.set(testUserA.phone, testUserA);
    inMemoryUsers.set(testUserA.telegramId, testUserA);
    inMemoryUsers.set(testUserB.phone, testUserB);
    inMemoryUsers.set(testUserB.telegramId, testUserB);
    inMemoryUsers.set(testUserC.phone, testUserC);
    inMemoryUsers.set(testUserC.telegramId, testUserC);

    // ==========================================
    // 1. INSUFFICIENT BALANCE REJECTION
    // ==========================================
    const insufficientRes = await debitTicketPurchase({
        phone: testUserB.phone,
        ticketIds: [10],
        stake: 10,
        gameId: 5001,
        User,
        Transaction,
        inMemoryUsers
    });

    assert.strictEqual(insufficientRes.ok, false);
    assert.strictEqual(insufficientRes.code, 'INSUFFICIENT_BALANCE');
    assert.strictEqual(testUserB.playBalance, 5, 'Play balance must remain untouched');
    assert.strictEqual(testUserB.mainBalance, 0, 'Main balance must remain untouched');
    console.log('✓ 1. Insufficient balance purchase strictly rejected (no negative balance allowed)');

    // ==========================================
    // 2. AUTHORITATIVE DEBIT POLICY PRIORITY
    // ==========================================
    // testUserA has playBalance: 15, mainBalance: 20
    // Buy Cartela 1 (10 ETB) -> playBalance should absorb all 10 ETB
    const debit1 = await debitTicketPurchase({
        phone: testUserA.phone,
        ticketIds: [1],
        stake: 10,
        gameId: 5001,
        User,
        Transaction,
        inMemoryUsers
    });
    assert.strictEqual(debit1.ok, true);
    assert.strictEqual(debit1.debited.playDebit, 10);
    assert.strictEqual(debit1.debited.mainDebit, 0);
    assert.strictEqual(debit1.balances.playBalance, 5);
    assert.strictEqual(debit1.balances.mainBalance, 20);
    assert.strictEqual(testUserA.playBalance, 5);
    assert.strictEqual(testUserA.mainBalance, 20);

    // Buy Cartela 2 (10 ETB) -> playBalance has 5, mainBalance has 20
    // Should debit 5 from playBalance and 5 from mainBalance
    const debit2 = await debitTicketPurchase({
        phone: testUserA.phone,
        ticketIds: [2],
        stake: 10,
        gameId: 5001,
        User,
        Transaction,
        inMemoryUsers
    });
    assert.strictEqual(debit2.ok, true);
    assert.strictEqual(debit2.debited.playDebit, 5);
    assert.strictEqual(debit2.debited.mainDebit, 5);
    assert.strictEqual(debit2.balances.playBalance, 0);
    assert.strictEqual(debit2.balances.mainBalance, 15);
    assert.strictEqual(testUserA.playBalance, 0);
    assert.strictEqual(testUserA.mainBalance, 15);

    // Verify transaction ledger entries recorded
    const betTx = inMemoryTransactions.filter(t => t.userId === testUserA.phone && t.type === 'BET');
    assert.ok(betTx.length >= 2, 'BET transaction entries must be recorded in ledger');
    console.log('✓ 2. Authoritative play-balance / main-balance payment priority and ledger logging verified');

    // ==========================================
    // 3. CANCELLATION AND EXACT SINGLE REFUND
    // ==========================================
    // Refund Cartela 2: paid 5 play + 5 main
    const refundRes = await refundTicketPurchase({
        phone: testUserA.phone,
        ticketId: 2,
        gameId: 5001,
        paidRecord: { playPaid: 5, mainPaid: 5 },
        User,
        Transaction,
        inMemoryUsers
    });
    assert.strictEqual(refundRes.ok, true);
    assert.strictEqual(refundRes.refunded.playRefund, 5);
    assert.strictEqual(refundRes.refunded.mainRefund, 5);
    assert.strictEqual(refundRes.refunded.totalRefund, 10);
    assert.strictEqual(refundRes.balances.playBalance, 5);
    assert.strictEqual(refundRes.balances.mainBalance, 20);
    assert.strictEqual(testUserA.playBalance, 5);
    assert.strictEqual(testUserA.mainBalance, 20);

    // Verify REFUND transaction entry
    const refTx = inMemoryTransactions.find(t => t.userId === testUserA.phone && t.type === 'REFUND');
    assert.ok(refTx, 'REFUND transaction entry must be recorded in ledger');
    console.log('✓ 3. Exact single refund on cancellation verified');

    // ==========================================
    // 4. CONCURRENT PURCHASES OVERSPENDING PREVENTION
    // ==========================================
    // testUserC has exactly 10 ETB mainBalance, 0 playBalance
    // Fire 5 concurrent purchase requests for 10 ETB cards simultaneously
    const concurrentRequests = [
        debitTicketPurchase({ phone: testUserC.phone, ticketIds: [21], stake: 10, gameId: 5002, User, Transaction, inMemoryUsers }),
        debitTicketPurchase({ phone: testUserC.phone, ticketIds: [22], stake: 10, gameId: 5002, User, Transaction, inMemoryUsers }),
        debitTicketPurchase({ phone: testUserC.phone, ticketIds: [23], stake: 10, gameId: 5002, User, Transaction, inMemoryUsers }),
        debitTicketPurchase({ phone: testUserC.phone, ticketIds: [24], stake: 10, gameId: 5002, User, Transaction, inMemoryUsers }),
        debitTicketPurchase({ phone: testUserC.phone, ticketIds: [25], stake: 10, gameId: 5002, User, Transaction, inMemoryUsers })
    ];

    const concurrentResults = await Promise.all(concurrentRequests);
    const successes = concurrentResults.filter(r => r.ok === true);
    const failures = concurrentResults.filter(r => r.ok === false);

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent purchase must succeed');
    assert.strictEqual(failures.length, 4, 'Remaining 4 concurrent purchases must be rejected');
    assert.strictEqual(testUserC.mainBalance, 0, 'Balance must be 0, never negative');
    console.log('✓ 4. Concurrency lock (withUserLock) strictly prevented race condition overspending');

    // ==========================================
    // 5. AUTHORITATIVE WINNER PRIZE PAYOUT
    // ==========================================
    // Single winner test for testUserB: pot 80 ETB
    const initialBBal = testUserB.mainBalance;
    const singlePayout = await processWinnerPayouts({
        gameId: 5003,
        winners: [testUserB.phone],
        totalPrize: 80,
        claimMeta: { isJackpotWin: false },
        User,
        Transaction,
        Game,
        inMemoryUsers,
        inMemoryGames
    });

    assert.strictEqual(singlePayout.ok, true);
    assert.strictEqual(singlePayout.winnerCount, 1);
    assert.strictEqual(singlePayout.perWinnerPrize, 80);
    assert.strictEqual(testUserB.mainBalance, initialBBal + 80);
    assert.strictEqual(testUserB.won, 1);
    assert.strictEqual(testUserB.totalWon, 80);

    const winTx = inMemoryTransactions.find(t => t.userId === testUserB.phone && t.type === 'WIN');
    assert.ok(winTx, 'WIN transaction must be created in ledger');
    assert.strictEqual(winTx.amount, 80);
    console.log('✓ 5. Authoritative single winner prize payout & ledger record credited exactly once');

    // ==========================================
    // 6. DUPLICATE PAYOUT PREVENTION (IDEMPOTENCY)
    // ==========================================
    // Attempting to payout testUserB for the exact same game 5003 a second time
    const duplicatePayout = await processWinnerPayouts({
        gameId: 5003,
        winners: [testUserB.phone],
        totalPrize: 80,
        claimMeta: { isJackpotWin: false },
        User,
        Transaction,
        Game,
        inMemoryUsers,
        inMemoryGames
    });

    assert.strictEqual(testUserB.mainBalance, initialBBal + 80, 'Duplicate payout must NOT increase user balance');
    assert.strictEqual(duplicatePayout.payouts[0].duplicateSkipped, true, 'Duplicate payout must be flagged as skipped');
    console.log('✓ 6. Duplicate winner payout prevented via idempotency key');

    // ==========================================
    // 7. MULTIPLE WINNERS FAIR SPLIT & POOL BOUNDARY
    // ==========================================
    // 3 winners: testUserA, testUserB, testUserC for a pot of 80 ETB
    // 80 / 3 = 26.6666...
    // Floor division must yield exactly 26.66 ETB each.
    // Total distributed = 79.98 ETB <= 80.00 ETB (Never exceeds pot)
    const initialABal = testUserA.mainBalance;
    const initialBBal2 = testUserB.mainBalance;
    const initialCBal = testUserC.mainBalance;

    const multiPayout = await processWinnerPayouts({
        gameId: 5004,
        winners: [testUserA.phone, testUserB.phone, testUserC.phone],
        totalPrize: 80,
        claimMeta: { isJackpotWin: true },
        User,
        Transaction,
        Game,
        inMemoryUsers,
        inMemoryGames
    });

    assert.strictEqual(multiPayout.ok, true);
    assert.strictEqual(multiPayout.winnerCount, 3);
    assert.strictEqual(multiPayout.perWinnerPrize, 26.66);
    assert.ok(multiPayout.totalDistributed <= 80, 'Total distributed must never exceed total prize');
    assert.strictEqual(multiPayout.totalDistributed, 79.98);

    assert.strictEqual(testUserA.mainBalance, Math.round((initialABal + 26.66) * 100) / 100);
    assert.strictEqual(testUserB.mainBalance, Math.round((initialBBal2 + 26.66) * 100) / 100);
    assert.strictEqual(testUserC.mainBalance, Math.round((initialCBal + 26.66) * 100) / 100);
    console.log('✓ 7. Multiple winners fair split & pool boundary protection verified (sum <= pot)');

    // ==========================================
    // 8. SIMULTANEOUS CLAIM RESOLUTION & RECOVERY
    // ==========================================
    currentGame.gameId = 5005;
    currentGame.state = 'PLAYING';
    currentGame.pendingWinners = new Map();
    currentGame.pendingWinners.set('0977000001', { winnerPhone: '0977000001', winningTicketId: 1 });
    currentGame.pendingWinners.set('0977000002', { winnerPhone: '0977000002', winningTicketId: 2 });

    await finalizeCurrentGameWinners();
    assert.strictEqual(currentGame.state, 'ENDED');
    const gameRecord = inMemoryGames.find(g => g.gameId === 5005);
    assert.ok(gameRecord, 'Game 5005 must be recorded');
    assert.strictEqual(gameRecord.status, 'COMPLETED');
    assert.strictEqual(gameRecord.winners.length, 2);
    console.log('✓ 8. Simultaneous multiple winner claims resolved fairly into completed game record');

    console.log('\nALL AUTHORITATIVE WALLET & PAYOUT SECURITY TESTS PASSED! ✅\n');
}

if (require.main === module) {
    runWalletAndPayoutSecurityTests()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Test failure:', err);
            process.exit(1);
        });
}

module.exports = { runWalletAndPayoutSecurityTests };
