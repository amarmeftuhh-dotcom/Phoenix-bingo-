/**
 * End-to-End Test for Approved Winning Patterns, Anti-Cheat, and Jackpot Threshold
 */
const assert = require('assert');
const http = require('http');

process.env.TELEGRAM_MODE = 'webhook';
const TEST_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_testToken';
process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

const {
    app,
    server,
    currentGame,
    inMemoryUsers,
    inMemoryGames,
    startGamePlay,
    endGame,
    generateFixedCard,
    DEFAULT_JACKPOT_THRESHOLD
} = require('../server');

async function runE2EWinningPatternTests() {
    console.log('Running End-to-End Winning Pattern & Anti-Cheat Claim Verification Tests...\n');

    const serverInstance = http.createServer(app);
    await new Promise(resolve => serverInstance.listen(0, resolve));
    const port = serverInstance.address().port;

    try {
        // Setup authenticated players in in-memory store
        inMemoryUsers.set('0911000001', {
            phone: '0911000001',
            name: 'Player One',
            telegramId: '100000001',
            balance: 100,
            playBalance: 100
        });

        inMemoryUsers.set('0911000002', {
            phone: '0911000002',
            name: 'Player Two',
            telegramId: '100000002',
            balance: 100,
            playBalance: 100
        });

        // Initialize clean game state
        currentGame.gameId = 3001;
        currentGame.state = 'WAITING';
        currentGame.drawnNumbers = [];
        currentGame.selectedCards.clear();
        currentGame.players.clear();
        currentGame.jackpotThreshold = 16;

        // Player 1 socket and ticket setup
        const socketId1 = 'socket_player_1';
        const card1Grid = generateFixedCard(15);
        const player1Record = {
            socketId: socketId1,
            telegramId: '100000001',
            phone: '0911000001',
            name: 'Player One',
            tickets: [{ id: 15, grid: card1Grid }]
        };
        currentGame.players.set(socketId1, player1Record);
        currentGame.selectedCards.set(15, { socketId: socketId1, phone: '0911000001', name: 'Player One' });

        // Player 2 socket setup
        const socketId2 = 'socket_player_2';
        const card2Grid = generateFixedCard(30);
        const player2Record = {
            socketId: socketId2,
            telegramId: '100000002',
            phone: '0911000002',
            name: 'Player Two',
            tickets: [{ id: 30, grid: card2Grid }]
        };
        currentGame.players.set(socketId2, player2Record);
        currentGame.selectedCards.set(30, { socketId: socketId2, phone: '0911000002', name: 'Player Two' });

        // 1. Test: Claim while game is WAITING must be rejected as premature
        const { verifyBingoClaim } = require('../lib/bingoRules');
        const prematureWaitClaim = verifyBingoClaim({
            player: player1Record,
            game: currentGame,
            claimedTicketId: 15
        });
        assert.strictEqual(prematureWaitClaim.ok, false);
        assert.strictEqual(prematureWaitClaim.code, 'PREMATURE_GAME_WAITING');
        console.log('✓ 1. Premature claim rejected when game state is WAITING');

        // Transition to PLAYING
        currentGame.state = 'PLAYING';
        currentGame.drawnNumbers = [card1Grid[0][0], card1Grid[1][0]]; // only 2 numbers called

        // 2. Test: Claim with fewer than 4 calls must be rejected
        const prematureFewCallsClaim = verifyBingoClaim({
            player: player1Record,
            game: currentGame,
            claimedTicketId: 15
        });
        assert.strictEqual(prematureFewCallsClaim.ok, false);
        assert.strictEqual(prematureFewCallsClaim.code, 'PREMATURE_FEW_CALLS');
        console.log('✓ 2. Premature claim rejected when fewer than 4 numbers called');

        // 3. Test: Player 1 attempts to claim Player 2\'s ticket (30)
        const unownedClaim = verifyBingoClaim({
            player: player1Record,
            game: currentGame,
            claimedTicketId: 30
        });
        assert.strictEqual(unownedClaim.ok, false);
        assert.strictEqual(unownedClaim.code, 'TICKET_NOT_OWNED');
        console.log('✓ 3. Claim rejected when ticket is not owned by authenticated player');

        // 4. Test: Draw numbers that do NOT form any winning pattern on ticket 15
        currentGame.drawnNumbers = [1, 2, 3, 4, 5, 6, 7];
        const noPatternClaim = verifyBingoClaim({
            player: player1Record,
            game: currentGame,
            claimedTicketId: 15
        });
        assert.strictEqual(noPatternClaim.ok, false);
        assert.strictEqual(noPatternClaim.code, 'NO_WINNING_PATTERN');
        console.log('✓ 4. Claim rejected when numbers do not form ONE LINE or FOUR CORNERS');

        // 5. Test: Draw numbers that complete FOUR CORNERS on ticket 15
        // Corners: (0,0), (4,0), (0,4), (4,4)
        const cornerCalls = [
            card1Grid[0][0],
            card1Grid[4][0],
            card1Grid[0][4],
            card1Grid[4][4],
            10, 20, 35, 50 // some dummy calls
        ];
        currentGame.drawnNumbers = cornerCalls; // 8 calls total <= 16 jackpot threshold

        const cornerWinClaim = verifyBingoClaim({
            player: player1Record,
            game: currentGame,
            claimedTicketId: 15,
            clientGameId: 3001
        });
        assert.strictEqual(cornerWinClaim.ok, true, 'FOUR CORNERS must be verified as valid win');
        assert.strictEqual(cornerWinClaim.winningPattern.patternName, 'FOUR_CORNERS');
        assert.strictEqual(cornerWinClaim.winningTicketId, 15);
        assert.strictEqual(cornerWinClaim.isJackpotWin, true, '8 calls <= 16 threshold must qualify for Jackpot');
        console.log('✓ 5. FOUR CORNERS win authoritatively verified on server (Jackpot Eligible: YES)');

        // 6. Test: Complete Row 2 (center row passing through FREE square) on ticket 30
        // Row 2 non-free numbers: (0,2), (1,2), (3,2), (4,2)
        const row2Calls = [
            card2Grid[0][2],
            card2Grid[1][2],
            card2Grid[3][2],
            card2Grid[4][2]
        ];
        // Append 15 dummy calls to make total calls 19 (> 16 jackpot threshold)
        const dummyPastCalls = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18];
        currentGame.drawnNumbers = [...row2Calls, ...dummyPastCalls]; // 19 calls total

        const row2WinClaim = verifyBingoClaim({
            player: player2Record,
            game: currentGame,
            claimedTicketId: 30,
            clientGameId: 3001
        });
        assert.strictEqual(row2WinClaim.ok, true, 'Row 2 (passing through FREE square) must be verified as win');
        assert.strictEqual(row2WinClaim.winningPattern.patternName, 'HORIZONTAL_ROW');
        assert.strictEqual(row2WinClaim.winningPattern.row, 2);
        assert.strictEqual(row2WinClaim.isJackpotWin, false, '19 calls > 16 threshold must NOT qualify for Jackpot');
        console.log('✓ 6. ONE LINE (center row with FREE square) verified (Jackpot Eligible: NO, past 16 calls)');

        // 7. Test: Server endGame stores persistent record of jackpot threshold & pattern
        await endGame([row2WinClaim.winnerPhone], row2WinClaim);
        assert.strictEqual(currentGame.state, 'ENDED');
        const endedGame = inMemoryGames[0];
        assert.strictEqual(endedGame.gameId, 3001);
        assert.strictEqual(endedGame.jackpotThreshold, 16, 'Game record must persistently store jackpot threshold');
        assert.strictEqual(endedGame.isJackpotWin, false);
        assert.ok(endedGame.winningPattern);
        assert.strictEqual(endedGame.winningPattern.patternName, 'HORIZONTAL_ROW');
        console.log('✓ 7. Persistent record of threshold, pattern, and jackpot status verified in game record');

        // 8. Test: Claim after game has ended must be rejected as stale
        const afterEndClaim = verifyBingoClaim({
            player: player1Record,
            game: currentGame,
            claimedTicketId: 15
        });
        assert.strictEqual(afterEndClaim.ok, false);
        assert.strictEqual(afterEndClaim.code, 'GAME_ALREADY_ENDED');
        console.log('✓ 8. Claim rejected after game ended (GAME_ALREADY_ENDED)');

        console.log('\nALL E2E WINNING PATTERNS & ANTI-CHEAT TESTS PASSED! ✅\n');
    } finally {
        await new Promise(resolve => serverInstance.close(resolve));
    }
}

runE2EWinningPatternTests()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('E2E Test Failed:', err);
        process.exit(1);
    });
