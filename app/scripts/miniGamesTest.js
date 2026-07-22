// Standalone rule-correctness tests for the three mini-game logic modules
// (src/games/battleship.js, checkers.js, chess.js) -- same PASS/FAIL/assert
// style as scripts/integrationTest.js, but these modules have zero socket/
// room dependency so this file just calls them directly, no fake harness
// needed.

const battleship = require('../src/games/battleship');
const checkers = require('../src/games/checkers');
const chess = require('../src/games/chess');
const tictactoe = require('../src/games/tictactoe');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

// ================= BATTLESHIP =================
(function testBattleship() {
  console.log('\n--- Battleship ---');

  // ---- layout validation ----
  const badCount = battleship.validateLayout([{ x: 0, y: 0, dir: 'H', size: 5 }]);
  assert(!!badCount.error, 'rejects a layout with the wrong number of ships');

  const badSizes = battleship.validateLayout([
    { x: 0, y: 0, dir: 'H', size: 5 }, { x: 0, y: 1, dir: 'H', size: 4 },
    { x: 0, y: 2, dir: 'H', size: 3 }, { x: 0, y: 3, dir: 'H', size: 3 },
    { x: 0, y: 4, dir: 'H', size: 3 } // should be 2, not 3
  ]);
  assert(!!badSizes.error, 'rejects a layout with the wrong multiset of ship sizes');

  const outOfBounds = battleship.validateLayout([
    { x: 7, y: 0, dir: 'H', size: 5 }, { x: 0, y: 1, dir: 'H', size: 4 },
    { x: 0, y: 2, dir: 'H', size: 3 }, { x: 0, y: 3, dir: 'H', size: 3 },
    { x: 0, y: 4, dir: 'H', size: 2 }
  ]);
  assert(!!outOfBounds.error, 'rejects a ship that runs off the edge of the board');

  const overlapping = battleship.validateLayout([
    { x: 0, y: 0, dir: 'H', size: 5 }, { x: 0, y: 0, dir: 'V', size: 4 }, // both use [0,0]
    { x: 0, y: 2, dir: 'H', size: 3 }, { x: 0, y: 3, dir: 'H', size: 3 },
    { x: 0, y: 4, dir: 'H', size: 2 }
  ]);
  assert(!!overlapping.error, 'rejects two ships occupying the same cell');

  const VALID_LAYOUT_P0 = [
    { x: 0, y: 0, dir: 'H', size: 5 }, { x: 0, y: 2, dir: 'H', size: 4 },
    { x: 0, y: 4, dir: 'H', size: 3 }, { x: 0, y: 6, dir: 'H', size: 3 },
    { x: 0, y: 8, dir: 'H', size: 2 }
  ];
  const VALID_LAYOUT_P1 = [
    { x: 5, y: 0, dir: 'H', size: 5 }, { x: 5, y: 2, dir: 'H', size: 4 },
    { x: 5, y: 4, dir: 'H', size: 3 }, { x: 5, y: 6, dir: 'H', size: 3 },
    { x: 5, y: 8, dir: 'H', size: 2 }
  ];
  const goodLayout = battleship.validateLayout(VALID_LAYOUT_P0);
  assert(goodLayout.ok, 'accepts a valid non-overlapping in-bounds layout');

  // ---- full game flow ----
  let state = battleship.createInitialState();
  assert(state.phase === 'placing', 'new game starts in the placing phase');

  const r0 = battleship.submitLayout(state, 0, VALID_LAYOUT_P0);
  assert(r0.ok && !r0.bothReady, 'player 0 submitting alone does not start the battle yet');
  assert(state.phase === 'placing', 'phase stays "placing" until BOTH players are ready');

  const dupSubmit = battleship.submitLayout(state, 0, VALID_LAYOUT_P0);
  assert(!!dupSubmit.error, 'a player cannot submit their layout twice');

  const r1 = battleship.submitLayout(state, 1, VALID_LAYOUT_P1);
  assert(r1.ok && r1.bothReady, 'the second player submitting flips bothReady');
  assert(state.phase === 'battle', 'phase becomes "battle" once both fleets are placed');
  assert(state.turn === 0, 'player 0 (room creator) fires first');

  const wrongTurn = battleship.fireShot(state, 1, 0, 0);
  assert(!!wrongTurn.error, "rejects a shot from the player who isn't on turn");

  const miss = battleship.fireShot(state, 0, 9, 9); // far corner, empty in VALID_LAYOUT_P1
  assert(miss.ok && miss.hit === false, 'a shot on an empty cell is recorded as a miss');
  assert(state.turn === 1, 'turn passes to the other player after a miss (strict alternation)');

  const oobShot = battleship.fireShot(state, 1, -1, 0);
  assert(!!oobShot.error, 'a shot with out-of-bounds coordinates is rejected');

  // Cycle turn back to player 0, then re-fire at the exact same cell (9,9)
  // -- both shots target player 1's board (state.boards[1]), so this is a
  // genuine repeat, unlike firing at the same (x,y) as a DIFFERENT player
  // (which would hit the OTHER board and isn't a repeat at all).
  const p1Turn = battleship.fireShot(state, 1, 0, 0); // player 1's real turn, targets player 0's board -- hits the carrier at (0,0)
  assert(p1Turn.ok && p1Turn.hit === true, "player 1's shot at player 0's carrier cell (0,0) is a hit");
  assert(state.turn === 0, 'turn passed back to player 0 after that hit (unconditional alternation)');
  const dupShot = battleship.fireShot(state, 0, 9, 9);
  assert(!!dupShot.error, 'firing at a cell already shot on that same target board is rejected');
})();

// The strict-alternation rule means turn ALWAYS passes after any resolved
// shot (hit or miss) except when the game ends -- re-verify that precisely
// in an isolated scenario so the assertion above doesn't mislead future
// readers of this file.
(function testBattleshipTurnAlternationIsUnconditional() {
  console.log('\n--- Battleship: turn alternation is unconditional (hit or miss) ---');
  const P0 = [
    { x: 0, y: 0, dir: 'H', size: 5 }, { x: 0, y: 2, dir: 'H', size: 4 },
    { x: 0, y: 4, dir: 'H', size: 3 }, { x: 0, y: 6, dir: 'H', size: 3 },
    { x: 0, y: 8, dir: 'H', size: 2 }
  ];
  const P1 = [
    { x: 5, y: 0, dir: 'H', size: 5 }, { x: 5, y: 2, dir: 'H', size: 4 },
    { x: 5, y: 4, dir: 'H', size: 3 }, { x: 5, y: 6, dir: 'H', size: 3 },
    { x: 5, y: 8, dir: 'H', size: 2 }
  ];
  const s = battleship.createInitialState();
  battleship.submitLayout(s, 0, P0);
  battleship.submitLayout(s, 1, P1);
  assert(s.turn === 0, 'player 0 starts');
  const hit = battleship.fireShot(s, 0, 0, 0); // hits P1?? no wait P1 ships are at x=5.. this is a shot at P1's board from player 0's perspective, P1's ships start at x=5, so (0,0) is a miss on P1's board.
  assert(hit.ok && hit.hit === false, '(0,0) is a miss against this specific opponent layout (their ships start at x=5)');
  assert(s.turn === 1, 'turn passed to player 1 after the miss');
  const hit2 = battleship.fireShot(s, 1, 0, 0); // player 1 shoots at player 0's board; P0 has a ship cell at (0,0) (carrier start)
  assert(hit2.ok && hit2.hit === true, 'player 1 hits player 0 carrier at (0,0)');
  assert(s.turn === 0, 'turn passes back to player 0 even though the shot was a HIT -- confirms unconditional alternation');

  // Full sink + game-over test: sink all of player 1's ships from player 0's turns only
  // (fire every cell of every P1 ship; must interleave with player1's own shots to keep taking turns)
  const s2 = battleship.createInitialState();
  battleship.submitLayout(s2, 0, P0);
  battleship.submitLayout(s2, 1, P1);
  const p1AllCells = [];
  for (const ship of P1) {
    for (let i = 0; i < ship.size; i++) p1AllCells.push(ship.dir === 'H' ? [ship.x + i, ship.y] : [ship.x, ship.y + i]);
  }
  // Filler cells for player 1's harmless return shots -- P0's whole fleet
  // lives in x=[0..4] (see P0 above), so columns 8 and 9 (x>=5) are always
  // guaranteed misses against player 0's board. There are 17 cells in
  // p1AllCells, so a single 10-cell column (y=0..9) isn't enough headroom;
  // use two columns (20 distinct cells) so this never runs out or repeats.
  const p0SafeFillerCells = [];
  for (const fx of [8, 9]) for (let fy = 0; fy < battleship.GRID_SIZE; fy++) p0SafeFillerCells.push([fx, fy]);
  let fillerIdx = 0;
  let gameOver = false;
  for (const [x, y] of p1AllCells) {
    const res = battleship.fireShot(s2, 0, x, y);
    assert(res.ok && res.hit === true, 'every scripted shot at (' + x + ',' + y + ') is a real hit on a P1 ship cell');
    if (res.gameOver) { gameOver = true; break; }
    // player 1 takes a harmless turn back so it's player 0's turn again next iteration
    const [ffx, ffy] = p0SafeFillerCells[fillerIdx++];
    const fillerRes = battleship.fireShot(s2, 1, ffx, ffy);
    assert(fillerRes.ok, 'sanity: the harmless filler return-shot itself is accepted (stays in-bounds, never repeats)');
  }
  assert(gameOver, 'sinking every cell of every enemy ship ends the game');
  assert(s2.winnerIdx === 0, 'player 0 (who fired the sinking shots) is recorded as the winner');
  assert(s2.phase === 'finished', 'phase becomes "finished" once a fleet is fully sunk');

  // Redaction check -- s2 ended because ALL of player 1's ships were sunk by
  // player 0, so: the LOSER's (player 1's) view of the WINNER's (player 0's)
  // board should show zero sunk ships (nobody ever fired at player 0 in this
  // scripted game), while the WINNER's (player 0's) view of the LOSER's
  // board should reveal every one of player 1's now-fully-sunk ships.
  const p1View = battleship.getPublicView(s2, 1);
  assert(p1View.opponentSunkShips.length === 0, "player 1's view shows zero sunk ships on player 0's board (player 0's fleet was never even shot at)");
  const p0View = battleship.getPublicView(s2, 0);
  assert(p0View.opponentSunkShips.length === P1.length, "player 0's view reveals ALL of player 1's ships once every one of them is sunk");
})();

// ================= CHECKERS =================
(function testCheckers() {
  console.log('\n--- Checkers ---');
  const state = checkers.createInitialState();

  let p0Count = 0, p1Count = 0;
  for (const row of state.board) for (const cell of row) { if (cell && cell.owner === 0) p0Count++; if (cell && cell.owner === 1) p1Count++; }
  assert(p0Count === 12 && p1Count === 12, 'initial board has exactly 12 pieces per side');
  assert(state.turn === 0, 'player 0 (dark-square rows 0-2) moves first');

  const legal0 = checkers.getLegalMoves(state, 0);
  assert(legal0.length > 0 && legal0.every(m => m.from[0] < m.to[0]), "player 0's opening moves all move DOWN the board (toward row 7)");

  const mv = checkers.applyMove(state, 0, [2, 1], [3, 0]);
  assert(mv.ok, 'a legal opening move for player 0 is accepted');
  assert(state.turn === 1, 'turn passes to player 1 after a simple (non-capture) move');

  const wrongTurn = checkers.applyMove(state, 0, [5, 0], [4, 1]);
  assert(!!wrongTurn.error, "rejects a move attempt when it isn't that player's turn");

  // ---- mandatory capture rule ----
  // Build a small custom position: player 1 man at (4,1), player 0 man
  // adjacent at (3,0) that CAN be captured by jumping to (2,-1)... needs to
  // be in-bounds -- construct a cleaner scenario directly on a fresh board.
  function emptyState(turn) {
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    return { board, turn, winnerIdx: null, mustContinueFrom: null };
  }
  const capState = emptyState(0);
  capState.board[2][1] = { owner: 0, king: false };
  capState.board[3][2] = { owner: 1, king: false }; // adjacent diagonally forward from (2,1) -- landing at (4,3) is empty
  capState.board[5][5] = { owner: 0, king: false };  // a second player-0 piece with only a simple move available
  const legalCap = checkers.getLegalMoves(capState, 0);
  assert(legalCap.length === 1 && legalCap[0].capturedCell, 'when a capture is available, it is the ONLY legal move (simple moves from other pieces are excluded)');
  const forcedSimple = checkers.applyMove(capState, 0, [5, 5], [6, 6]);
  assert(!!forcedSimple.error, 'attempting a non-capturing move while a capture is available is rejected (mandatory capture)');
  const doCap = checkers.applyMove(capState, 0, [2, 1], [4, 3]);
  assert(doCap.ok && doCap.captured, 'the mandatory capture itself is accepted');
  assert(capState.board[3][2] === null, 'the captured piece is removed from the board');

  // ---- multi-jump chaining (must continue with the SAME piece) ----
  const chainState = emptyState(0);
  chainState.board[2][1] = { owner: 0, king: false };
  chainState.board[3][2] = { owner: 1, king: false }; // first jump lands on (4,3)
  chainState.board[5][4] = { owner: 1, king: false }; // second jump available from (4,3) over (5,4) landing (6,5)
  chainState.board[4][7] = { owner: 0, king: false };  // decoy piece that must NOT be movable mid-chain
  const firstJump = checkers.applyMove(chainState, 0, [2, 1], [4, 3]);
  assert(firstJump.ok && firstJump.continueJump === true, 'a capture that leaves a further jump available reports continueJump=true');
  assert(chainState.turn === 0, 'turn does NOT pass to the opponent while a multi-jump continuation is pending');
  const tryOtherPiece = checkers.applyMove(chainState, 0, [4, 7], [5, 6]);
  assert(!!tryOtherPiece.error, 'a different piece cannot move while a multi-jump continuation is mandatory for the jumping piece');
  const secondJump = checkers.applyMove(chainState, 0, [4, 3], [6, 5]);
  assert(secondJump.ok && secondJump.continueJump === false, 'completing the chain (no further jump available) ends the turn normally');
  assert(chainState.turn === 1, 'turn finally passes to the opponent once the multi-jump chain is exhausted');
  assert(chainState.board[5][4] === null && chainState.board[3][2] === null, 'both jumped-over pieces were captured');

  // ---- king promotion + backward movement ----
  const promoState = emptyState(0);
  promoState.board[6][1] = { owner: 0, king: false };
  const promoMove = checkers.applyMove(promoState, 0, [6, 1], [7, 0]);
  assert(promoMove.ok && promoMove.promoted, 'a man reaching the far row (row 7 for player 0) is promoted to king');
  assert(promoState.board[7][0].king === true, 'the promoted piece is actually marked king on the board');

  // Player 0's own forward direction is row+ (increasing), so a genuine
  // backward-movement test needs row- -- a plain man of theirs could never
  // do this, only a king.
  const kingState2 = emptyState(0);
  kingState2.board[3][2] = { owner: 0, king: true };
  const kingBack = checkers.applyMove(kingState2, 0, [3, 2], [2, 1]); // row decreases -- backward for player 0
  assert(kingBack.ok, 'a king can move BACKWARD (toward row 0), unlike a plain man of the same owner');

  // ---- win by opponent having zero pieces left ----
  const wipeState = emptyState(0);
  wipeState.board[2][1] = { owner: 0, king: false };
  wipeState.board[3][2] = { owner: 1, king: false }; // the ONLY player-1 piece left
  const wipeMove = checkers.applyMove(wipeState, 0, [2, 1], [4, 3]);
  assert(wipeMove.ok && wipeMove.winnerIdx === 0, 'capturing the opponent\'s last remaining piece ends the game with a winner');

  // ---- win by opponent having pieces but zero legal moves (blocked in) ----
  // Player 1's only piece is a KING cornered at (0,0): 3 of its 4 diagonals
  // run off the board, and the 4th (toward (1,1)) is occupied by an enemy
  // piece whose own landing square (2,2) is also occupied -- so that
  // direction can't be captured through either. Truly zero legal moves.
  const blockState = emptyState(0);
  blockState.board[0][0] = { owner: 1, king: true };
  blockState.board[1][1] = { owner: 0, king: false };
  blockState.board[2][2] = { owner: 0, king: false };
  blockState.board[5][5] = { owner: 0, king: false }; // a piece player 0 can actually move
  const stuckMove = checkers.applyMove(blockState, 0, [5, 5], [6, 6]);
  assert(stuckMove.ok, 'sanity: the scripted move for the block-in scenario is itself legal');
  assert(blockState.winnerIdx === 0, 'player 0 wins because player 1 (a cornered king) is left with a piece but zero legal moves');
})();

// ================= CHESS =================
(function testChess() {
  console.log('\n--- Chess ---');
  const state = chess.createInitialState();
  assert(chess.turnPlayerIdx(state) === 0, 'White (playerIdx 0) moves first from the standard starting position');

  const badTurn = chess.applyMove(state, 1, 'e7', 'e5');
  assert(!!badTurn.error, "rejects a move from playerIdx 1 (Black) when it's White's turn");

  const openingMove = chess.applyMove(state, 0, 'e2', 'e4');
  assert(openingMove.ok && openingMove.san === 'e4', 'a legal opening move is applied and reports correct SAN');
  assert(chess.turnPlayerIdx(state) === 1, 'turn passes to Black after White moves');

  const illegalMove = chess.applyMove(state, 1, 'e8', 'e7'); // king can't move there (blocked/not needed anyway)
  assert(!!illegalMove.error, 'an illegal move (piece cannot legally reach that square) is rejected');

  // ---- Fool's Mate: fastest possible checkmate, confirms winnerIdx wiring ----
  const mateState = chess.createInitialState();
  chess.applyMove(mateState, 0, 'f2', 'f3');
  chess.applyMove(mateState, 1, 'e7', 'e5');
  chess.applyMove(mateState, 0, 'g2', 'g4');
  const mateMove = chess.applyMove(mateState, 1, 'd8', 'h4');
  assert(mateMove.ok && mateMove.checkmate === true, "Fool's Mate is correctly detected as checkmate");
  assert(mateState.winnerIdx === 1, 'the player who delivered checkmate (Black, playerIdx 1) is recorded as the winner');
  const moveAfterMate = chess.applyMove(mateState, 0, 'e2', 'e4');
  assert(!!moveAfterMate.error, 'no further moves are accepted once the game has ended in checkmate');

  // ---- legal-move listing for a square ----
  const freshState = chess.createInitialState();
  const knightMoves = chess.getLegalMovesForSquare(freshState, 'g1');
  assert(knightMoves.length === 2 && knightMoves.every(m => m.from === 'g1'), "White's opening knight on g1 has exactly its 2 standard legal moves (f3/h3)");

  const publicView = chess.getPublicView(freshState);
  assert(publicView.board.length === 8 && publicView.board[0].length === 8, 'getPublicView exposes an 8x8 board array');
  assert(publicView.turn === 0 && publicView.winnerIdx === null && publicView.drawReason === null, 'a fresh game\'s public view has no winner/draw yet');
  assert(publicView.legalMoves.length === 20, 'the standard opening position has exactly 20 legal first moves, all listed in legalMoves');

  const mateView = chess.getPublicView(mateState);
  assert(mateView.legalMoves.length === 0, 'once the game has ended (checkmate), legalMoves is empty -- nothing left to click');
})();

// ================= TIC-TAC-TOE =================
// 4th mini-game (2026-07-22). Mirrors checkers/chess coverage shape: initial
// state, legal-move gating, every win-line orientation, the draw case, turn
// alternation, and getPublicView's post-game legalMoves-empties-out contract.
(function testTicTacToe() {
  console.log('\n--- Tic-Tac-Toe ---');
  const state = tictactoe.createInitialState();
  assert(state.board.length === 9 && state.board.every(c => c === null), 'new game starts with an empty 3x3 board (9 nulls)');
  assert(state.turn === 0, 'player 0 (X) moves first');
  assert(state.winnerIdx === null && state.drawReason === null, 'a fresh game has no winner and no draw yet');

  const legal0 = tictactoe.getLegalMoves(state, 0);
  assert(legal0.length === 9, 'all 9 cells are legal for the opening move');
  const wrongTurn = tictactoe.getLegalMoves(state, 1);
  assert(wrongTurn.length === 0, "it isn't player 1's turn yet, so their legal-move list is empty");

  const badTurn = tictactoe.applyMove(state, 1, 0);
  assert(!!badTurn.error, "rejects a move from playerIdx 1 (O) when it's X's turn");

  const mv = tictactoe.applyMove(state, 0, 4); // X takes center
  assert(mv.ok && state.board[4] === 0, "a legal move for player 0 is applied to the board (center marked with player 0's index)");
  assert(state.turn === 1, 'turn passes to player 1 after a move that neither wins nor draws');

  const dupCell = tictactoe.applyMove(state, 1, 4);
  assert(!!dupCell.error, 'a move onto an already-occupied cell is rejected');

  const oobLow = tictactoe.applyMove(state, 1, -1);
  assert(!!oobLow.error, 'a move with an out-of-range index (< 0) is rejected');
  const oobHigh = tictactoe.applyMove(state, 1, 9);
  assert(!!oobHigh.error, 'a move with an out-of-range index (> 8) is rejected');

  // ---- every win-line orientation ----
  function playLine(moves) {
    // moves: array of {p, i} played in order; returns the final applyMove result
    const s = tictactoe.createInitialState();
    let res;
    for (const { p, i } of moves) res = tictactoe.applyMove(s, p, i);
    return { s, res };
  }
  const topRow = playLine([{ p: 0, i: 0 }, { p: 1, i: 3 }, { p: 0, i: 1 }, { p: 1, i: 4 }, { p: 0, i: 2 }]);
  assert(topRow.res.ok && topRow.res.winnerIdx === 0, 'top row (0,1,2) is detected as a win for X');
  assert(JSON.stringify(topRow.s.winningLine) === JSON.stringify([0, 1, 2]), 'winningLine records the exact 3 cell indices of the top row');

  const midCol = playLine([{ p: 0, i: 1 }, { p: 1, i: 0 }, { p: 0, i: 4 }, { p: 1, i: 2 }, { p: 0, i: 7 }]);
  assert(midCol.res.ok && midCol.res.winnerIdx === 0, 'middle column (1,4,7) is detected as a win for X');

  const mainDiag = playLine([{ p: 0, i: 0 }, { p: 1, i: 1 }, { p: 0, i: 4 }, { p: 1, i: 2 }, { p: 0, i: 8 }]);
  assert(mainDiag.res.ok && mainDiag.res.winnerIdx === 0, 'main diagonal (0,4,8) is detected as a win for X');

  const antiDiag = playLine([{ p: 0, i: 2 }, { p: 1, i: 0 }, { p: 0, i: 4 }, { p: 1, i: 1 }, { p: 0, i: 6 }]);
  assert(antiDiag.res.ok && antiDiag.res.winnerIdx === 0, 'anti-diagonal (2,4,6) is detected as a win for X');

  const oWins = playLine([{ p: 0, i: 0 }, { p: 1, i: 3 }, { p: 0, i: 1 }, { p: 1, i: 4 }, { p: 0, i: 8 }, { p: 1, i: 5 }]);
  assert(oWins.res.ok && oWins.res.winnerIdx === 1, "O (playerIdx 1) can also win, e.g. the bottom-half row (3,4,5)");

  const afterWin = tictactoe.applyMove(mainDiag.s, 1, 3);
  assert(!!afterWin.error, 'no further moves are accepted once the game has ended in a win');

  // ---- draw: full board, nobody completed a line ----
  // X O X / X O O / O X X  -- verify no line is complete, then confirm draw.
  const drawMoves = [
    { p: 0, i: 0 }, { p: 1, i: 1 }, { p: 0, i: 2 },
    { p: 1, i: 4 }, { p: 0, i: 3 }, { p: 1, i: 5 },
    { p: 0, i: 7 }, { p: 1, i: 6 }, { p: 0, i: 8 }
  ];
  const drawResult = playLine(drawMoves);
  assert(drawResult.s.board.every(c => c !== null), 'the scripted draw scenario fills the entire board');
  assert(drawResult.res.ok && drawResult.res.winnerIdx === null, 'a filled board with no line completed reports no winner');
  assert(!!drawResult.s.drawReason, 'drawReason is set once the board fills up with no winner');

  // ---- getPublicView ----
  const freshState = tictactoe.createInitialState();
  const freshView = tictactoe.getPublicView(freshState);
  assert(freshView.board.length === 9, 'getPublicView exposes the flat 9-cell board array');
  assert(freshView.legalMoves.length === 9, "a fresh game's public view lists all 9 cells as legal");
  assert(freshView.winningLine === null, 'a fresh game has no winningLine yet');

  const finishedView = tictactoe.getPublicView(mainDiag.s);
  assert(finishedView.legalMoves.length === 0, 'once the game has ended (win), legalMoves is empty -- nothing left to click');
  assert(finishedView.winnerIdx === 0, "the finished view reports X's win");

  const drawView = tictactoe.getPublicView(drawResult.s);
  assert(drawView.legalMoves.length === 0, "a drawn (full) board's public view also has an empty legalMoves list");
})();

console.log('\n=== ' + passed + '/' + (passed + failed) + ' mini-game assertions passed ===');
if (failed > 0) process.exit(1);
