/**
 * Phoenix Bingo Core Game Rules Engine
 * Implements:
 * 1. Winning Patterns:
 *    - ONE LINE: Complete horizontal row, vertical column, or diagonal (center FREE square).
 *    - FOUR CORNERS: All 4 corner numbers covered by authoritative called numbers.
 * 2. Deterministic Cartela Generator:
 *    - generateFixedCard(ticketId): Maps ticketId deterministically to standard 5x5 grid.
 * 3. Jackpot Call Threshold:
 *    - Configurable range: 14 to 18 calls.
 *    - Server validation and eligibility evaluation.
 * 4. Claim Verification:
 *    - Validates against authoritative session, tickets owned, drawn numbers, gameId & state.
 */

const MIN_JACKPOT_THRESHOLD = 14;
const MAX_JACKPOT_THRESHOLD = 18;
const DEFAULT_JACKPOT_THRESHOLD = 16;

/**
 * Deterministically generates a 5x5 Bingo cartela for a given ticket ID (1 to 100+).
 * Column 0 (B): 1-15
 * Column 1 (I): 16-30
 * Column 2 (N): 31-45 (center at row index 2 is FREE)
 * Column 3 (G): 46-60
 * Column 4 (O): 61-75
 * Returns grid[col][row].
 */
function generateFixedCard(ticketId) {
    const tid = Math.max(1, parseInt(ticketId, 10) || 1);
    let seed = (tid * 1234567) >>> 0;
    function nextRand() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    }
    // Warm up PRNG identically to client
    nextRand(); nextRand(); nextRand();

    function getCol(min, max) {
        const arr = [];
        while (arr.length < 5) {
            const val = Math.floor(nextRand() * (max - min + 1)) + min;
            if (!arr.includes(val)) arr.push(val);
        }
        return arr.sort((a, b) => a - b);
    }

    const grid = [
        getCol(1, 15),
        getCol(16, 30),
        getCol(31, 45),
        getCol(46, 60),
        getCol(61, 75)
    ];
    grid[2][2] = 'FREE';
    return grid;
}

/**
 * Checks whether a specific cell on the 5x5 cartela is covered.
 * Center cell (col 2, row 2) is a FREE square and is always covered.
 * FREE square is never treated as a called number.
 */
function isCellCovered(grid, col, row, calledSet) {
    if (col === 2 && row === 2) {
        return true; // Center cell (col 2, row 2) is always automatically covered
    }
    if (!grid || !Array.isArray(grid[col])) return false;
    const cellValue = grid[col][row];
    if (cellValue === 'FREE') {
        return true; // FREE square is automatically covered
    }
    return typeof cellValue === 'number' && Number.isInteger(cellValue) && calledSet.has(cellValue);
}

/**
 * Checks a 5x5 cartela against called numbers for approved winning patterns:
 * 1. ONE LINE (Horizontal row, vertical column, or diagonal)
 * 2. FOUR CORNERS (All 4 corners: (0,0), (4,0), (0,4), (4,4))
 *
 * @param {Array<Array<number>>} grid - 5 columns, each 5 numbers
 * @param {Array<number>|Set<number>} calledNumbers - Numbers called by the server
 * @returns {object} { isWin: boolean, patternType?: string, patternName?: string, details?: object }
 */
function checkWinningPatterns(grid, calledNumbers) {
    if (!grid || !Array.isArray(grid) || grid.length !== 5) {
        return { isWin: false, reason: 'INVALID_GRID' };
    }

    const calledSet = (calledNumbers instanceof Set)
        ? calledNumbers
        : new Set(Array.isArray(calledNumbers) ? calledNumbers : []);

    // 1. Check Horizontal Rows (r = 0, 1, 2, 3, 4)
    for (let r = 0; r < 5; r++) {
        let rowComplete = true;
        const rowCells = [];
        for (let c = 0; c < 5; c++) {
            if (isCellCovered(grid, c, r, calledSet)) {
                rowCells.push(c === 2 && r === 2 ? 'FREE' : grid[c][r]);
            } else {
                rowComplete = false;
                break;
            }
        }
        if (rowComplete) {
            return {
                isWin: true,
                patternType: 'ONE_LINE',
                patternName: 'HORIZONTAL_ROW',
                row: r,
                description: `Horizontal row ${r + 1} complete`,
                coveredCells: rowCells
            };
        }
    }

    // 2. Check Vertical Columns (c = 0, 1, 2, 3, 4)
    for (let c = 0; c < 5; c++) {
        let colComplete = true;
        const colCells = [];
        for (let r = 0; r < 5; r++) {
            if (isCellCovered(grid, c, r, calledSet)) {
                colCells.push(c === 2 && r === 2 ? 'FREE' : grid[c][r]);
            } else {
                colComplete = false;
                break;
            }
        }
        if (colComplete) {
            const letter = ['B', 'I', 'N', 'G', 'O'][c];
            return {
                isWin: true,
                patternType: 'ONE_LINE',
                patternName: 'VERTICAL_COLUMN',
                column: c,
                columnLetter: letter,
                description: `Vertical column ${letter} complete`,
                coveredCells: colCells
            };
        }
    }

    // 3. Check Main Diagonal (Top-Left to Bottom-Right: (0,0), (1,1), (2,2), (3,3), (4,4))
    let mainDiagComplete = true;
    const mainDiagCells = [];
    for (let i = 0; i < 5; i++) {
        if (isCellCovered(grid, i, i, calledSet)) {
            mainDiagCells.push(i === 2 ? 'FREE' : grid[i][i]);
        } else {
            mainDiagComplete = false;
            break;
        }
    }
    if (mainDiagComplete) {
        return {
            isWin: true,
            patternType: 'ONE_LINE',
            patternName: 'DIAGONAL_MAIN',
            description: 'Main diagonal (top-left to bottom-right) complete',
            coveredCells: mainDiagCells
        };
    }

    // 4. Check Anti Diagonal (Top-Right to Bottom-Left: (4,0), (3,1), (2,2), (1,3), (0,4))
    let antiDiagComplete = true;
    const antiDiagCells = [];
    for (let i = 0; i < 5; i++) {
        const c = 4 - i;
        const r = i;
        if (isCellCovered(grid, c, r, calledSet)) {
            antiDiagCells.push(c === 2 && r === 2 ? 'FREE' : grid[c][r]);
        } else {
            antiDiagComplete = false;
            break;
        }
    }
    if (antiDiagComplete) {
        return {
            isWin: true,
            patternType: 'ONE_LINE',
            patternName: 'DIAGONAL_ANTI',
            description: 'Anti diagonal (top-right to bottom-left) complete',
            coveredCells: antiDiagCells
        };
    }

    // 5. Check FOUR CORNERS: (0,0), (4,0), (0,4), (4,4)
    const tl = isCellCovered(grid, 0, 0, calledSet);
    const tr = isCellCovered(grid, 4, 0, calledSet);
    const bl = isCellCovered(grid, 0, 4, calledSet);
    const br = isCellCovered(grid, 4, 4, calledSet);
    if (tl && tr && bl && br) {
        return {
            isWin: true,
            patternType: 'FOUR_CORNERS',
            patternName: 'FOUR_CORNERS',
            description: 'All 4 corners complete',
            coveredCells: [grid[0][0], grid[4][0], grid[0][4], grid[4][4]]
        };
    }

    return {
        isWin: false,
        reason: 'NO_WINNING_PATTERN',
        description: 'No approved winning pattern is covered'
    };
}

/**
 * Validates a jackpot threshold setting.
 * Ensures the threshold is safely bounded between 14 and 18 calls.
 */
function validateJackpotThreshold(value, fallback = DEFAULT_JACKPOT_THRESHOLD) {
    const num = parseInt(value, 10);
    if (isNaN(num)) return fallback;
    if (num < MIN_JACKPOT_THRESHOLD) return MIN_JACKPOT_THRESHOLD;
    if (num > MAX_JACKPOT_THRESHOLD) return MAX_JACKPOT_THRESHOLD;
    return num;
}

/**
 * Evaluates jackpot eligibility based on the number of calls made.
 *
 * @param {number} callsCount - Number of numbers drawn so far in current round.
 * @param {number} threshold - Administrator configured threshold (14 to 18).
 * @returns {object} Status with remaining calls and eligibility flag.
 */
function evaluateJackpotEligibility(callsCount, threshold = DEFAULT_JACKPOT_THRESHOLD) {
    const count = Math.max(0, parseInt(callsCount, 10) || 0);
    const target = validateJackpotThreshold(threshold);
    const isEligible = count <= target;
    const callsRemaining = Math.max(0, target - count);

    return {
        callsCount: count,
        targetThreshold: target,
        minThreshold: MIN_JACKPOT_THRESHOLD,
        maxThreshold: MAX_JACKPOT_THRESHOLD,
        isEligible,
        callsRemaining,
        status: isEligible ? 'ELIGIBLE' : 'EXPIRED'
    };
}

/**
 * Authoritatively verifies a player's Bingo claim against the live game state.
 *
 * @param {object} params
 * @param {object} params.player - Player record from currentGame.players
 * @param {object} params.game - The currentGame state
 * @param {number|string} [params.claimedTicketId] - Optional specific ticket claimed
 * @param {number|string} [params.clientGameId] - Client claimed game ID
 * @returns {object} Verification result { ok: boolean, code?: string, message?: string, ... }
 */
function verifyBingoClaim({ player, game, claimedTicketId, clientGameId }) {
    if (!game) {
        return {
            ok: false,
            code: 'NO_ACTIVE_GAME',
            message: 'ንቁ የሆነ የጨዋታ ሂደት አልተገኘም (No active game found)'
        };
    }

    // 1. Game State Verification
    const isPlaying = game.state === 'PLAYING';
    const isResolving = game.state === 'RESOLVING_WINNERS';

    if (!isPlaying && !isResolving) {
        if (game.state === 'WAITING') {
            return {
                ok: false,
                code: 'PREMATURE_GAME_WAITING',
                message: 'ጨዋታው ገና አልጀመረም! ቁጥሮች ሳይወጡ ማሸነፍ አይቻልም (Game is not live yet)'
            };
        }
        return {
            ok: false,
            code: 'GAME_ALREADY_ENDED',
            message: 'ይህ ዙር ጨዋታ ተጠናቋል (This game round has already ended)'
        };
    }

    if (isResolving && !game.claimResolutionWindowOpen) {
        return {
            ok: false,
            code: 'RESOLUTION_WINDOW_CLOSED',
            message: 'የአሸናፊነት ማረጋገጫ ጊዜው አልፏል (Resolution window is closed)'
        };
    }

    // 2. Game ID Match Verification
    if (clientGameId !== undefined && clientGameId !== null && clientGameId !== '') {
        const cId = parseInt(clientGameId, 10);
        if (!isNaN(cId) && cId !== game.gameId) {
            return {
                ok: false,
                code: 'STALE_GAME_ID',
                message: 'የተሳሳተ ወይም ያለፈ የጨዋታ መለያ (Stale game ID claim rejected)'
            };
        }
    }

    // 3. Authenticated Player Session Verification
    if (!player || !player.phone) {
        return {
            ok: false,
            code: 'UNAUTHENTICATED_PLAYER',
            message: 'የተጠቃሚ መለያ ማረጋገጥ አልተቻለም (Unable to verify player session)'
        };
    }

    // Check for duplicate pending claim from the same player
    if (game.pendingWinners && game.pendingWinners.has(player.phone)) {
        return {
            ok: false,
            code: 'DUPLICATE_CLAIM',
            message: 'ጥያቄዎ አስቀድሞ ተመዝግቧል (Your claim has already been registered)'
        };
    }

    // 4. Player Must Own Active Tickets in Current Game
    if (!Array.isArray(player.tickets) || player.tickets.length === 0) {
        return {
            ok: false,
            code: 'NO_TICKETS_OWNED',
            message: 'በዚህ ጨዋታ ምንም ንቁ ካርቴላ አልያዙም (You have no active cartela in this game)'
        };
    }

    // 5. Inspect Player's Assigned Tickets
    const candidateTickets = [];
    if (claimedTicketId !== undefined && claimedTicketId !== null && claimedTicketId !== '') {
        const targetId = parseInt(claimedTicketId, 10);
        const match = player.tickets.find(t => parseInt(t.id, 10) === targetId);
        if (!match) {
            return {
                ok: false,
                code: 'TICKET_NOT_OWNED',
                message: `ካርቴላ #${targetId} የእርስዎ አይደለም ወይም አልተመዘገበም (Cartela #${targetId} is not owned by your account)`
            };
        }
        // Verify seat ownership in game.selectedCards
        if (game.selectedCards && game.selectedCards.has(targetId)) {
            const seat = game.selectedCards.get(targetId);
            const isOwner = (seat.phone === player.phone) || (seat.socketId === player.socketId);
            if (!isOwner) {
                return {
                    ok: false,
                    code: 'SEAT_OWNERSHIP_MISMATCH',
                    message: 'የካርቴላ ባለቤትነት ማረጋገጫ አልተሳካም (Seat ownership verification failed)'
                };
            }
        }
        candidateTickets.push(match);
    } else {
        // Evaluate all tickets owned by the player
        for (const t of player.tickets) {
            candidateTickets.push(t);
        }
    }

    // 6. Authoritative Called Numbers
    const allDrawnNumbers = Array.isArray(game.drawnNumbers) ? game.drawnNumbers : [];
    // If in resolution window, strictly lock evaluation to the winning call count when round was flagged
    const effectiveCallLimit = (isResolving && typeof game.resolvedCallCount === 'number' && game.resolvedCallCount > 0)
        ? game.resolvedCallCount
        : allDrawnNumbers.length;
    const drawnNumbers = allDrawnNumbers.slice(0, effectiveCallLimit);
    const callsCount = drawnNumbers.length;

    // Minimum mathematical calls required to complete any line or 4 corners is 4
    if (callsCount < 4) {
        return {
            ok: false,
            code: 'PREMATURE_FEW_CALLS',
            message: `ያለጊዜው የቀረበ ጥያቄ! እስካሁን የወጣው ${callsCount} ቁጥር ብቻ ነው (Premature claim: only ${callsCount} numbers drawn)`
        };
    }

    // 7. Evaluate Winning Pattern against Authoritative Grid & Authoritative Called Numbers
    let winningTicket = null;
    let winningPattern = null;
    let authoritativeGrid = null;

    for (const t of candidateTickets) {
        const tid = parseInt(t.id, 10);
        // ALWAYS use authoritative deterministic grid from generateFixedCard
        const grid = generateFixedCard(tid);
        const patternCheck = checkWinningPatterns(grid, drawnNumbers);
        if (patternCheck.isWin) {
            winningTicket = t;
            winningPattern = patternCheck;
            authoritativeGrid = grid;
            break;
        }
    }

    if (!winningTicket || !winningPattern) {
        return {
            ok: false,
            code: 'NO_WINNING_PATTERN',
            message: 'ካርቴላው የሚያሸንፍ ጥምረት (One Line ወይም 4 Corners) አላሟላም (No valid winning pattern found)'
        };
    }

    // 8. Evaluate Jackpot Threshold Eligibility
    const threshold = validateJackpotThreshold(game.jackpotThreshold);
    const jackpotEvaluation = evaluateJackpotEligibility(callsCount, threshold);

    return {
        ok: true,
        winnerPhone: player.phone,
        winnerName: player.name || 'Player',
        winnerTelegramId: player.telegramId || '',
        winningTicketId: parseInt(winningTicket.id, 10),
        winningGrid: authoritativeGrid,
        winningPattern,
        callsCount,
        jackpotThreshold: threshold,
        isJackpotWin: jackpotEvaluation.isEligible,
        jackpotDetails: jackpotEvaluation,
        calledNumbers: [...drawnNumbers]
    };
}

module.exports = {
    MIN_JACKPOT_THRESHOLD,
    MAX_JACKPOT_THRESHOLD,
    DEFAULT_JACKPOT_THRESHOLD,
    generateFixedCard,
    isCellCovered,
    checkWinningPatterns,
    validateJackpotThreshold,
    evaluateJackpotEligibility,
    verifyBingoClaim
};
