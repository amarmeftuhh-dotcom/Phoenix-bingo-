process.env.NODE_ENV = 'test';
global.__PHOENIX_TEST_MODE = true;
process.env.TELEGRAM_MODE = 'webhook';

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const {
    server,
    currentGame,
    inMemoryUsers,
    resetGame,
    flushPendingBotSchedule,
    generateFixedCard,
    hashPassword
} = require('../server');

function requestJson(port, method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

(async () => {
    console.log('🧪 Running Deposit/Withdraw ObjectId, Human Bot Behavior & Single-Round Sync Tests...');

    const listener = await new Promise(resolve => {
        const s = server.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = listener.address().port;

    try {
        // Seed test user with playBalance & mainBalance
        const testPhone = '0911998877';
        const hashedPass = await hashPassword('pass1234');
        const existingUser = {
            _id: new mongoose.Types.ObjectId().toString(),
            name: 'Test Player',
            phone: testPhone,
            password: hashedPass,
            mainBalance: 500,
            playBalance: 200,
            played: 0,
            won: 0
        };
        if (inMemoryUsers instanceof Map) {
            inMemoryUsers.set(testPhone, existingUser);
        } else if (Array.isArray(inMemoryUsers)) {
            inMemoryUsers.push(existingUser);
        }

        // TEST 1: Deposit & Withdraw /api/request-tx must never fail with BSONError Cast to ObjectId
        const depRes = await requestJson(port, 'POST', '/api/request-tx', {
            phone: testPhone,
            type: 'deposit',
            amount: 100,
            method: 'telebirr',
            sms: 'You have transferred ETB 100.00 to Phoenix Bingo. Transaction ID: ABC9988771'
        });
        assert.strictEqual(depRes.status, 200, 'Deposit HTTP status should be 200');
        assert.strictEqual(depRes.body.success, true, `Deposit should succeed, got: ${JSON.stringify(depRes.body)}`);

        const witRes = await requestJson(port, 'POST', '/api/request-tx', {
            phone: testPhone,
            type: 'withdraw',
            amount: 60,
            method: 'telebirr',
            destinationPhone: testPhone
        });
        assert.strictEqual(witRes.status, 200, 'Withdraw HTTP status should be 200');
        assert.strictEqual(witRes.body.success, true, `Withdraw should succeed, got: ${JSON.stringify(witRes.body)}`);

        const txHistRes = await requestJson(port, 'GET', `/api/user/transactions/${testPhone}`);
        assert.strictEqual(txHistRes.body.success, true, 'Transaction history should load');
        for (const tx of txHistRes.body.txs) {
            assert.strictEqual(
                mongoose.Types.ObjectId.isValid(String(tx._id)),
                true,
                `Transaction _id must be a valid MongoDB ObjectId (not "tx_..."), got: ${tx._id}`
            );
        }
        console.log('  ✅ Test 1 Passed: Deposit and Withdraw create valid ObjectId transactions without BSONError');

        // TEST 2: Human-like staggered bot entry behavior during countdown
        global.__inMemorySettings = {
            ...(global.__inMemorySettings || {}),
            isBotSystemActive: true,
            botDist1: 0,
            botDist2: 0,
            botDist3: 3,
            botDist4: 0,
            gameTimer: 30
        };

        resetGame();
        // Immediately after resetGame(), bots should be scheduled gradually (not all 9 tickets dumped at 0ms)
        const immediateTaken = currentGame.selectedCards.size;
        assert.ok(immediateTaken < 9, `Bots should join gradually like humans, not all 9 at 0ms (got ${immediateTaken})`);
        assert.ok(Array.isArray(currentGame.botEntryQueue) && currentGame.botEntryQueue.length > 0, 'Bot entry queue should have staggered actions scheduled');

        // Wait ~2.2 seconds and verify some bot tickets have trickled in naturally
        await new Promise(r => setTimeout(r, 2200));
        const midTaken = currentGame.selectedCards.size;
        assert.ok(midTaken > immediateTaken, `Bots should gradually select cartelas over time (0ms: ${immediateTaken} -> 2.2s: ${midTaken})`);

        // Flushing when countdown finishes ensures all remaining bot cartelas are placed before ball 1
        flushPendingBotSchedule();
        assert.strictEqual(currentGame.selectedCards.size, 9, `All 9 bot cartelas should be active by game start, got ${currentGame.selectedCards.size}`);
        console.log('  ✅ Test 2 Passed: Bots join and pick cartelas with human-like staggered timing');

        // TEST 3: Single-round cartela validity + Refresh/Lag persistence during the active round
        global.__inMemorySettings.isBotSystemActive = false;
        global.__inMemorySettings.botDist3 = 0;
        resetGame();
        const activeRoundId = currentGame.gameId;

        // Player buys cartela #25 in Round activeRoundId
        currentGame.selectedCards.set(25, {
            pending: false,
            socketId: 'sock_initial',
            phone: testPhone,
            name: 'Test Player',
            playPaid: 10,
            mainPaid: 0,
            gameId: activeRoundId
        });
        currentGame.players.set('sock_initial', {
            socketId: 'sock_initial',
            telegramId: testPhone,
            phone: testPhone,
            name: 'Test Player',
            disconnected: true, // Simulate player disconnected / refreshed browser
            tickets: [{
                id: 25,
                grid: generateFixedCard(25),
                playPaid: 10,
                mainPaid: 0,
                gameId: activeRoundId
            }]
        });

        // Verify /api/user/my-active-tickets/:phone recovers cartela #25 across refresh/lag in the same round
        const activeRes = await requestJson(port, 'GET', `/api/user/my-active-tickets/${testPhone}`, null, {
            'X-User-Password': 'pass1234'
        });
        assert.strictEqual(activeRes.status, 200, 'Active tickets endpoint should return 200');
        assert.strictEqual(activeRes.body.success, true, 'Active tickets response should succeed');
        assert.strictEqual(activeRes.body.gameId, activeRoundId, 'Active tickets response should include current gameId');
        assert.ok(Array.isArray(activeRes.body.ticketsData) && activeRes.body.ticketsData.some(t => t.id === 25), 'Refreshed player must recover cartela #25 in the same round');

        // Now advance to the next round and verify cartela #25 does NOT carry over
        resetGame();
        assert.notStrictEqual(currentGame.gameId, activeRoundId, 'New round should have incremented gameId');
        assert.strictEqual(currentGame.selectedCards.has(25), false, 'Cartela #25 must be cleared in the new round');

        const nextRoundRes = await requestJson(port, 'GET', `/api/user/my-active-tickets/${testPhone}`, null, {
            'X-User-Password': 'pass1234'
        });
        assert.strictEqual(nextRoundRes.body.ticketsData.length, 0, 'Cartelas from previous round must NOT carry over to the next round');
        console.log('  ✅ Test 3 Passed: Cartela is preserved across refresh/lag in the same round and strictly cleared for the next round');
        console.log('🎉 ALL DEPOSIT/WITHDRAW OBJECTID, HUMAN BOT & SINGLE-ROUND SYNC TESTS PASSED! ✅');
    } catch (err) {
        console.error('❌ Test failed:', err);
        process.exit(1);
    } finally {
        await new Promise(resolve => listener.close(resolve));
        process.exit(0);
    }
})();
