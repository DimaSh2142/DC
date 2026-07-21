// Шашки (Checkers) -- pure game-logic module. Standard American/English
// checkers rules on an 8x8 board: 12 men per side on the dark squares,
// diagonal-forward-only moves for men, capture by jumping an adjacent enemy
// piece into the empty square beyond, CAPTURES ARE MANDATORY whenever at
// least one is available, a multi-jump MUST continue with the same piece
// while further jumps are available, men promote to kings on reaching the
// far row, kings move/capture diagonally in any of the 4 directions. Win by
// the opponent having no pieces left or no legal move on their turn.

const SIZE = 8;
function isDark(r, c) { return (r + c) % 2 === 1; }
function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

const MAN_DIRS = { 0: [[1, -1], [1, 1]], 1: [[-1, -1], [-1, 1]] }; // player 0 moves down (row+), player 1 moves up (row-)
const KING_DIRS = [[1, -1], [1, 1], [-1, -1], [-1, 1]];

function createInitialState() {
  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!isDark(r, c)) continue;
      if (r <= 2) board[r][c] = { owner: 0, king: false };
      else if (r >= 5) board[r][c] = { owner: 1, king: false };
    }
  }
  return { board, turn: 0, winnerIdx: null, mustContinueFrom: null };
}

function dirsFor(piece) { return piece.king ? KING_DIRS : MAN_DIRS[piece.owner]; }

// Simple moves + single-jump captures available to the ONE piece at (r,c).
function movesForPiece(board, r, c) {
  const piece = board[r][c];
  if (!piece) return { simpleMoves: [], captures: [] };
  const simpleMoves = [];
  const captures = [];
  for (const [dr, dc] of dirsFor(piece)) {
    const nr = r + dr, nc = c + dc;
    if (inBounds(nr, nc) && !board[nr][nc]) simpleMoves.push({ from: [r, c], to: [nr, nc] });
    const jr = r + 2 * dr, jc = c + 2 * dc;
    if (inBounds(nr, nc) && inBounds(jr, jc) && board[nr][nc] && board[nr][nc].owner !== piece.owner && !board[jr][jc]) {
      captures.push({ from: [r, c], to: [jr, jc], capturedCell: [nr, nc] });
    }
  }
  return { simpleMoves, captures };
}

// All legal moves for playerIdx this turn -- honors both the "mandatory
// capture" rule and an in-progress multi-jump lock (mustContinueFrom).
function getLegalMoves(state, playerIdx) {
  const { board, mustContinueFrom } = state;
  if (mustContinueFrom) {
    const [r, c] = mustContinueFrom;
    return movesForPiece(board, r, c).captures;
  }
  let allCaptures = [];
  let allSimple = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const piece = board[r][c];
      if (!piece || piece.owner !== playerIdx) continue;
      const { simpleMoves, captures } = movesForPiece(board, r, c);
      allCaptures = allCaptures.concat(captures);
      allSimple = allSimple.concat(simpleMoves);
    }
  }
  return allCaptures.length ? allCaptures : allSimple;
}

function applyMove(state, playerIdx, from, to) {
  if (state.winnerIdx !== null) return { error: 'Гра вже завершена' };
  if (state.turn !== playerIdx) return { error: 'Зараз не ваш хід' };
  const legal = getLegalMoves(state, playerIdx);
  const match = legal.find(m => m.from[0] === from[0] && m.from[1] === from[1] && m.to[0] === to[0] && m.to[1] === to[1]);
  if (!match) return { error: 'Недопустимий хід (можливо, є обовʼязкове взяття іншою шашкою)' };

  const { board } = state;
  const piece = board[from[0]][from[1]];
  board[from[0]][from[1]] = null;
  let captured = false;
  if (match.capturedCell) {
    board[match.capturedCell[0]][match.capturedCell[1]] = null;
    captured = true;
  }
  const [tr, tc] = to;
  let promoted = false;
  if (!piece.king && ((piece.owner === 0 && tr === SIZE - 1) || (piece.owner === 1 && tr === 0))) {
    piece.king = true;
    promoted = true;
  }
  board[tr][tc] = piece;

  if (captured) {
    const further = movesForPiece(board, tr, tc).captures;
    if (further.length) {
      state.mustContinueFrom = [tr, tc];
      return { ok: true, captured: true, promoted, continueJump: true, winnerIdx: null };
    }
  }

  state.mustContinueFrom = null;
  const oppIdx = 1 - playerIdx;
  state.turn = oppIdx;
  const oppHasPiece = board.some(row => row.some(cell => cell && cell.owner === oppIdx));
  if (!oppHasPiece) {
    state.winnerIdx = playerIdx;
  } else if (getLegalMoves(state, oppIdx).length === 0) {
    state.winnerIdx = playerIdx;
  }
  return { ok: true, captured, promoted, continueJump: false, winnerIdx: state.winnerIdx };
}

// No hidden information in checkers -- viewerIdx is accepted only so every
// game module shares the same (state, viewerIdx) signature for the socket
// handler's uniform per-player emit loop (see miniGameHandlers.js).
function getPublicView(state) {
  return {
    board: state.board,
    turn: state.turn,
    winnerIdx: state.winnerIdx,
    mustContinueFrom: state.mustContinueFrom,
    legalMoves: state.winnerIdx === null ? getLegalMoves(state, state.turn) : []
  };
}

module.exports = { SIZE, createInitialState, getLegalMoves, applyMove, getPublicView };
