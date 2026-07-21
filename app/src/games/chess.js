// Шахи (Chess) -- pure game-logic module. Standard FIDE-ish rules including
// castling, en passant, promotion, check/checkmate/stalemate/draw detection
// are all delegated to the well-tested chess.js library rather than
// hand-rolled -- see PROGRESS notes: hand-rolling full chess legality
// (pins, discovered checks, castling rights, en passant, threefold
// repetition, 50-move rule) is a huge surface area to get right, and
// chess.js is exactly the kind of narrow, well-scoped dependency worth
// taking on for that. playerIdx 0 is always White (the room creator),
// playerIdx 1 is always Black -- fixed by convention at room-creation time.

const { Chess } = require('chess.js');

function createInitialState() {
  return { fen: new Chess().fen(), winnerIdx: null, drawReason: null, lastMove: null };
}

function turnPlayerIdx(state) {
  return new Chess(state.fen).turn() === 'w' ? 0 : 1;
}

function getLegalMovesForSquare(state, square) {
  const chess = new Chess(state.fen);
  return chess.moves({ square, verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion || null, san: m.san }));
}

function applyMove(state, playerIdx, from, to, promotion) {
  if (state.winnerIdx !== null || state.drawReason) return { error: 'Гра вже завершена' };
  const chess = new Chess(state.fen);
  const expectedIdx = chess.turn() === 'w' ? 0 : 1;
  if (expectedIdx !== playerIdx) return { error: 'Зараз не ваш хід' };
  let move = null;
  try {
    move = chess.move({ from, to, promotion: promotion || 'q' });
  } catch (e) {
    move = null; // chess.js throws on an illegal move -- treat exactly like "no move happened"
  }
  if (!move) return { error: 'Недопустимий хід' };

  state.fen = chess.fen();
  state.lastMove = { from: move.from, to: move.to, san: move.san };

  if (chess.isCheckmate()) {
    state.winnerIdx = playerIdx; // whoever just moved delivered mate
  } else if (chess.isStalemate()) {
    state.drawReason = 'пат (немає ходів, король не під шахом)';
  } else if (chess.isThreefoldRepetition()) {
    state.drawReason = 'триразове повторення позиції';
  } else if (chess.isInsufficientMaterial()) {
    state.drawReason = 'недостатньо матеріалу для мату';
  } else if (chess.isDraw()) {
    state.drawReason = 'нічия (правило 50 ходів)';
  }

  return {
    ok: true,
    san: move.san,
    captured: !!move.captured, // chess.js's own move object -- piece-type letter if this move captured, undefined otherwise (used client-side to pick a capture vs. plain-move sound, see chess.js public/js client)
    check: chess.isCheck(),
    checkmate: chess.isCheckmate(),
    winnerIdx: state.winnerIdx,
    drawReason: state.drawReason || null
  };
}

// Fully public game (no hidden information) -- viewerIdx accepted only for a
// uniform (state, viewerIdx) signature across all three game modules.
//
// legalMoves lists EVERY legal move for the side to move in one shot (same
// shape/purpose as checkers.js's getPublicView().legalMoves) so the client
// never needs to compute or even know chess rules -- it just filters this
// list by `from` to highlight a selected piece's destinations. A pawn
// reaching the back rank appears as multiple entries sharing the same
// from/to with different `promotion` values; the client asks the player to
// pick one only when it sees more than one match for the chosen square.
function getPublicView(state) {
  const chess = new Chess(state.fen);
  const gameOver = state.winnerIdx !== null || !!state.drawReason;
  return {
    fen: state.fen,
    board: chess.board(),
    turn: chess.turn() === 'w' ? 0 : 1,
    inCheck: chess.isCheck(),
    winnerIdx: state.winnerIdx,
    drawReason: state.drawReason || null,
    lastMove: state.lastMove,
    legalMoves: gameOver ? [] : chess.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion || null }))
  };
}

module.exports = { createInitialState, turnPlayerIdx, getLegalMovesForSquare, applyMove, getPublicView };
