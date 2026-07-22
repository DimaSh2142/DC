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
// a row, a 1-in-1024 (~0.098%) event.
//
// 2026-07-22 rebalance #1 (dima, looking at the live multiplier row: "самий
// правий і лівий були х100 [було х1000], все інше посунулось і справа і
// зліва від 0.5 будуть х1 [було х2]"): edge slots cut 1000x -> 100x, the
// two slots flanking the centre cut 2x -> 1x. dima didn't specify the two
// intermediate tiers on each side -- filled with a smooth ~3.16x-per-step
// geometric ramp from the new 1x up to the new 100x (1, 3, 10, 30, 100 is
// 3.16^0..3.16^4 rounded to clean numbers) so "все інше посунулось" reads as
// one consistent curve rather than an arbitrary jump.
//
// 2026-07-22 rebalance #2 (dima sent a reference screenshot: "щоб набагато
// більше було квадратиків стільки як на другому скріні і з такими ж
// іксами" -- many more peg rows, matching that screenshot's board density,
// with its exact multiplier row). ROWS doubled 10 -> 16 (11 -> 17 slots) and
// MULTIPLIERS replaced wholesale with the screenshot's own 17 values (a
// wide flat 0.2x band across the 5 middle slots -- landing anywhere near
// centre out of 16 bounces is the overwhelmingly likely outcome, same
// "edge-heavy payout, centre-weighted path" shape as rebalance #1, just a
// taller board). The public/js/plinko.js client copy must be kept in sync
// by hand (see that file's header comment).
const ROWS = 16;
const MULTIPLIERS = [1000, 100, 20, 10, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 10, 20, 100, 1000]; // index = slot, length ROWS+1

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
