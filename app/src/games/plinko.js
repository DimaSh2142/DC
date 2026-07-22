// Plinko -- pure game-logic module. Single-player, no shared table (see the
// task's own framing: "typical Plinko payout tables are edge-weighted").
// A ball drops through ROWS rows of pegs, bouncing left or right with equal
// 50/50 odds at each row (a classic Galton board / binomial random walk) and
// lands in one of ROWS+1 slots at the bottom. This is a genuine simulation,
// not a fudged/pre-weighted RNG -- the edge-heavy payout table below is what
// creates the "outer slots pay much more" feel, while the PATH itself is
// naturally centre-weighted (binomial distribution) exactly like a real
// Plinko board, satisfying both halves of the task's ask without needing to
// bias the coin flips themselves.
//
// Multiplier table: 10 rows -> 11 slots, symmetric around the centre.
// Landing in the exact centre slot requires 5 lefts and 5 rights (the most
// likely single outcome, ~24.6% of drops) and pays a small loss (0.5x);
// landing in either far-edge slot requires 10 bounces the SAME direction in
// a row, a 1-in-1024 (~0.098%) event, matching the x1000 "max payout"
// already advertised on the casino hub card (components/casino/GamePanel.jsx's
// reference meta, ported into casino.html's Plinko card).
const ROWS = 10;
const MULTIPLIERS = [1000, 130, 26, 9, 2, 0.5, 2, 9, 26, 130, 1000]; // index = slot, length ROWS+1

function simulatePath(rows) {
  const r = Number.isInteger(rows) ? rows : ROWS;
  const path = [];
  let rightCount = 0;
  for (let i = 0; i < r; i++) {
    const goRight = Math.random() < 0.5;
    path.push(goRight ? 'R' : 'L');
    if (goRight) rightCount++;
  }
  return { path, slotIndex: rightCount };
}

function multiplierForSlot(slotIndex) {
  return MULTIPLIERS[slotIndex] || 0;
}

function payout(stake, slotIndex) {
  return Math.floor(stake * multiplierForSlot(slotIndex));
}

module.exports = { ROWS, MULTIPLIERS, simulatePath, multiplierForSlot, payout };
