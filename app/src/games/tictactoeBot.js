// Solo opponent AI for Хрестики-нулики (2026-07-22, dima: "зроби щоб у
// хрестики нулики можна було грати з ШІ, ну придумай як саме це
// проробити"). Tic-tac-toe's whole game tree is tiny (at most 9! positions,
// aggressively cut short by early wins/draws), so minimax SOLVES it exactly
// rather than approximating -- there's no reason to reach for anything
// heavier. Playing perfectly makes it unbeatable though (best case for a
// human is a draw), which reads as a wall instead of a fun opponent for a
// casual friend-group app. So this deliberately plays optimally MOST of the
// time but sometimes (MISTAKE_CHANCE) plays a random legal move instead --
// a beatable, slightly-human-feeling bot rather than a solved-game wall.
//
// Pure logic, no room/socket knowledge -- see miniGameManager.js for how a
// solo room schedules this after the human's move, same "src/games/<name>.js
// owns rules, miniGameManager.js owns room lifecycle" split every other
// mini-game already follows.

const { checkWinner, getLegalMoves } = require('./tictactoe');

const MISTAKE_CHANCE = 0.25;

function emptyIndexes(board) {
  const moves = [];
  board.forEach((cell, i) => { if (cell === null) moves.push(i); });
  return moves;
}

// Score from botIdx's perspective; depth is subtracted/added so the bot
// prefers winning SOONER and delaying a loss as LONG as possible, rather
// than being indifferent between "win now" and "win in 5 moves".
function minimax(board, turnIdx, botIdx, humanIdx, depth) {
  const win = checkWinner(board);
  if (win) return win.winnerIdx === botIdx ? (10 - depth) : (depth - 10);
  const moves = emptyIndexes(board);
  if (!moves.length) return 0;

  let best = turnIdx === botIdx ? -Infinity : Infinity;
  for (const move of moves) {
    board[move] = turnIdx;
    const score = minimax(board, turnIdx === botIdx ? humanIdx : botIdx, botIdx, humanIdx, depth + 1);
    board[move] = null;
    best = turnIdx === botIdx ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

/**
 * Picks the bot's next move (a board index 0-8) for gameState.board, playing
 * as botIdx against humanIdx. Returns null if the board is already full
 * (caller shouldn't normally hit this -- miniGameManager only calls this
 * when it's genuinely the bot's turn on a non-finished game).
 */
function pickMove(board, botIdx, humanIdx) {
  const moves = emptyIndexes(board);
  if (!moves.length) return null;
  if (moves.length > 1 && Math.random() < MISTAKE_CHANCE) {
    return moves[Math.floor(Math.random() * moves.length)];
  }
  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    board[move] = botIdx;
    const score = minimax(board, humanIdx, botIdx, humanIdx, 1);
    board[move] = null;
    if (score > bestScore) { bestScore = score; bestMove = move; }
  }
  return bestMove;
}

module.exports = { pickMove };
