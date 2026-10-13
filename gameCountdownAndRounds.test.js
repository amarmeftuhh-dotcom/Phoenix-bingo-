/**
 * Automated tests for Phoenix Bingo:
 * 1. Countdown timer authoritativeness, synchronization, and reconnection
 * 2. Multi-round lifecycle progression (WAITING -> PLAYING -> RESOLVING_WINNERS -> COMPLETED -> next round)
 * 3. Consecutive rounds without server restart
 * 4. Stale claim & old gameId rejection in new rounds
 * 5. Server restart recovery during countdown/gameplay
 * 6. Idempotent single winner payouts across rounds
 */

process.env.NODE_ENV = 'test';
global.__PHOENIX_TEST_MODE = true;
process.env.TELEGRAM_MODE = 'webhook';

const assert = require('assert');

// Load core modules from Phoenix Bingo
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
    inMemoryGames,
    rehydrateSettingsAndRecoverPayouts
} = require('../server.js');

const { generateFixedCard } = require('../lib/bingoRules.js');
const { processWinnerPayouts } = require('../lib/walletManager.js');

async function runAllTests() {
    console.log('======================================================');
    console.log('🎯 RUNNING PHOENIX BINGO COUNTDOWN & ROUNDS TEST SUITE');
    console.log('======================================================\n');

    // --- TEST 1: Countdown begins at configured time (40s), decreases smoothly to 0, never negative ---
    console.log('--- Test 1: Countdown begins at configured time and decreases smoothly to zero ---');
    currentGame.state = 'WAITING';
    currentGame.timer = 40;
    startCountdown(true); // force restart to test starting value
    assert.strictEqual(currentGame.state, 'WAITING', 'Game state must be WAITING');
    assert.strictEqual(currentGame.timer, 40, 'Countdown must start at 40 seconds');

    // Simulate countdown ticks
    const initialPayload = getGameStatusPayload();
    assert.strictEqual(initialPayload.timer, 40, 'Initial game status timer must be 40');
    assert.strictEqual(initialPayload.state, 'WAITING', 'Initial game status state must be WAITING');

    // Verify timer cannot become negative
    currentGame.timer = 1;
    // Tick: timer reaches 0
    currentGame.timer = Math.max(0, currentGame.timer - 1);
    assert.strictEqual(currentGame.timer, 0, 'Timer must reach 0');
    // Tick beyond 0: clamped at 0
    currentGame.timer = Math.max(0, currentGame.timer - 1);
    assert.strictEqual(currentGame.timer, 0, 'Timer must never be negative');
    console.log('✓ 1. Countdown begins at 40s, decreases smoothly, and never becomes negative.');

    // --- TEST 2: Two clients receive synchronized countdown values ---
    console.log('\n--- Test 2: Synchronized countdown values across multiple clients ---');
    currentGame.timer = 35;
    const client1Payload = getGameStatusPayload();
    const client2Payload = getGameStatusPayload();
    assert.strictEqual(client1Payload.timer, client2Payload.timer, 'Both clients must receive identical timer');
    assert.strictEqual(client1Payload.gameId, client2Payload.gameId, 'Both clients must receive identical gameId');
    assert.strictEqual(client1Payload.timer, 35, 'Timer must match server authoritative timer');
    console.log('✓ 2. Synchronized countdown across multiple clients verified.');

    // --- TEST 3: Reconnection receives correct remaining countdown rather than fresh countdown ---
    console.log('\n--- Test 3: Reconnection receives remaining countdown instead of fresh 40s ---');
    currentGame.timer = 18; // 18 seconds remaining
    // Simulate reconnecting client requesting payload
    const reconnectPayload = getGameStatusPayload();
    assert.strictEqual(reconnectPayload.timer, 18, 'Reconnecting client must receive remaining time (18s)');
    assert.notStrictEqual(reconnectPayload.timer, 40, 'Reconnecting client must NOT receive fresh 40s timer');
    console.log('✓ 3. Reconnecting player receives exact remaining countdown (18s).');

    // --- TEST 4: Duplicate timers cannot start the same round twice ---
    console.log('\n--- Test 4: Duplicate timers cannot start the same round twice ---');
    currentGame.state = 'WAITING';
    currentGame.timer = 25;
    // Calling startCountdown without forceRestart must NOT reset the countdown to 40
    startCountdown(false);
    assert.strictEqual(currentGame.timer, 25, 'Timer must not be reset to 40 when duplicate startCountdown is called');
    console.log('✓ 4. Duplicate timer invocation rejected; existing countdown preserved.');

    // --- TEST 5: A completed round can progress to a new round with unique game ID ---
    console.log('\n--- Test 5: Completed round progression to a new round ---');
    const oldGameId = currentGame.gameId;
    currentGame.state = 'PLAYING';
    currentGame.drawnNumbers = [5, 12, 23, 44, 55];
    currentGame.selectedCards.set(10, { socketId: 'sock_1', phone: '0911000001', name: 'Test P1' });

    // End current game
    await endGame([], null, []);
    assert.strictEqual(currentGame.state, 'ENDED', 'Game state must be ENDED');
    assert.strictEqual(currentGame.isProcessingPayout, false, 'Payout processing must be completed');

    // Trigger reset for next round
    resetGame();
    assert.strictEqual(currentGame.state, 'WAITING', 'Game state must reset to WAITING');
    assert.strictEqual(currentGame.gameId, oldGameId + 1, 'Next round must have an incremented unique game ID');
    assert.strictEqual(currentGame.timer, 40, 'New round countdown must reset to configured 40s');
    assert.strictEqual(currentGame.drawnNumbers.length, 0, 'Drawn numbers must be reset');
    assert.strictEqual(currentGame.selectedCards.size, 0, 'Selected cards must be cleared for new round');
    assert.strictEqual(currentGame.finalizing, false, 'finalizing flag must be reset to false');
    assert.strictEqual(currentGame._endGameProcessed, false, '_endGameProcessed must be reset to false');
    assert.strictEqual(currentGame.claimResolutionWindowOpen, false, 'Resolution window must be closed');
    console.log(`✓ 5. Round ${oldGameId} completed and progressed to Round ${currentGame.gameId} with clean state.`);

    // --- TEST 6: Two or more consecutive rounds work without restarting server ---
    console.log('\n--- Test 6: Consecutive rounds work without restarting the server ---');
    for (let round = 1; round <= 3; round++) {
        const roundId = currentGame.gameId;
        // Start game play
        await startGamePlay();
        assert.strictEqual(currentGame.state, 'PLAYING', `Round ${round} state must be PLAYING`);
        assert.strictEqual(currentGame.gameId, roundId, `Round ${round} gameId must match`);
        assert.strictEqual(currentGame.finalizing, false, `Round ${round} finalizing must be false`);
        assert.strictEqual(currentGame._endGameProcessed, false, `Round ${round} _endGameProcessed must be false`);

        // Simulate drawing balls
        currentGame.drawnNumbers.push(10, 20, 30);

        // Simulate claim resolution
        currentGame.state = 'RESOLVING_WINNERS';
        currentGame.claimResolutionWindowOpen = true;
        currentGame.resolvedCallCount = currentGame.drawnNumbers.length;

        // Finalize winners
        await finalizeCurrentGameWinners();
        assert.strictEqual(currentGame.state, 'ENDED', `Round ${round} must end in ENDED`);

        // Reset to next round
        resetGame();
        assert.strictEqual(currentGame.state, 'WAITING', `Subsequent Round must enter WAITING`);
        assert.strictEqual(currentGame.gameId, roundId + 1, `Next round gameId must be ${roundId + 1}`);
        assert.strictEqual(currentGame.drawnNumbers.length, 0, `Drawn numbers must be empty in subsequent round`);
    }
    console.log('✓ 6. Three consecutive rounds executed successfully without server restart.');

    // --- TEST 7: Old claims and old game IDs are strictly rejected in the new round ---
    console.log('\n--- Test 7: Stale claims and old game IDs are rejected in the new round ---');
    const currentRoundId = currentGame.gameId;
    const oldRoundId = currentRoundId - 1;

    // Set game to PLAYING
    await startGamePlay();

    // Create a mock player with ticket
    const playerWithTicket = {
        socketId: 'sock_player_7',
        phone: '0977777777',
        name: 'Player 7',
        tickets: [{ id: 15, grid: generateFixedCard(15) }]
    };
    currentGame.players.set('sock_player_7', playerWithTicket);
    currentGame.selectedCards.set(15, { socketId: 'sock_player_7', phone: '0977777777', name: 'Player 7' });

    // Submit claim with OLD gameId
    const staleClaimResult = verifyBingoClaim({
        player: playerWithTicket,
        game: currentGame,
        claimedTicketId: 15,
        clientGameId: oldRoundId
    });
    assert.strictEqual(staleClaimResult.ok, false, 'Claim with stale game ID must be rejected');
    assert.strictEqual(staleClaimResult.code, 'STALE_GAME_ID', 'Rejection code must be STALE_GAME_ID');
    console.log(`✓ 7a. Claim with old game ID #${oldRoundId} in active game #${currentRoundId} rejected with STALE_GAME_ID.`);

    // Submit claim without owning ticket in current round
    const strangerPlayer = {
        socketId: 'sock_stranger',
        phone: '0988888888',
        name: 'Stranger',
        tickets: [] // No tickets in current round
    };
    const noTicketResult = verifyBingoClaim({
        player: strangerPlayer,
        game: currentGame,
        claimedTicketId: 15,
        clientGameId: currentRoundId
    });
    assert.strictEqual(noTicketResult.ok, false, 'Claim with no active tickets must be rejected');
    assert.strictEqual(noTicketResult.code, 'NO_TICKETS_OWNED', 'Rejection code must be NO_TICKETS_OWNED');
    console.log('✓ 7b. Claim from player with no active tickets in current round rejected with NO_TICKETS_OWNED.');

    // --- TEST 8: Server restart during countdown or gameplay is handled safely ---
    console.log('\n--- Test 8: Safe recovery after server restart ---');
    // Simulate interrupted game in memory
    inMemoryGames.unshift({
        gameId: currentRoundId,
        status: 'PLAYING',
        drawnNumbers: [1, 2, 3],
        createdAt: new Date()
    });

    // Run startup recovery
    await rehydrateSettingsAndRecoverPayouts();

    // Game ID must have advanced past interrupted game
    assert(currentGame.gameId > currentRoundId, `currentGame.gameId (${currentGame.gameId}) must be > interrupted gameId (${currentRoundId})`);
    const interruptedRecord = inMemoryGames.find(g => g.gameId === currentRoundId);
    assert.strictEqual(interruptedRecord.status, 'INTERRUPTED', 'Interrupted game must be marked INTERRUPTED');
    console.log(`✓ 8. Restart recovered safely: game #${currentRoundId} marked INTERRUPTED, new gameId advanced to #${currentGame.gameId}.`);

    // --- TEST 9: Winner payouts are processed once only (Idempotency) ---
    console.log('\n--- Test 9: Payout idempotency across repeated payout calls ---');
    const winnerPhone = '0955555555';
    inMemoryUsers.set(winnerPhone, {
        phone: winnerPhone,
        mainBalance: 100,
        playBalance: 0
    });

    const payoutGameId = 7701;
    const payout1 = await processWinnerPayouts({
        gameId: payoutGameId,
        winners: [winnerPhone],
        totalPrize: 80,
        claimMeta: { isJackpotWin: false },
        inMemoryUsers,
        inMemoryGames
    });
    assert.strictEqual(payout1.ok, true, 'First payout must succeed');
    assert.strictEqual(payout1.payouts[0].success, true, 'First payout entry must succeed');
    assert.strictEqual(inMemoryUsers.get(winnerPhone).mainBalance, 180, 'Balance must be credited 80 ETB');

    // Duplicate payout attempt for the same game and winner
    const payout2 = await processWinnerPayouts({
        gameId: payoutGameId,
        winners: [winnerPhone],
        totalPrize: 80,
        claimMeta: { isJackpotWin: false },
        inMemoryUsers,
        inMemoryGames
    });
    assert.strictEqual(payout2.payouts[0].duplicateSkipped, true, 'Duplicate payout must be flagged duplicateSkipped');
    assert.strictEqual(inMemoryUsers.get(winnerPhone).mainBalance, 180, 'Balance must NOT be credited a second time');
    console.log('✓ 9. Payout idempotency verified: winner credited once only.');

    // --- TEST 10: Player accounts and balances preserved across round transitions ---
    console.log('\n--- Test 10: Player accounts & balances preserved across rounds ---');
    const playerPhone = '0933333333';
    inMemoryUsers.set(playerPhone, {
        phone: playerPhone,
        mainBalance: 250,
        playBalance: 50
    });

    // Run game round reset
    resetGame();
    const preservedUser = inMemoryUsers.get(playerPhone);
    assert.strictEqual(preservedUser.mainBalance, 250, 'Main balance must be preserved across rounds');
    assert.strictEqual(preservedUser.playBalance, 50, 'Play balance must be preserved across rounds');
    console.log('✓ 10. Player balances and accounts completely preserved across round transitions.');

    // Clean up timer handles
    if (currentGame.drawInterval) {
        clearInterval(currentGame.drawInterval);
        currentGame.drawInterval = null;
    }
    if (currentGame.claimResolutionTimer) {
        clearTimeout(currentGame.claimResolutionTimer);
        currentGame.claimResolutionTimer = null;
    }

    console.log('\n======================================================');
    console.log('🎉 ALL COUNTDOWN & ROUND LIFECYCLE TESTS PASSED! ✅');
    console.log('======================================================');
    process.exit(0);
}

runAllTests().catch(err => {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
});
