const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

// Disable bot polling and use test token for unit tests
process.env.TELEGRAM_MODE = 'webhook';
const TEST_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_testToken';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || TEST_BOT_TOKEN;

const {
    app,
    verifyTelegramWebAppData,
    registerTelegramUser,
    findUserByTgOrPhone,
    inMemoryUsers
} = require('../server');

// Helper to generate Telegram WebApp initData
function createTestInitData({
    botToken = process.env.TELEGRAM_BOT_TOKEN,
    userId = 987654321,
    firstName = 'TestUser',
    username = 'testuser',
    authDate = Math.floor(Date.now() / 1000),
    queryId = 'AAHdF6IQAAAAAN0XohDhrOrc',
    tamper = false,
    wrongHash = false
} = {}) {
    const userJson = JSON.stringify({
        id: userId,
        first_name: firstName,
        username: username
    });

    const params = [
        ['auth_date', String(authDate)],
        ['query_id', queryId],
        ['user', userJson]
    ];

    params.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = params.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    let calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (wrongHash) {
        calculatedHash = '0000000000000000000000000000000000000000000000000000000000000000';
    }

    if (tamper) {
        // Change user id in the returned query string without recalculating hash
        const tamperedParams = [
            ['auth_date', String(authDate)],
            ['query_id', queryId],
            ['user', JSON.stringify({ id: 111111111, first_name: 'Attacker' })]
        ];
        return tamperedParams.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + `&hash=${calculatedHash}`;
    }

    return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + `&hash=${calculatedHash}`;
}

// HTTP request helper to call express app without listening on a port
function makeRequest(app, method, url, body) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                hostname: '127.0.0.1',
                port: port,
                path: url,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload ? Buffer.byteLength(payload) : 0
                }
            }, (res) => {
                let resBody = '';
                res.on('data', chunk => { resBody += chunk; });
                res.on('end', () => {
                    server.close(() => {
                        let parsed;
                        try {
                            parsed = JSON.parse(resBody);
                        } catch (e) {
                            parsed = resBody;
                        }
                        resolve({ status: res.statusCode, data: parsed });
                    });
                });
            });
            req.on('error', (err) => {
                server.close(() => reject(err));
            });
            if (payload) req.write(payload);
            req.end();
        });
    });
}

async function runTelegramSecurityTests() {
    console.log('Running Telegram authentication security tests...');

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const testTgId = 5566778899;
    const testPhone = '0988776655';

    // Seed a known registered user in memory
    const regResult = await registerTelegramUser({
        telegramId: testTgId,
        phone: testPhone,
        name: 'Honest Player'
    });
    assert.strictEqual(regResult.isNew, true, 'Seeded user should be created as new');
    assert.strictEqual(regResult.user.playBalance, 15, 'New user should receive 15 ETB play balance');
    assert.strictEqual(regResult.user.mainBalance, 0, 'New user should have 0 mainBalance');
    assert.strictEqual(regResult.user.registrationBonusClaimed, true, 'registrationBonusClaimed should be true');

    // 1. Valid Telegram initData succeeds
    {
        const validInitData = createTestInitData({
            botToken: botToken,
            userId: testTgId,
            firstName: 'Honest Player'
        });
        const res = await makeRequest(app, 'POST', '/api/telegram-login', { initData: validInitData });
        assert.strictEqual(res.status, 200, 'Valid initData should return HTTP 200');
        assert.strictEqual(res.data.success, true, 'Valid initData should succeed');
        assert.strictEqual(res.data.user.phone, testPhone, 'User phone should match registered user');
        assert.strictEqual(res.data.user.playBalance, 15, 'playBalance should remain 15');
        assert.strictEqual(res.data.user.mainBalance, 0, 'mainBalance should remain 0');
        console.log('✓ Valid Telegram initData succeeds');
    }

    // 2. Modified / tampered initData fails
    {
        const tamperedInitData = createTestInitData({
            botToken: botToken,
            userId: testTgId,
            tamper: true
        });
        const res = await makeRequest(app, 'POST', '/api/telegram-login', { initData: tamperedInitData });
        assert.strictEqual(res.status, 401, 'Tampered initData should return HTTP 401');
        assert.strictEqual(res.data.success, false);
        assert.ok(res.data.message.includes('Telegram authentication failed'));
        console.log('✓ Modified / tampered initData fails with 401');
    }

    // 3. Wrong hash fails
    {
        const wrongHashInitData = createTestInitData({
            botToken: botToken,
            userId: testTgId,
            wrongHash: true
        });
        const res = await makeRequest(app, 'POST', '/api/telegram-login', { initData: wrongHashInitData });
        assert.strictEqual(res.status, 401, 'Wrong hash should return HTTP 401');
        assert.strictEqual(res.data.success, false);
        console.log('✓ Wrong hash fails with 401');
    }

    // 4. Expired initData fails
    {
        const expiredAuthDate = Math.floor(Date.now() / 1000) - (86400 + 3600); // 25 hours ago
        const expiredInitData = createTestInitData({
            botToken: botToken,
            userId: testTgId,
            authDate: expiredAuthDate
        });
        const res = await makeRequest(app, 'POST', '/api/telegram-login', { initData: expiredInitData });
        assert.strictEqual(res.status, 401, 'Expired initData should return HTTP 401');
        assert.strictEqual(res.data.success, false);
        assert.ok(res.data.message.includes('expired'), 'Error message should indicate expiration');
        console.log('✓ Expired initData fails with 401');
    }

    // 5. Missing initData fails
    {
        const resEmpty = await makeRequest(app, 'POST', '/api/telegram-login', {});
        assert.strictEqual(resEmpty.status, 400, 'Missing initData should return HTTP 400');
        assert.strictEqual(resEmpty.data.success, false);

        const resNull = await makeRequest(app, 'POST', '/api/telegram-login', { initData: null });
        assert.strictEqual(resNull.status, 400, 'Null initData should return HTTP 400');
        assert.strictEqual(resNull.data.success, false);

        const resBlank = await makeRequest(app, 'POST', '/api/telegram-login', { initData: '   ' });
        assert.strictEqual(resBlank.status, 400, 'Blank initData should return HTTP 400');
        assert.strictEqual(resBlank.data.success, false);
        console.log('✓ Missing initData fails with 400');
    }

    // 6. Raw telegramId without initData fails
    {
        const res = await makeRequest(app, 'POST', '/api/telegram-login', {
            telegramId: String(testTgId)
        });
        assert.strictEqual(res.status, 400, 'Raw telegramId should return HTTP 400');
        assert.strictEqual(res.data.success, false);
        assert.ok(res.data.message.includes('Raw telegramId authentication is not accepted'));
        console.log('✓ Raw telegramId without initData fails with 400');
    }

    // 7. A known player\'s Telegram ID alone cannot authenticate
    {
        // Attacker creates valid initData for attacker ID 11223344
        // and sends { telegramId: "<victim testTgId>", initData: "<attacker initData>" }
        const attackerId = 11223344;
        const attackerInitData = createTestInitData({
            botToken: botToken,
            userId: attackerId,
            firstName: 'Attacker'
        });

        const res = await makeRequest(app, 'POST', '/api/telegram-login', {
            telegramId: String(testTgId),
            initData: attackerInitData
        });

        // The server ignores telegramId from body and checks attackerId:
        // attackerId is not registered in Phoenix Bingo -> returns 404
        assert.strictEqual(res.status, 404, 'Attacker should not be logged in as victim (404 expected for unverified/unregistered attacker)');
        assert.strictEqual(res.data.success, false);
        assert.ok(res.data.message.includes('User not registered'));
        console.log('✓ A known player\'s Telegram ID alone cannot authenticate (client-supplied telegramId ignored)');
    }

    // 8. Existing user balances remain strictly unchanged after login
    {
        const userBefore = await findUserByTgOrPhone(String(testTgId), null);
        const playBalBefore = userBefore.playBalance;
        const mainBalBefore = userBefore.mainBalance;

        const validInitData = createTestInitData({
            botToken: botToken,
            userId: testTgId
        });
        const res = await makeRequest(app, 'POST', '/api/telegram-login', { initData: validInitData });
        assert.strictEqual(res.status, 200);

        const userAfter = await findUserByTgOrPhone(String(testTgId), null);
        assert.strictEqual(userAfter.playBalance, playBalBefore, 'playBalance must remain unchanged after login');
        assert.strictEqual(userAfter.mainBalance, mainBalBefore, 'mainBalance must remain unchanged after login');
        assert.strictEqual(userAfter.balance, 0, 'balance must remain 0');
        console.log('✓ Existing user balances remain strictly unchanged after login');
    }

    // 9. Unit test verifyTelegramWebAppData directly
    {
        // Empty / invalid input
        assert.strictEqual(verifyTelegramWebAppData('').valid, false);
        assert.strictEqual(verifyTelegramWebAppData(null).valid, false);
        assert.strictEqual(verifyTelegramWebAppData('invalid_string_without_hash', botToken).valid, false);

        // Future auth_date (> 300s in future)
        const futureDate = Math.floor(Date.now() / 1000) + 1000;
        const futureInitData = createTestInitData({ botToken, userId: testTgId, authDate: futureDate });
        const futureRes = verifyTelegramWebAppData(futureInitData, botToken);
        assert.strictEqual(futureRes.valid, false);
        assert.ok(futureRes.error.includes('future'));

        // Expired auth_date (> 86400s old)
        const oldDate = Math.floor(Date.now() / 1000) - 90000;
        const oldInitData = createTestInitData({ botToken, userId: testTgId, authDate: oldDate });
        const oldRes = verifyTelegramWebAppData(oldInitData, botToken, 86400);
        assert.strictEqual(oldRes.valid, false);
        assert.ok(oldRes.error.includes('expired'));

        // Wrong bot token
        const validInitData = createTestInitData({ botToken, userId: testTgId });
        const wrongTokenRes = verifyTelegramWebAppData(validInitData, 'wrong:bot_token');
        assert.strictEqual(wrongTokenRes.valid, false);
        assert.ok(wrongTokenRes.error.includes('Invalid hash signature'));

        // Valid initData
        const validRes = verifyTelegramWebAppData(validInitData, botToken);
        assert.strictEqual(validRes.valid, true);
        assert.strictEqual(validRes.telegramUser.id, testTgId);
        console.log('✓ verifyTelegramWebAppData unit tests passed');
    }

    console.log('All Telegram authentication security tests passed successfully!\n');
}

if (require.main === module) {
    runTelegramSecurityTests()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Test failed:', err);
            process.exit(1);
        });
}

module.exports = { runTelegramSecurityTests };
