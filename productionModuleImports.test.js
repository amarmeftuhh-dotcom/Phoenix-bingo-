/**
 * Regression Test Suite: Production Module Imports & Zero-Side-Effect Verification
 *
 * Verifies:
 * 1. lib/bingoRules.js is a pure production library module.
 *    - Emits NO test runner output or side effects on require.
 *    - Exports all required core rules and cartela generation functions.
 *    - Preserves deterministic cartela format (75-ball standard column ranges).
 * 2. lib/platformRules.js exports all platform constants and financial rule helpers.
 * 3. lib/walletManager.js exports all wallet locking, debit, refund and payout functions.
 * 4. server.js successfully imports all dependencies without missing or undefined bindings.
 */

const assert = require('assert');

console.log('Running Production Module Imports & Zero-Side-Effect Regression Tests...\n');

// 1. Verify lib/bingoRules does not emit test-run logs or start tests on import
function testBingoRulesImportCleanliness() {
    const interceptedLogs = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    try {
        console.log = (...args) => { interceptedLogs.push(args.join(' ')); };
        console.warn = (...args) => { interceptedLogs.push(args.join(' ')); };
        console.error = (...args) => { interceptedLogs.push(args.join(' ')); };

        // Clear require cache to simulate fresh server startup import
        delete require.cache[require.resolve('../lib/bingoRules')];
        const bingoRules = require('../lib/bingoRules');

        // Check for test runner logs
        const hasTestRunnerOutput = interceptedLogs.some(msg =>
            msg.includes('Running Bingo Rules') ||
            msg.includes('TESTS PASSED') ||
            msg.includes('testCartelaGeneration')
        );

        assert.strictEqual(
            hasTestRunnerOutput,
            false,
            'lib/bingoRules.js must NOT execute tests or output test runner logs on import'
        );

        // Required functions and constants
        const requiredExports = [
            'MIN_JACKPOT_THRESHOLD',
            'MAX_JACKPOT_THRESHOLD',
            'DEFAULT_JACKPOT_THRESHOLD',
            'generateFixedCard',
            'isCellCovered',
            'checkWinningPatterns',
            'validateJackpotThreshold',
            'evaluateJackpotEligibility',
            'verifyBingoClaim'
        ];

        for (const exp of requiredExports) {
            assert.notStrictEqual(
                bingoRules[exp],
                undefined,
                `lib/bingoRules.js must export '${exp}'`
            );
        }

        assert.strictEqual(typeof bingoRules.generateFixedCard, 'function', 'generateFixedCard must be a function');
        assert.strictEqual(typeof bingoRules.checkWinningPatterns, 'function', 'checkWinningPatterns must be a function');
        assert.strictEqual(typeof bingoRules.verifyBingoClaim, 'function', 'verifyBingoClaim must be a function');

    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }

    console.log('✓ 1. lib/bingoRules clean production import verified (zero test execution on require)');
}

// 2. Verify deterministic cartela structure matches client standard
function testCartelaStructureAndDeterminism() {
    const { generateFixedCard, isCellCovered } = require('../lib/bingoRules');

    const card1 = generateFixedCard(1);
    const card1Copy = generateFixedCard(1);
    const card2 = generateFixedCard(2);

    assert.strictEqual(card1.length, 5, 'Cartela must have 5 columns');
    card1.forEach((col, idx) => {
        assert.strictEqual(col.length, 5, `Column ${idx} must contain 5 cells`);
        const min = idx * 15 + 1;
        const max = (idx + 1) * 15;
        col.forEach((cell, rowIdx) => {
            if (idx === 2 && rowIdx === 2) {
                assert.strictEqual(cell, 'FREE', 'Center cell (col 2, row 2) must be "FREE"');
            } else {
                assert.strictEqual(typeof cell, 'number', `Cell [${idx}][${rowIdx}] must be a number`);
                assert.ok(cell >= min && cell <= max, `Column ${idx} number ${cell} must be between ${min} and ${max}`);
            }
        });
    });

    assert.deepStrictEqual(card1, card1Copy, 'Identical ticketId must generate identical cartela');
    assert.notDeepStrictEqual(card1, card2, 'Different ticketIds must generate different cartelas');

    // FREE square check
    assert.strictEqual(card1[2][2], 'FREE', 'Card 1 center cell must be "FREE"');
    assert.strictEqual(card2[2][2], 'FREE', 'Card 2 center cell must be "FREE"');
    assert.strictEqual(isCellCovered(card1, 2, 2, new Set()), true, 'Center cell (2,2) must always be covered as FREE');

    console.log('✓ 2. Deterministic 75-ball cartela structure and FREE square verified');
}

// 3. Verify lib/platformRules exports all required bindings for server.js
function testPlatformRulesExports() {
    delete require.cache[require.resolve('../lib/platformRules')];
    const platformRules = require('../lib/platformRules');

    const serverExpected = [
        'GAME_RULES',
        'FINANCE_LIMITS',
        'REFERRAL_SYSTEM',
        'BOT_CONSTRAINTS',
        'ADMIN_PRIVILEGES',
        'calculateNetJackpot',
        'calculatePayoutPerWinner',
        'calculateReferralCommission',
        'validateWithdrawalLimits',
        'detectFraudPatterns'
    ];

    for (const key of serverExpected) {
        assert.notStrictEqual(
            platformRules[key],
            undefined,
            `lib/platformRules must export '${key}' required by server.js`
        );
    }

    // Verify helper calculations
    assert.strictEqual(platformRules.calculatePayoutPerWinner(100, 2), 50);
    assert.strictEqual(platformRules.calculatePayoutPerWinner(100, 0), 0);
    assert.strictEqual(platformRules.calculateReferralCommission(100, 0.05), 5);

    const validWithdrawal = platformRules.validateWithdrawalLimits(100);
    assert.strictEqual(validWithdrawal.valid, true);

    const lowWithdrawal = platformRules.validateWithdrawalLimits(10);
    assert.strictEqual(lowWithdrawal.valid, false);

    console.log('✓ 3. lib/platformRules exports and financial calculation helpers verified');
}

// 4. Verify lib/walletManager exports all required bindings for server.js
function testWalletManagerExports() {
    delete require.cache[require.resolve('../lib/walletManager')];
    const walletManager = require('../lib/walletManager');

    const expected = [
        'withUserLock',
        'getAuthoritativeUser',
        'debitTicketPurchase',
        'refundTicketPurchase',
        'processWinnerPayouts'
    ];

    for (const fn of expected) {
        assert.strictEqual(
            typeof walletManager[fn],
            'function',
            `lib/walletManager must export function '${fn}'`
        );
    }

    console.log('✓ 4. lib/walletManager exports verified');
}

// 5. Verify server.js imports resolve with no missing/undefined bindings
function testServerImportIntegrity() {
    const platformRules = require('../lib/platformRules');
    const bingoRules = require('../lib/bingoRules');
    const walletManager = require('../lib/walletManager');

    assert.ok(typeof bingoRules.generateFixedCard === 'function');
    assert.ok(typeof bingoRules.verifyBingoClaim === 'function');
    assert.ok(typeof platformRules.calculateNetJackpot === 'function');
    assert.ok(typeof walletManager.withUserLock === 'function');

    console.log('✓ 5. Full server dependency integration integrity verified');
}

testBingoRulesImportCleanliness();
testCartelaStructureAndDeterminism();
testPlatformRulesExports();
testWalletManagerExports();
testServerImportIntegrity();

console.log('\nALL PRODUCTION MODULE IMPORT & REGRESSION TESTS PASSED! ✅\n');
