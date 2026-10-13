/**
 * Test verifying cartela lifecycle:
 * - Real player reservation
 * - Conflict rejection
 * - Release / unselect makes seat available to other players
 * - Change seat
 * - Locked during PLAYING
 */
const assert = require('assert');

async function testCartelaLifecycle() {
    console.log('Testing cartela/seat reservation, release, change, and lock lifecycle...');

    // Simulate in-memory server state
    const currentGame = {
        gameId: 2001,
        state: 'WAITING',
        stake: 10,
        drawnNumbers: [],
        remainingNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
        players: new Map(),
        selectedCards: new Map(),
        timer: 40,
        drawInterval: null,
        totalJackpot: 0,
        netJackpot: 0
    };

    function buyTickets(socketId, phone, name, ticketIds, ticketsData) {
        if (currentGame.state !== 'WAITING') {
            return { error: 'Game is LIVE! Ticket selection is locked' };
        }
        for (const rawId of ticketIds) {
            const tid = parseInt(rawId, 10);
            const owner = currentGame.selectedCards.get(tid);
            if (owner) {
                const isMe = (owner.socketId === socketId) || (owner.phone === phone);
                if (!isMe) {
                    return { error: `Cartela #${tid} is already taken by another player` };
                }
            }
        }

        let playerRecord = currentGame.players.get(socketId) || {
            socketId,
            phone,
            name,
            tickets: []
        };
        const existingIds = new Set(playerRecord.tickets.map(t => parseInt(t.id, 10)));
        for (const rawId of ticketIds) {
            const tid = parseInt(rawId, 10);
            currentGame.selectedCards.set(tid, { socketId, phone, name });
            if (!existingIds.has(tid)) {
                playerRecord.tickets.push({ id: tid, grid: [] });
                existingIds.add(tid);
            }
        }
        currentGame.players.set(socketId, playerRecord);
        return { success: true, taken: Array.from(currentGame.selectedCards.keys()) };
    }

    function cancelTicket(socketId, phone, ticketId) {
        if (currentGame.state !== 'WAITING') {
            return { error: 'Game is LIVE! Tickets are locked' };
        }
        const tid = parseInt(ticketId, 10);
        const owner = currentGame.selectedCards.get(tid);
        if (owner) {
            const isAuthorized = (owner.socketId === socketId) || (owner.phone === phone);
            if (!isAuthorized) {
                return { error: 'Not authorized to cancel this ticket' };
            }
            currentGame.selectedCards.delete(tid);
        }
        const playerRecord = currentGame.players.get(socketId);
        if (playerRecord) {
            playerRecord.tickets = playerRecord.tickets.filter(t => parseInt(t.id, 10) !== tid);
        }
        return { success: true, released: tid, taken: Array.from(currentGame.selectedCards.keys()) };
    }

    // Step 1: Player A reserves cartela 25
    let res = buyTickets('socket_A', '0911111111', 'Player A', [25], [{ id: 25 }]);
    assert.strictEqual(res.success, true);
    assert(currentGame.selectedCards.has(25));
    console.log('✓ Player A reserved cartela 25');

    // Step 2: Player B tries to reserve cartela 25 -> Conflict!
    res = buyTickets('socket_B', '0922222222', 'Player B', [25], [{ id: 25 }]);
    assert(res.error && res.error.includes('already taken'));
    console.log('✓ Player B correctly blocked from taking already reserved cartela 25');

    // Step 3: Player A releases cartela 25
    res = cancelTicket('socket_A', '0911111111', 25);
    assert.strictEqual(res.success, true);
    assert.strictEqual(currentGame.selectedCards.has(25), false);
    console.log('✓ Player A released cartela 25 (immediately made available)');

    // Step 4: Player B can now reserve cartela 25
    res = buyTickets('socket_B', '0922222222', 'Player B', [25], [{ id: 25 }]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(currentGame.selectedCards.get(25).phone, '0922222222');
    console.log('✓ Player B successfully reserved newly freed cartela 25');

    // Step 5: Player A reserves cartela 40
    res = buyTickets('socket_A', '0911111111', 'Player A', [40], [{ id: 40 }]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(currentGame.selectedCards.get(40).phone, '0911111111');
    console.log('✓ Player A reserved new cartela 40');

    // Step 6: Player A cannot own duplicate copies of cartela 40
    res = buyTickets('socket_A', '0911111111', 'Player A', [40], [{ id: 40 }]);
    const pA = currentGame.players.get('socket_A');
    assert.strictEqual(pA.tickets.filter(t => t.id === 40).length, 1);
    console.log('✓ Duplicate cartela 40 prevented for Player A');

    // Step 7: Game transitions to PLAYING -> All tickets locked
    currentGame.state = 'PLAYING';
    res = cancelTicket('socket_A', '0911111111', 40);
    assert(res.error && res.error.includes('locked'));
    res = buyTickets('socket_C', '0933333333', 'Player C', [50], [{ id: 50 }]);
    assert(res.error && res.error.includes('locked'));
    console.log('✓ Tickets strictly locked once game is PLAYING (no changes or cancellations allowed)');

    console.log('ALL CARTELA LIFECYCLE TESTS PASSED SUCCESSFULLY! ✅');
}

testCartelaLifecycle().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
