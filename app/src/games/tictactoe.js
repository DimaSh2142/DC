// Хрестики-нулики (Tic-Tac-Toe) -- pure game-logic module. New 4th mini-
// game (2026-07-22), built to mirror checkers.js's shape exactly so it
// slots into miniGameManager.js's existing GAME_MODULES/room lifecycle with
// zero changes to that file's actual logic (see that module's own comment:
// "each concrete game's actual rules live in src/games/<name>.js as pure
// functions"). Standard 3x3 rules: playerIdx 0 is X, playerIdx 1 is O,
// alternating turns, first to get 3 in a row (row/column/diagonal) wins, a
// full board with no winner is a draw.

const SIZE = 3;
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6]             // diagonals
];

// board: flat array of 9 cells, each null | 0 | 1 (playerIdx that marked it).
function createInitialState() {
  return { board: Array(9).fill(null), turn: 0, winnerIdx: null, drawReason: null, winningLine: null };
}

function getLegalMoves(state, playerIdx) {
  if (state.winnerIdx !== null || state.drawReason) return [];
  if (state.turn !== playerIdx) return [];
  const moves = [];
  state.board.forEach((cell, index) => { if (cell === null) moves.push({ index }); });
  return moves;
}

function checkWinner(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] !== null && board[a] === board[b] && board[b] === board[c]) {
      return { winnerIdx: board[a], line };
    }
  }
  return null;
}

function applyMove(state, playerIdx, index) {
  if (state.winnerIdx !== null || state.drawReason) return { error: 'Гра вже завершена' };
  if (state.turn !== playerIdx) return { error: 'Зараз не ваш хід' };
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx > 8) return { error: 'Некоректна клітинка' };
  if (state.board[idx] !== null) return { error: 'Клітинка вже зайнята' };

  state.board[idx] = playerIdx;
  const win = checkWinner(state.board);
  if (win) {
    state.winnerIdx = win.winnerIdx;
    state.winningLine = win.line;
    return { ok: true, winnerIdx: state.winnerIdx };
  }
  if (state.board.every((cell) => cell !== null)) {
    state.drawReason = 'Дошка заповнена — нічия';
    return { ok: true, winnerIdx: null };
  }
  state.turn = 1 - playerIdx;
  return { ok: true, winnerIdx: null };
}

// No hidden information (same as checkers.js) -- viewerIdx-agnostic.
function getPublicView(state) {
  return {
    board: state.board,
    turn: state.turn,
    winnerIdx: state.winnerIdx,
    drawReason: state.drawReason,
    winningLine: state.winningLine,
    legalMoves: (state.winnerIdx === null && !state.drawReason) ? getLegalMoves(state, state.turn) : []
  };
}

module.exports = { SIZE, LINES, createInitialState, getLegalMoves, applyMove, getPublicView };
