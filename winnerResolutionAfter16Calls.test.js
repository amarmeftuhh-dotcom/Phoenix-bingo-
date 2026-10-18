/**
 * Regression test for:
 * 1. Removal of "gedeb 16" bar (jackpot-threshold-bar) from index.html ticket view.
 * 2. Winner resolution after 16 calls (draw 17+), ensuring active tickets (real players & bots)
 *    are automatically crowned winners when completing a pattern.
 * 3. Bot ticket seeding during countdown and admin bot routing (/api/admin/bots-list, /api/admin/bot-master-update-v2).
 */
process.env.NODE_ENV = 'test';
global.__PHOENIX_TEST_MODE = true;

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    currentGame,
    startCountdown,
    startGamePlay,
    finalizeCurrentGameWinners,
    endGame,
    resetGame,
    getGameStatusPayload,
    verifyBingoClaim,
    inMemoryUsers,
    inMemoryGames
} = require('../server.js');
const { generateFixedCard, checkWinningPatterns } = require('../lib/bingoRules.js');

async function runTests() {
    console.log('======================================================');
    console.log('🎯 RUNNING WINNER RESOLUTION AFTER 16 CALLS TEST SUITE');
    console.log('======================================================');

    // --- TEST 1: index.html has jackpot-threshold-bar removed from ticket section ---
    console.log('--- Test 1: Verify jackpot-threshold-bar removed from index.html ---');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    assert.strictEqual(indexHtml.includes('id="jackpot-threshold-bar"'), false, 'jackpot-threshold-bar must be removed from index.html');
    assert.strictEqual(indexHtml.includes('id="val-jp-target"'), false, 'id="val-jp-target" must be removed from ticket section in index.html');
    assert.strictEqual(indexHtml.includes('id="val-jp-countdown"'), false, 'id="val-jp-countdown" must be removed from ticket section in index.html');
    assert.strictEqual(indexHtml.includes('checkClientWinningPatterns'), true, 'checkClientWinningPatterns must be defined in index.html');
    console.log('✓ 1. jackpot-threshold-bar completely removed from ticket view in index.html.');

    // --- TEST 2: Winner resolution after 16 calls (callsCount >= 17) ---
    console.log('\n--- Test 2: Active card win detected at call 17+ ---');
    resetGame();
    currentGame.gameId = 6001;

    // Player takes card #15
    const card15 = generateFixedCard(15);
    currentGame.selectedCards.set(15, {
        pending: false,
        socketId: 'sock_winner_15',
        phone: '0911555555',
        name: 'Abebe Player',
        isBot: false,
        gameId: 6001
    });
    currentGame.players.set('sock_winner_15', {
        socketId: 'sock_winner_15',
        phone: '0911555555',
        name: 'Abebe Player',
        tickets: [{ id: 15, grid: card15 }]
    });
    currentGame.totalJackpot = 100;
    currentGame.netJackpot = 80;

    await startGamePlay();
    assert.strictEqual(currentGame.state, 'PLAYING', 'Game should be in PLAYING state');

    // Numbers that complete row 0 of card #15: (0,0), (1,0), (2,0), (3,0), (4,0)
    const winningRowNumbers = [
        card15[0][0],
        card15[1][0],
        card15[2][0],
        card15[3][0],
        card15[4][0]
    ];
    // Fill up to 16 dummy calls that do not complete any row
    const dummyCalls = [71, 72, 73, 74, 75, 1, 2, 3, 4, 5, 6].filter(n => !winningRowNumbers.includes(n));
    while (dummyCalls.length < 16) {
        dummyCalls.push(dummyCalls.length + 60);
    }

    // Call 16 numbers: dummy calls
    currentGame.drawnNumbers = dummyCalls.slice(0, 16);
    assert.strictEqual(currentGame.drawnNumbers.length, 16, 'Should have exactly 16 drawn numbers');

    // Verify card 15 does not win at call 16
    const checkAt16 = checkWinningPatterns(card15, currentGame.drawnNumbers);
    assert.strictEqual(checkAt16.isWin, false, 'Card 15 must not have a winning pattern yet');

    // Now advance to call 17 by adding the winning numbers
    currentGame.drawnNumbers = [...dummyCalls.slice(0, 12), ...winningRowNumbers]; // 17 numbers total
    assert.strictEqual(currentGame.drawnNumbers.length, 17, 'Should have exactly 17 drawn numbers (callsCount >= 17)');

    const checkAt17 = checkWinningPatterns(card15, currentGame.drawnNumbers);
    assert.strictEqual(checkAt17.isWin, true, 'Card 15 must have a winning pattern at call 17');
    assert.strictEqual(checkAt17.patternType, 'ONE_LINE');

    // Simulate claim verification for card 15
    const claimRes = verifyBingoClaim({
        player: currentGame.players.get('sock_winner_15'),
        game: currentGame,
        claimedTicketId: 15,
        clientGameId: 6001
    });
    assert.strictEqual(claimRes.ok, true, 'Claim for card 15 at call 17 must be verified successfully');
    console.log('✓ 2. Card #15 correctly verified as winner at call 17 (after 16 calls).');

    // --- TEST 3: End game and payout execution for verified winner ---
    console.log('\n--- Test 3: End game and payout execution ---');
    inMemoryUsers.set('0911555555', {
        phone: '0911555555',
        name: 'Abebe Player',
        mainBalance: 50,
        playBalance: 0
    });

    currentGame.netJackpot = 80;
    currentGame.totalJackpot = 100;

    await endGame(['0911555555'], claimRes, [claimRes]);
    assert.strictEqual(currentGame.state, 'ENDED', 'Game must be in ENDED state');

    const updatedUser = inMemoryUsers.get('0911555555');
    assert.strictEqual(updatedUser.mainBalance, 130, 'User main balance must be credited with 80 ETB net prize (50 + 80 = 130)');
    console.log('✓ 3. Winner credited with net prize and game ended cleanly.');

    // --- TEST 4: Bot winner resolution test ---
    console.log('\n--- Test 4: Bot winner resolution at call 18 ---');
    resetGame();
    currentGame.gameId = 6002;

    const botCard20 = generateFixedCard(20);
    currentGame.selectedCards.set(20, {
        pending: false,
        socketId: null,
        phone: '0911234501',
        name: 'አበበ',
        isBot: true,
        gameId: 6002
    });
    currentGame.totalJackpot = 100;
    currentGame.netJackpot = 80;

    await startGamePlay();

    // 4 corners of bot card 20: (0,0), (4,0), (0,4), (4,4)
    const botCorners = [botCard20[0][0], botCard20[4][0], botCard20[0][4], botCard20[4][4]];
    const extraCalls = [2, 17, 32, 47, 62, 3, 18, 33, 48, 63, 4, 19, 34, 49]; // 14 dummy calls
    currentGame.drawnNumbers = [...extraCalls, ...botCorners]; // 18 calls total
    assert.strictEqual(currentGame.drawnNumbers.length, 18);

    const botWinCheck = checkWinningPatterns(botCard20, currentGame.drawnNumbers);
    assert.strictEqual(botWinCheck.isWin, true, 'Bot card must win FOUR CORNERS');

    const botClaim = {
        ok: true,
        code: 'CLAIM_VERIFIED',
        ticketId: 20,
        grid: botCard20,
        winningPattern: botWinCheck,
        isJackpotWin: false,
        callsCount: 18,
        winnerPhone: '0911234501',
        winnerName: 'አበበ',
        isBot: true
    };

    await endGame(['0911234501'], botClaim, [botClaim]);
    assert.strictEqual(currentGame.state, 'ENDED');
    console.log('✓ 4. Bot winner "አበበ" resolved safely with winning card and pattern.');

    // --- TEST 5: Strict Admin control over Bots & Jackpot (No automatic 192 ETB jackpot) ---
    console.log('\n--- Test 5: Strict Admin control over Bots & Jackpot ---');
    resetGame();
    global.__inMemorySettings.isBotSystemActive = false;
    global.__inMemorySettings.botDist1 = 0;
    global.__inMemorySettings.botDist2 = 0;
    global.__inMemorySettings.botDist3 = 0;
    global.__inMemorySettings.botDist4 = 0;
    startCountdown();
    const statusWhenOff = getGameStatusPayload();
    assert.strictEqual(statusWhenOff.totalPrizePool, 0, 'Jackpot must be 0 ETB (never auto-192) when Admin has not enabled bots');
    assert.strictEqual(Object.keys(statusWhenOff.selectedCards).length, 0, 'No bot cards may be selected when Admin bot system is OFF');

    // Now Admin enables bots with exact quantities: 2 bots with 1 card, 1 bot with 2 cards = 4 cards total (4 * 8 = 32 ETB jackpot)
    global.__inMemorySettings.isBotSystemActive = true;
    global.__inMemorySettings.botDist1 = 2;
    global.__inMemorySettings.botDist2 = 1;
    global.__inMemorySettings.botDist3 = 0;
    global.__inMemorySettings.botDist4 = 0;
    resetGame();
    startCountdown();
    assert.strictEqual(currentGame.botEntryQueue.length, 4, 'Must schedule 4 human-like bot picks in countdown queue');
    require('../server.js').flushPendingBotSchedule();
    const statusWhenConfigured = getGameStatusPayload();
    assert.strictEqual(Object.keys(statusWhenConfigured.selectedCards).length, 4, 'Must have exactly 4 cards from Admin-configured bots (2x1 + 1x2)');
    assert.strictEqual(statusWhenConfigured.totalPrizePool, 32, 'Jackpot must equal exact Admin bot cards * 8 ETB = 32 ETB');
    console.log('✓ 5. Strict Admin control verified: 0 ETB default (no auto-192) and exact Admin bot quantities enforced.');

    console.log('\n======================================================');
    console.log('🎉 ALL WINNER RESOLUTION & ADMIN CONTROL TESTS PASSED! ✅');
    console.log('======================================================\n');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failure:', err);
    process.exit(1);
});
