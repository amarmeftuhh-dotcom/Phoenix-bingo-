const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

process.env.TELEGRAM_MODE = 'webhook';
const TEST_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_testToken';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || TEST_BOT_TOKEN;

const {
    app,
    verifyTelegramWebAppData,
    registerTelegramUser,
    currentGame
} = require('../server');

function createTestInitData({
    botToken = process.env.TELEGRAM_BOT_TOKEN,
    userId = 100000001,
    firstName = 'TestPlayer',
    username = 'testplayer',
    authDate = Math.floor(Date.now() / 1000),
    wrongHash = false,
    tamper = false
} = {}) {
    const userJson = JSON.stringify({
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

async function runActiveTicketsSecurityTests() {
    console.log('Running Active Tickets Security & Ticket Display tests...');

    const serverInstance = http.createServer(app);
    await new Promise(resolve => serverInstance.listen(0, '127.0.0.1', resolve));

    try {
        // Register Player A and Player B
        await registerTelegramUser({
            telegramId: '200000001',
            phone: '0911000001',
            name: 'Player One'
        });

        await registerTelegramUser({
            telegramId: '200000002',
            phone: '0911000002',
            name: 'Player Two'
        });

        const playerAInitData = createTestInitData({ userId: 200000001, firstName: 'Player One' });
        const playerBInitData = createTestInitData({ userId: 200000002, firstName: 'Player Two' });

        // Seed currentGame with active tickets for Player One and Player Two
        currentGame.players.set('socket_p1', {
            socketId: 'socket_p1',
            telegramId: '200000001',
            phone: '0911000001',
            name: 'Player One',
            tickets: [{ id: 25, grid: [[1,2,3,4,5],[16,17,18,19,20],[31,32,0,34,35],[46,47,48,49,50],[61,62,63,64,65]] }]
        });

        currentGame.players.set('socket_p2', {
            socketId: 'socket_p2',
            telegramId: '200000002',
            phone: '0911000002',
            name: 'Player Two',
            tickets: [{ id: 40, grid: [[6,7,8,9,10],[21,22,23,24,25],[36,37,0,39,40],[51,52,53,54,55],[66,67,68,69,70]] }]
        });

        // 1. Missing initData is rejected with 401
        let res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets/0911000001',
            method: 'GET'
        });
        assert.strictEqual(res.status, 401, 'Missing initData should be rejected with 401');
        console.log('✓ Test 1: Missing initData strictly rejected with 401');

        // 2. Raw telegramId without initData is rejected with 401
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets?telegramId=200000001',
            method: 'GET'
        });
        assert.strictEqual(res.status, 401, 'Raw telegramId should not authenticate');
        console.log('✓ Test 2: Raw telegramId query strictly rejected with 401');

        // 3. Tampered initData is rejected with 401
        const tamperedInitData = createTestInitData({ userId: 200000001, tamper: true });
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets',
            method: 'GET',
            headers: { 'x-telegram-init-data': tamperedInitData }
        });
        assert.strictEqual(res.status, 401, 'Tampered initData should be rejected with 401');
        console.log('✓ Test 3: Tampered initData strictly rejected with 401');

        // 4. Invalid hash is rejected with 401
        const wrongHashInitData = createTestInitData({ userId: 200000001, wrongHash: true });
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets',
            method: 'GET',
            headers: { 'x-telegram-init-data': wrongHashInitData }
        });
        assert.strictEqual(res.status, 401, 'Wrong hash should be rejected with 401');
        console.log('✓ Test 4: Wrong hash strictly rejected with 401');

        // 5. Expired initData (> 24 hours) is rejected with 401
        const expiredInitData = createTestInitData({
            userId: 200000001,
            authDate: Math.floor(Date.now() / 1000) - (25 * 3600)
        });
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets',
            method: 'GET',
            headers: { 'x-telegram-init-data': expiredInitData }
        });
        assert.strictEqual(res.status, 401, 'Expired initData should be rejected with 401');
        console.log('✓ Test 5: Expired initData strictly rejected with 401');

        // 6. Valid Player A initData returns only Player A's active tickets (Cartela 25)
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets',
            method: 'GET',
            headers: { 'x-telegram-init-data': playerAInitData }
        });
        assert.strictEqual(res.status, 200, 'Valid initData should return 200');
        assert.strictEqual(res.data.success, true);
        assert(Array.isArray(res.data.ticketsData));
        assert.strictEqual(res.data.ticketsData.length, 1);
        assert.strictEqual(res.data.ticketsData[0].id, 25);
        console.log('✓ Test 6: Player A receives only Cartela #25');

        // 7. Player A passes Player B's phone in URL - Server ignores URL phone!
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets/0911000002', // Player B's phone!
            method: 'GET',
            headers: { 'x-telegram-init-data': playerAInitData }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.ticketsData.length, 1);
        assert.strictEqual(res.data.ticketsData[0].id, 25, 'Server must ignore URL phone and return Player A cartela');
        assert(!res.data.ticketsData.some(t => t.id === 40), 'Must NOT contain Player B cartela');
        console.log('✓ Test 7: Server ignores URL phone parameter; Player A receives only Player A cartela');

        // 8. Player B receives only Cartela #40
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets',
            method: 'GET',
            headers: { 'x-telegram-init-data': playerBInitData }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.ticketsData.length, 1);
        assert.strictEqual(res.data.ticketsData[0].id, 40);
        assert(!res.data.ticketsData.some(t => t.id === 25));
        console.log('✓ Test 8: Player B receives only Cartela #40');

        // 9. Authorization via Bearer header or POST body
        res = await makeRequest(serverInstance, {
            path: '/api/user/my-active-tickets',
            method: 'POST',
            body: { initData: playerAInitData }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.ticketsData[0].id, 25);
        console.log('✓ Test 9: POST with body initData works seamlessly');

        console.log('ALL ACTIVE TICKETS SECURITY TESTS PASSED! ✅');
    } finally {
        await new Promise(resolve => serverInstance.close(resolve));
    }
}

if (require.main === module) {
    runActiveTicketsSecurityTests().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

module.exports = { runActiveTicketsSecurityTests };
