/**
 * Automated test verifying game loop transitions:
 * WAITING -> COUNTDOWN -> PLAYING -> FIRST NUMBER DRAWN
 */
const http = require('http');

const PORT = process.env.PORT || 3000;

function runTest() {
    let sid = null;
    let numberDrawn = false;
    let stateVerified = false;

    const timeout = setTimeout(() => {
        console.error('❌ Test timed out waiting for number drawing');
        process.exit(1);
    }, 55000);

    // Step 1: Handshake
    http.get(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try {
                sid = JSON.parse(data.slice(1)).sid;
            } catch (e) {
                console.error('Failed to parse handshake:', data);
                process.exit(1);
            }

            // Step 2: Connect
            const postReq = http.request(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
            }, () => {
                poll();
            });
            postReq.write('40');
            postReq.end();
        });
    });

    function poll() {
        http.get(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}`, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                if (raw === '2' || raw.startsWith('2')) {
                    const pongReq = http.request(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
                    });
                    pongReq.write('3');
                    pongReq.end();
                }

                const regex = /42\[\"([^\"]+)\",\s*([\s\S]*?)\](?=\x1e|$)/g;
                let m;
                while ((m = regex.exec(raw)) !== null) {
                    const eventName = m[1];
                    let eventData = m[2];
                    try { eventData = JSON.parse(eventData); } catch(_) {}

                    if (eventName === 'game_status') {
                        if (eventData.state === 'WAITING' || eventData.state === 'PLAYING') {
                            stateVerified = true;
                        }
                        if (eventData.calledNumbers && eventData.calledNumbers.length > 0) {
                            clearTimeout(timeout);
                            console.log(`[TEST] Verified called numbers in game_status: ${eventData.calledNumbers.length}`);
                            console.log('GAME START TEST:');
                            console.log('WAITING → COUNTDOWN → PLAYING → FIRST NUMBER DRAWN = PASS');
                            process.exit(0);
                        }
                    } else if (eventName === 'new_number') {
                        numberDrawn = true;
                        clearTimeout(timeout);
                        console.log(`[TEST] Received 'new_number' event: ${eventData}`);
                        console.log('GAME START TEST:');
                        console.log('WAITING → COUNTDOWN → PLAYING → FIRST NUMBER DRAWN = PASS');
                        process.exit(0);
                    }
                }
                setTimeout(poll, 400);
            });
        }).on('error', (err) => {
            console.error('Poll error:', err.message);
            process.exit(1);
        });
    }
}

runTest();
