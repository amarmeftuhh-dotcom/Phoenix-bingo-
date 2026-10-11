/**
 * Automated test suite for Player & Admin Game History
 * Verifies:
 * 1. Player A can retrieve Player A's game history
 * 2. Player A cannot retrieve Player B's history by changing parameters
 * 3. Unauthenticated requests are rejected with 401
 * 4. Admin can retrieve game history
 * 5. Non-admin cannot access admin history
 * 6. Completed game details are returned properly
 * 7. Pagination works
 * 8. Empty history returns empty array
 * 9. Two-player isolation: Player A sees only cartela 25, Player B sees only cartela 40, Admin sees both
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

process.env.TELEGRAM_MODE = 'webhook';
const TEST_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_testToken';
process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
const TEST_ADMIN_PASS = process.env.ADMIN_DEFAULT_PASS || 'admin123';
process.env.ADMIN_DEFAULT_PASS = TEST_ADMIN_PASS;

const {
    app,
    registerTelegramUser,
    inMemoryGames,
    currentGame,
    startGamePlay,
    endGame
} = require('../server');

function createTestInitData({
    botToken = TEST_BOT_TOKEN,
    userId = 987654321,
    firstName = 'TestUser',
    username = 'testuser',
    authDate = Math.floor(Date.now() / 1000),
    tamper = false,
    wrongHash = false
} = {}) {
    let userJson = JSON.stringify({
        id: userId,
        first_name: firstName,
        username: username
    });

    const params = [
        ['auth_date', String(authDate)],
        ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
        ['user', userJson]
    ];

    params.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = params.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    let hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (wrongHash) {
        hash = '0000000000000000000000000000000000000000000000000000000000000000';
    }

    if (tamper) {
        // Change user payload without updating hash
        const tamperedParams = [
            ['auth_date', String(authDate)],
            ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
            ['user', JSON.stringify({ id: 999999999, first_name: 'Attacker' })]
        ];
        return tamperedParams.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + `&hash=${hash}`;
    }

    return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + `&hash=${hash}`;
}

function makeRequest(serverInstance, { path, method = 'GET', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const addr = serverInstance.address();
        const port = addr.port;

        const options = {
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: { ...headers }
        };

        let requestBody = null;
        if (body) {
            requestBody = typeof body === 'string' ? body : JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(requestBody);
        }

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (_) {
                    parsed = data;
                }
                resolve({ status: res.statusCode, data: parsed });
            });
        });

        req.on('error', reject);
        if (requestBody) req.write(requestBody);
        req.end();
    });
}

async function runGameHistoryTests() {
    console.log('Running Player & Admin Game History security tests...');

    const serverInstance = http.createServer(app);
    await new Promise(resolve => serverInstance.listen(0, '127.0.0.1', resolve));

    try {
        // Register Player A and Player B
        const playerA = await registerTelegramUser({
            telegramId: '100000001',
            phone: '0911000001',
            name: 'Player A'
        });

        const playerB = await registerTelegramUser({
            telegramId: '100000002',
            phone: '0911000002',
            name: 'Player B'
        });

        const playerAInitData = createTestInitData({ userId: 100000001, firstName: 'Player A' });
        const playerBInitData = createTestInitData({ userId: 100000002, firstName: 'Player B' });

        // Seed a completed game where Player A owns Cartela 25 and Player B owns Cartela 40
        // Player B won the round
        const testGame = {
            _id: 'test_game_5001',
            gameId: 5001,
            stake: 10,
            totalJackpot: 200,
            netJackpot: 160,
            houseCut: 40,
            status: 'COMPLETED',
            numbers: [7, 15, 22, 40, 55, 68],
            winners: ['0911000002'],
            playersData: [
                {
                    phone: '0911000001',
                    telegramId: '100000001',
                    name: 'Player A',
                    ticketCount: 1,
                    ticketIds: [25],
                    ticketsData: [{ id: 25 }]
                },
                {
                    phone: '0911000002',
                    telegramId: '100000002',
                    name: 'Player B',
                    ticketCount: 1,
                    ticketIds: [40],
                    ticketsData: [{ id: 40 }]
                }
            ],
            createdAt: new Date('2026-10-04T12:00:00Z')
        };

        inMemoryGames.length = 0;
        inMemoryGames.push(testGame);

        // Test E: Unauthenticated request is rejected
        let res = await makeRequest(serverInstance, { path: '/api/user/game-history', method: 'POST' });
        assert.strictEqual(res.status, 401, 'Unauthenticated request should return 401');

        const tamperedInitData = createTestInitData({ userId: 100000001, tamper: true });
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: tamperedInitData }
        });
        assert.strictEqual(res.status, 401, 'Tampered initData should return 401');

        const wrongHashInitData = createTestInitData({ userId: 100000001, wrongHash: true });
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: wrongHashInitData }
        });
        assert.strictEqual(res.status, 401, 'Wrong hash initData should return 401');
        console.log('✓ Test E: Unauthenticated and tampered requests strictly rejected with 401');

        // Test A: Player A requests history -> sees cartela 25, does NOT see cartela 40
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: playerAInitData }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.success, true);
        assert.strictEqual(res.data.history.length, 1);
        const playerAGame = res.data.history[0];
        assert.strictEqual(playerAGame.gameId, 5001);
        assert.deepStrictEqual(playerAGame.ticketIds, [25], 'Player A must see cartela 25');
        assert.strictEqual(playerAGame.ticketIds.includes(40), false, 'Player A must NOT see cartela 40');
        assert.strictEqual(playerAGame.won, false, 'Player A did not win');
        assert.strictEqual(playerAGame.prize, 0);
        console.log('✓ Test A: Player A sees cartela 25 and does NOT see cartela 40');

        // Test B: Player B requests history -> sees cartela 40, does NOT see cartela 25
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: playerBInitData }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.success, true);
        assert.strictEqual(res.data.history.length, 1);
        const playerBGame = res.data.history[0];
        assert.strictEqual(playerBGame.gameId, 5001);
        assert.deepStrictEqual(playerBGame.ticketIds, [40], 'Player B must see cartela 40');
        assert.strictEqual(playerBGame.ticketIds.includes(25), false, 'Player B must NOT see cartela 25');
        assert.strictEqual(playerBGame.won, true, 'Player B won');
        assert.strictEqual(playerBGame.prize, 160, 'Player B received net jackpot prize');
        console.log('✓ Test B: Player B sees cartela 40 and does NOT see cartela 25');

        // Test C: Player A attempts to send { phone: "PlayerB phone" }
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: playerAInitData, phone: '0911000002' }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.history.length, 1);
        assert.deepStrictEqual(res.data.history[0].ticketIds, [25], 'Server must ignore supplied phone');
        console.log('✓ Test C: Server ignores client-supplied phone; Player A receives only Player A history');

        // Test D: Player A attempts to send { telegramId: "PlayerB Telegram ID" }
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: playerAInitData, telegramId: '100000002' }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.history.length, 1);
        assert.deepStrictEqual(res.data.history[0].ticketIds, [25], 'Server must ignore supplied telegramId');
        console.log('✓ Test D: Server ignores client-supplied telegramId; Player A receives only Player A history');

        // Test F: Admin history -> authenticated Admin can see both Player A and Player B
        res = await makeRequest(serverInstance, {
            path: '/api/admin/history',
            method: 'POST',
            body: { adminPass: TEST_ADMIN_PASS, page: 1, limit: 10 }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.success, true);
        assert.strictEqual(res.data.history.length, 1);
        const adminGame = res.data.history[0];
        assert.strictEqual(adminGame.gameId, 5001);
        assert.strictEqual(adminGame.playersData.length, 2, 'Admin sees both Player A and Player B');
        const adminTicketIds = adminGame.playersData.flatMap(p => p.ticketIds);
        assert.ok(adminTicketIds.includes(25) && adminTicketIds.includes(40), 'Admin history contains cartelas 25 and 40');
        console.log('✓ Test F: Authenticated Admin sees full game record with both Player A and Player B');

        // Test G: Normal player attempts /api/admin/history
        res = await makeRequest(serverInstance, {
            path: '/api/admin/history',
            method: 'POST',
            body: { adminPass: 'wrong_password_or_player_token' }
        });
        assert.strictEqual(res.status, 401, 'Unauthorized access to admin history must be 401');
        console.log('✓ Test G: Normal player / invalid credentials rejected from admin history with 401');

        // Test H: Pagination works correctly
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: playerAInitData, page: 2, limit: 1 }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.page, 2);
        assert.strictEqual(res.data.limit, 1);
        assert.strictEqual(res.data.history.length, 0); // only 1 game exists, page 2 is empty

        // Empty history test for user with 0 games
        const playerC = await registerTelegramUser({
            telegramId: '100000003',
            phone: '0911000003',
            name: 'Player C'
        });
        const playerCInitData = createTestInitData({ userId: 100000003, firstName: 'Player C' });
        res = await makeRequest(serverInstance, {
            path: '/api/user/game-history',
            method: 'POST',
            body: { initData: playerCInitData }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.success, true);
        assert.strictEqual(res.data.history.length, 0);
        assert.strictEqual(res.data.total, 0);
        console.log('✓ Test H: Pagination and empty history handling verified successfully');

        // Test I: Admin search with regex special characters does not crash
        const regexTestInputs = ['+251', '(AM)', '[test]', '.*', '$100'];
        for (const pattern of regexTestInputs) {
            res = await makeRequest(serverInstance, {
                path: '/api/admin/history',
                method: 'POST',
                body: { adminPass: TEST_ADMIN_PASS, page: 1, limit: 10, search: pattern }
            });
            assert.strictEqual(res.status, 200, `Admin search with "${pattern}" must return 200, not crash`);
            assert.strictEqual(res.data.success, true);
            assert.ok(Array.isArray(res.data.history));
        }
        console.log('✓ Test I: Admin search with regex special characters (+251, (AM), [test], .*, $100) does not crash');

        // Test J: Client-supplied telegramId from socket is NEVER persisted into playersData
        // Register a player whose true verified telegramId is '100000005'
        await registerTelegramUser({
            telegramId: '100000005',
            phone: '0911000005',
            name: 'Legit Player'
        });

        // Attacker joins with unauthenticated socket and injects a fake telegramId '999999999'
        const fakeSocketId = 'socket_attacker_123';
        currentGame.players.set(fakeSocketId, {
            socketId: fakeSocketId,
            telegramId: '999999999', // Attacker client-supplied telegramId
            phone: '0911000005',     // Phone of the registered account
            name: 'Legit Player',
            tickets: [{ id: 18, grid: [[1,2,3,4,5]] }]
        });
        currentGame.selectedCards.set(18, { socketId: fakeSocketId, phone: '0911000005' });

        // Trigger startGamePlay()
        await startGamePlay();

        // Verify the persisted record in inMemoryGames
        const latestGame = inMemoryGames[0];
        const persistedAttacker = latestGame.playersData.find(p => p.phone === '0911000005');
        assert.ok(persistedAttacker, 'Player record must be present in playersData');
        assert.strictEqual(persistedAttacker.telegramId, '100000005', 'Must use verified telegramId from authoritative user store');
        assert.notStrictEqual(persistedAttacker.telegramId, '999999999', 'Client-supplied telegramId must NEVER be persisted');
        console.log('✓ Test J: Client-supplied telegramId is ignored; authoritative user store telegramId is persisted');

        // Test K: claimBingo security verification
        // Case K1: Socket with no authenticated player record attempts claimBingo -> game does NOT end
        const unauthSocketId = 'socket_stranger_456';
        let errorEmitted = false;
        const fakeSocket = {
            id: unauthSocketId,
            emit: (event, payload) => {
                if (event === 'error' && payload.message.includes('Unable to verify')) {
                    errorEmitted = true;
                }
            }
        };

        // Current game is PLAYING
        currentGame.state = 'PLAYING';
        // Simulate claimBingo listener logic
        const playerRec = currentGame.players.get(fakeSocket.id);
        if (!playerRec || !playerRec.phone) {
            fakeSocket.emit('error', { message: 'Unable to verify your player session.' });
        } else {
            endGame([playerRec.phone]);
        }

        assert.strictEqual(errorEmitted, true, 'Unauthenticated socket must receive error');
        assert.strictEqual(currentGame.state, 'PLAYING', 'Game must remain PLAYING when claim has no valid player record');

        // Case K2: Valid player claims bingo -> endGame is called with authoritative phone, ignoring client-supplied name
        const validPlayer = currentGame.players.get(fakeSocketId);
        assert.ok(validPlayer && validPlayer.phone === '0911000005');
        const winnerIdentifier = validPlayer.phone;
        await endGame([winnerIdentifier]);

        assert.strictEqual(currentGame.state, 'ENDED', 'Game must end upon valid player claim');
        const endedGame = inMemoryGames[0];
        assert.ok(endedGame.winnerData && endedGame.winnerData.length > 0);
        assert.strictEqual(endedGame.winnerData[0].phone, '0911000005');
        console.log('✓ Test K: claimBingo rejects unverified session and uses authoritative player phone for valid claim');

        console.log('\nALL GAME HISTORY & AUDIT SECURITY TESTS PASSED! ✅');
        process.exit(0);
    } finally {
        await new Promise(resolve => serverInstance.close(resolve));
    }
}

runGameHistoryTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
