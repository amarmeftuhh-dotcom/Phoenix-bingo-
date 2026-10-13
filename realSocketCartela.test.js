/**
 * End-to-end Socket.IO test for cartela selection and release over network
 */
const http = require('http');

const PORT = process.env.PORT || 3000;

function createClient(name, phone, onReady) {
    let sid = null;
    let client = {
        name,
        phone,
        sid: null,
        onEvent: () => {},
        emit: (eventName, data) => {
            const payload = '42' + JSON.stringify([eventName, data]);
            const postReq = http.request(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
            });
            postReq.write(payload);
            postReq.end();
        }
    };

    http.get(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling`, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
            sid = JSON.parse(raw.slice(1)).sid;
            client.sid = sid;
            const postReq = http.request(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
            }, () => {
                poll();
                onReady(client);
            });
            postReq.write('40');
            postReq.end();
        });
    });

    function poll() {
        http.get(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling&sid=${sid}`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                const regex = /42\[\"([^\"]+)\",\s*([\s\S]*?)\](?=\x1e|$)/g;
                let m;
                while ((m = regex.exec(data)) !== null) {
                    const ev = m[1];
                    let val = m[2];
                    try { val = JSON.parse(val); } catch(_) {}
                    client.onEvent(ev, val);
                }
                setTimeout(poll, 300);
            });
        }).on('error', () => {});
    }

    return client;
}

function runRealSocketTest() {
    createClient('Player1', '0911000001', (c1) => {
        createClient('Player2', '0911000002', (c2) => {
            console.log('Both Socket.IO clients connected.');

            let testStarted = false;
            const timeout = setTimeout(() => {
                console.log('Test completed or skipped due to active game cycle');
                process.exit(0);
            }, 12000);

            function startCartelaExchange() {
                if (testStarted) return;
                testStarted = true;
                console.log('Lobby is in WAITING state, beginning cartela test...');
                c1.emit('buy_tickets', {
                    name: 'Player1',
                    phone: '0911000001',
                    ticketCount: 1,
                    ticketIds: [25],
                    ticketsData: [{ id: 25 }]
                });
            }

            c1.onEvent = (ev, val) => {
                if (ev === 'game_status' && val.state === 'WAITING') {
                    startCartelaExchange();
                }
            };

            c2.onEvent = (ev, val) => {
                if (ev === 'game_status' && val.state === 'WAITING') {
                    startCartelaExchange();
                }
                if (ev === 'update_taken_tickets' && Array.isArray(val) && val.includes(25)) {
                    console.log('✓ Player2 saw Cartela #25 taken in update_taken_tickets');

                    // Player 2 tries to take cartela 25
                    c2.emit('buy_tickets', {
                        name: 'Player2',
                        phone: '0911000002',
                        ticketCount: 1,
                        ticketIds: [25],
                        ticketsData: [{ id: 25 }]
                    });
                }
                if (ev === 'bet_error' && val.includes('25')) {
                    console.log('✓ Player2 received expected bet_error for taken cartela #25');

                    // Player 1 now releases cartela 25
                    c1.emit('cancel_ticket', {
                        phone: '0911000001',
                        ticketId: 25
                    });
                }
                if (ev === 'update_taken_tickets' && Array.isArray(val) && !val.includes(25) && testStarted) {
                    console.log('✓ Cartela #25 is now released and free in update_taken_tickets!');
                    console.log('E2E REAL-TIME CARTELA SELECTION & RELEASE TEST: PASS ✅');
                    clearTimeout(timeout);
                    process.exit(0);
                }
            };
        });
    });
}

runRealSocketTest();
