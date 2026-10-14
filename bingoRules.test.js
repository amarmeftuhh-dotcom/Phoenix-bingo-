/**
 * Comprehensive Unit Test Suite for Bingo Rules Engine & Jackpot Threshold
 */
const assert = require('assert');
const {
    MIN_JACKPOT_THRESHOLD,
    MAX_JACKPOT_THRESHOLD,
    DEFAULT_JACKPOT_THRESHOLD,
    generateFixedCard,
    isCellCovered,
    checkWinningPatterns,
    validateJackpotThreshold,
    evaluateJackpotEligibility,
    verifyBingoClaim
} = require('../lib/bingoRules');

console.log('Running Bingo Rules & Jackpot Threshold Tests...\n');

// 1. Test Deterministic Cartela Generation
function testCartelaGeneration() {
    const card1 = generateFixedCard(1);
    const card1Again = generateFixedCard(1);
    const card2 = generateFixedCard(2);

    assert.strictEqual(card1.length, 5, 'Cartela must have 5 columns');
    card1.forEach((col, idx) => {
        assert.strictEqual(col.length, 5, `Column ${idx} must have 5 cells`);
        // Test standard 75-ball bingo column ranges
        const min = idx * 15 + 1;
        const max = (idx + 1) * 15;
        col.forEach((cell, rowIdx) => {
            if (idx === 2 && rowIdx === 2) {
                assert.strictEqual(cell, 'FREE', 'Center cell (col 2, row 2) must be "FREE"');
            } else {
                assert.strictEqual(typeof cell, 'number', `Cell [${idx}][${rowIdx}] must be a number`);
                assert.ok(cell >= min && cell <= max, `Number ${cell} must be in range ${min}-${max}`);
            }
        });
    });

    // Verify center square on multiple cards
    assert.strictEqual(card1[2][2], 'FREE', 'Card 1 center cell must be "FREE"');
    assert.strictEqual(card2[2][2], 'FREE', 'Card 2 center cell must be "FREE"');

    // Check determinism
    assert.deepStrictEqual(card1, card1Again, 'generateFixedCard must be deterministic for identical ticket IDs');
    assert.notDeepStrictEqual(card1, card2, 'Different ticket IDs must produce different cartelas');

    console.log('✓ 1. Deterministic cartela generation and 75-ball column ranges verified');
}

// 2. Test FREE Square Handling
function testFreeSquare() {
    const grid = generateFixedCard(10);
    const emptySet = new Set();

    // Center cell (2, 2) is always covered
    assert.strictEqual(grid[2][2], 'FREE', 'Center cell in grid must be represented as "FREE"');
    assert.strictEqual(isCellCovered(grid, 2, 2, emptySet), true, 'Center cell (2,2) must always be covered as FREE');
    // Non-center cells with empty called set are NOT covered
    assert.strictEqual(isCellCovered(grid, 0, 0, emptySet), false, 'Non-center cell without called number must not be covered');

    // Ensure FREE square is never treated as a called number
    const nonCalledSet = new Set([999]);
    assert.strictEqual(isCellCovered(grid, 0, 0, nonCalledSet), false, 'Uncalled number cell must not be covered');
    // Passing "FREE" in called set must not treat non-center cells as covered
    const setWithFree = new Set(['FREE']);
    assert.strictEqual(isCellCovered(grid, 0, 0, setWithFree), false, 'String "FREE" in called set must not cover non-free cells');

    console.log('✓ 2. Center FREE square rule and automatic coverage verified');
}

// 3. Test ONE LINE Winning Patterns
function testOneLinePatterns() {
    const grid = generateFixedCard(5);

    // Case 3a: Horizontal Row 0 (non-center row: needs 5 numbers)
    const row0Nums = [grid[0][0], grid[1][0], grid[2][0], grid[3][0], grid[4][0]];
    const row0Check = checkWinningPatterns(grid, row0Nums);
    assert.strictEqual(row0Check.isWin, true, 'Row 0 must win');
    assert.strictEqual(row0Check.patternName, 'HORIZONTAL_ROW');
    assert.strictEqual(row0Check.row, 0);

    // Case 3b: Horizontal Row 2 (center row: needs 4 numbers + FREE square)
    const row2Nums = [grid[0][2], grid[1][2], grid[3][2], grid[4][2]];
    const row2Check = checkWinningPatterns(grid, row2Nums);
    assert.strictEqual(row2Check.isWin, true, 'Row 2 (passing through FREE square) must win with 4 numbers');
    assert.strictEqual(row2Check.patternName, 'HORIZONTAL_ROW');
    assert.strictEqual(row2Check.row, 2);

    // Case 3c: Vertical Column 1 (non-center column: needs 5 numbers)
    const col1Nums = [grid[1][0], grid[1][1], grid[1][2], grid[1][3], grid[1][4]];
    const col1Check = checkWinningPatterns(grid, col1Nums);
    assert.strictEqual(col1Check.isWin, true, 'Column 1 (I) must win');
    assert.strictEqual(col1Check.patternName, 'VERTICAL_COLUMN');
    assert.strictEqual(col1Check.column, 1);

    // Case 3d: Vertical Column 2 (center column: needs 4 numbers + FREE square)
    const col2Nums = [grid[2][0], grid[2][1], grid[2][3], grid[2][4]];
    const col2Check = checkWinningPatterns(grid, col2Nums);
    assert.strictEqual(col2Check.isWin, true, 'Column 2 (N with FREE center) must win with 4 numbers');
    assert.strictEqual(col2Check.patternName, 'VERTICAL_COLUMN');
    assert.strictEqual(col2Check.column, 2);

    // Case 3e: Main Diagonal ((0,0), (1,1), FREE, (3,3), (4,4))
    const mainDiagNums = [grid[0][0], grid[1][1], grid[3][3], grid[4][4]];
    const mainDiagCheck = checkWinningPatterns(grid, mainDiagNums);
    assert.strictEqual(mainDiagCheck.isWin, true, 'Main diagonal must win with 4 numbers + FREE');
    assert.strictEqual(mainDiagCheck.patternName, 'DIAGONAL_MAIN');

    // Case 3f: Anti Diagonal ((4,0), (3,1), FREE, (1,3), (0,4))
    const antiDiagNums = [grid[4][0], grid[3][1], grid[1][3], grid[0][4]];
    const antiDiagCheck = checkWinningPatterns(grid, antiDiagNums);
    assert.strictEqual(antiDiagCheck.isWin, true, 'Anti diagonal must win with 4 numbers + FREE');
    assert.strictEqual(antiDiagCheck.patternName, 'DIAGONAL_ANTI');

    // Case 3g: Incomplete Line (4 of 5 numbers on non-free row 0)
    const incompleteNums = [grid[0][0], grid[1][0], grid[2][0], grid[3][0]]; // missing grid[4][0]
    const incompleteCheck = checkWinningPatterns(grid, incompleteNums);
    assert.strictEqual(incompleteCheck.isWin, false, 'Incomplete row must not win');

    console.log('✓ 3. ONE LINE winning patterns (horizontal, vertical, diagonals) verified');
}

// 4. Test FOUR CORNERS Winning Pattern
function testFourCornersPattern() {
    const grid = generateFixedCard(7);
    const cornerNums = [grid[0][0], grid[4][0], grid[0][4], grid[4][4]];

    const cornersCheck = checkWinningPatterns(grid, cornerNums);
    assert.strictEqual(cornersCheck.isWin, true, '4 corners must win');
    assert.strictEqual(cornersCheck.patternName, 'FOUR_CORNERS');

    // Incomplete corners (only 3 of 4)
    const threeCorners = [grid[0][0], grid[4][0], grid[0][4]];
    const incompleteCornersCheck = checkWinningPatterns(grid, threeCorners);
    assert.strictEqual(incompleteCornersCheck.isWin, false, '3 corners must NOT win');

    console.log('✓ 4. FOUR CORNERS winning pattern verified');
}

// 5. Test Jackpot Threshold Range & Validation (14 to 18)
function testJackpotThreshold() {
    assert.strictEqual(MIN_JACKPOT_THRESHOLD, 14);
    assert.strictEqual(MAX_JACKPOT_THRESHOLD, 18);
    assert.strictEqual(DEFAULT_JACKPOT_THRESHOLD, 16);

    // Validation clamps
    assert.strictEqual(validateJackpotThreshold(10), 14, 'Threshold below 14 must be clamped to 14');
    assert.strictEqual(validateJackpotThreshold(25), 18, 'Threshold above 18 must be clamped to 18');
    assert.strictEqual(validateJackpotThreshold(15), 15, 'Valid threshold 15 must be accepted');
    assert.strictEqual(validateJackpotThreshold('17'), 17, 'String threshold 17 must be parsed');
    assert.strictEqual(validateJackpotThreshold('invalid'), 16, 'Invalid string must fallback to default');

    // Eligibility evaluation
    const evalAt10 = evaluateJackpotEligibility(10, 15);
    assert.strictEqual(evalAt10.isEligible, true);
    assert.strictEqual(evalAt10.callsRemaining, 5);
    assert.strictEqual(evalAt10.status, 'ELIGIBLE');

    const evalAt15 = evaluateJackpotEligibility(15, 15);
    assert.strictEqual(evalAt15.isEligible, true);
    assert.strictEqual(evalAt15.callsRemaining, 0);
    assert.strictEqual(evalAt15.status, 'ELIGIBLE');

    const evalAt16 = evaluateJackpotEligibility(16, 15);
    assert.strictEqual(evalAt16.isEligible, false);
    assert.strictEqual(evalAt16.callsRemaining, 0);
    assert.strictEqual(evalAt16.status, 'EXPIRED');

    console.log('✓ 5. Jackpot call threshold (14 to 18) validation & countdown logic verified');
}

// 6. Test Authoritative Server Claim Verification (verifyBingoClaim)
function testServerClaimVerification() {
    const grid25 = generateFixedCard(25);
    const row0Nums = [grid25[0][0], grid25[1][0], grid25[2][0], grid25[3][0], grid25[4][0]];

    const basePlayer = {
        socketId: 'socket_1',
        phone: '0911223344',
        name: 'Abebe',
        tickets: [{ id: 25, grid: grid25 }]
    };

    const baseGame = {
        gameId: 1001,
        state: 'PLAYING',
        jackpotThreshold: 15,
        drawnNumbers: [...row0Nums],
        selectedCards: new Map([[25, { phone: '0911223344', socketId: 'socket_1' }]])
    };

    // Case 6a: Valid claim within threshold -> isJackpotWin: true
    const validClaim = verifyBingoClaim({
        player: basePlayer,
        game: baseGame,
        claimedTicketId: 25,
        clientGameId: 1001
    });
    assert.strictEqual(validClaim.ok, true, 'Valid claim must succeed');
    assert.strictEqual(validClaim.winningTicketId, 25);
    assert.strictEqual(validClaim.isJackpotWin, true, '5 calls <= 15 threshold must qualify as Jackpot Win');
    assert.strictEqual(validClaim.winningPattern.patternName, 'HORIZONTAL_ROW');

    // Case 6b: Valid claim past threshold (e.g. 17 calls made with threshold 15)
    const extraCalls = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const pastThresholdGame = {
        ...baseGame,
        drawnNumbers: [...row0Nums, ...extraCalls] // 17 calls total
    };
    const pastThresholdClaim = verifyBingoClaim({
        player: basePlayer,
        game: pastThresholdGame,
        claimedTicketId: 25,
        clientGameId: 1001
    });
    assert.strictEqual(pastThresholdClaim.ok, true, 'Win is still a valid bingo win');
    assert.strictEqual(pastThresholdClaim.isJackpotWin, false, '17 calls > 15 threshold must NOT qualify for jackpot');

    // Case 6c: Reject premature claim during WAITING
    const waitingClaim = verifyBingoClaim({
        player: basePlayer,
        game: { ...baseGame, state: 'WAITING' },
        claimedTicketId: 25
    });
    assert.strictEqual(waitingClaim.ok, false);
    assert.strictEqual(waitingClaim.code, 'PREMATURE_GAME_WAITING');

    // Case 6d: Reject claim on ENDED game
    const endedClaim = verifyBingoClaim({
        player: basePlayer,
        game: { ...baseGame, state: 'ENDED' },
        claimedTicketId: 25
    });
    assert.strictEqual(endedClaim.ok, false);
    assert.strictEqual(endedClaim.code, 'GAME_ALREADY_ENDED');

    // Case 6e: Reject stale game ID
    const staleClaim = verifyBingoClaim({
        player: basePlayer,
        game: baseGame,
        clientGameId: 999
    });
    assert.strictEqual(staleClaim.ok, false);
    assert.strictEqual(staleClaim.code, 'STALE_GAME_ID');

    // Case 6f: Reject unauthenticated session
    const unauthClaim = verifyBingoClaim({
        player: null,
        game: baseGame
    });
    assert.strictEqual(unauthClaim.ok, false);
    assert.strictEqual(unauthClaim.code, 'UNAUTHENTICATED_PLAYER');

    // Case 6g: Reject ticket not owned by player
    const notOwnedClaim = verifyBingoClaim({
        player: basePlayer,
        game: baseGame,
        claimedTicketId: 99 // player only has 25
    });
    assert.strictEqual(notOwnedClaim.ok, false);
    assert.strictEqual(notOwnedClaim.code, 'TICKET_NOT_OWNED');

    // Case 6h: Reject premature call count (fewer than 4 numbers drawn)
    const prematureFewCalls = verifyBingoClaim({
        player: basePlayer,
        game: { ...baseGame, drawnNumbers: [1, 2, 3] },
        claimedTicketId: 25
    });
    assert.strictEqual(prematureFewCalls.ok, false);
    assert.strictEqual(prematureFewCalls.code, 'PREMATURE_FEW_CALLS');

    // Case 6i: Reject cartela with no winning pattern
    const noWinClaim = verifyBingoClaim({
        player: basePlayer,
        game: { ...baseGame, drawnNumbers: [1, 16, 31, 46, 61, 2, 17] }, // random calls not forming pattern
        claimedTicketId: 25
    });
    assert.strictEqual(noWinClaim.ok, false);
    assert.strictEqual(noWinClaim.code, 'NO_WINNING_PATTERN');

    // Case 6j: Tampered cartela protection: client sends manipulated grid in ticket object,
    // server must use generateFixedCard(25) and ignore client grid
    const tamperedPlayer = {
        ...basePlayer,
        tickets: [{
            id: 25,
            grid: [
                [999, 999, 999, 999, 999], // Fake fabricated winning row
                [999, 999, 999, 999, 999],
                [999, 999, 999, 999, 999],
                [999, 999, 999, 999, 999],
                [999, 999, 999, 999, 999]
            ]
        }]
    };
    const tamperedGame = {
        ...baseGame,
        drawnNumbers: [999, 999, 999, 999] // If server used client grid it would win, but real ticket #25 doesn't have 999
    };
    const tamperedClaim = verifyBingoClaim({
        player: tamperedPlayer,
        game: tamperedGame,
        claimedTicketId: 25
    });
    assert.strictEqual(tamperedClaim.ok, false, 'Tampered grid must be rejected because authoritative card #25 has numbers 1-75');

    console.log('✓ 6. Server-side claim verification & anti-cheat protections verified');
}

testCartelaGeneration();
testFreeSquare();
testOneLinePatterns();
testFourCornersPattern();
testJackpotThreshold();
testServerClaimVerification();

console.log('\nALL BINGO RULES & JACKPOT THRESHOLD TESTS PASSED! ✅');
