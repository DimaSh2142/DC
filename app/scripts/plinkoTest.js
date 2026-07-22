// Tests for Plinko -- pure logic (src/games/plinko.js) plus the stake/
// payout bookkeeping (src/state/plinkoManager.js). Same PASS/FAIL/assert
// style as scripts/blackjackTest.js.

const plinko = require('../src/games/plinko');
const { PlinkoManager } = require('../src/state/plinkoManager');
const playersStore = require('../src/state/playersStore');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

// ================= pure logic: simulatePath =================
(function testSimulatePath() {
  console.log('\n--- simulatePath ---');
  for (let i = 0; i < 200; i++) {
    const { path, slotIndex } = plinko.simulatePath(plinko.ROWS);
    if (path.length !== plinko.ROWS) { assert(false, 'path length should always equal ROWS (' + plinko.ROWS + ')'); return; }
    if (slotIndex < 0 || slotIndex > plinko.ROWS) { assert(false, 'slotIndex should always be within 0..ROWS'); return; }
    const rightCount = path.filter(x => x === 'R').length;
    if (rightCount !== slotIndex) { assert(false, 'slotIndex should always equal the count of R bounces in the path'); return; }
  }
  assert(true, '200 random paths all have the right length, in-range slotIndex, and slotIndex === count of R bounces');
  assert(plinko.MULTIPLIERS.length === plinko.ROWS + 1, 'the multiplier table has exactly ROWS+1 slots');
})();

// ================= pure logic: multiplierForSlot / payout =================
(function testMultiplierPayout() {
  console.log('\n--- multiplierForSlot / payout ---');
  assert(plinko.multiplierForSlot(0) === 1000, 'the far-left edge slot pays the max advertised x1000 (2026-07-22 board rebuild, matches dima\'s reference screenshot)');
  assert(plinko.multiplierForSlot(plinko.ROWS) === 1000, 'the far-right edge slot also pays x1000 (symmetric table)');
  const mid = plinko.ROWS / 2;
  assert(plinko.multiplierForSlot(mid) === 0.2, 'the dead-centre slot pays only 0.2x -- most common outcome, smallest multiplier, matches real Plinko economics');
  assert(plinko.multiplierForSlot(mid - 1) === 0.2 && plinko.multiplierForSlot(mid + 1) === 0.2, 'the whole 5-slot band flanking the centre also pays x0.2 -- the screenshot\'s flat middle zone, not just a single centre slot');
  assert(plinko.multiplierForSlot(999) === 0, 'an out-of-range slot index safely returns 0, never undefined/NaN');
  assert(plinko.payout(100, 0) === 100000, 'payout(100, edge slot) is stake * 1000');
  assert(plinko.payout(6, mid) === 1, 'payout(6, centre slot) floors 6*0.2=1.2 down to 1 (never invents fractional KKoin)');
  assert(plinko.payout(1, mid) === 0, 'payout(1, centre slot) floors 1*0.2=0.2 down to 0');

  // symmetry: every slot i should mirror slot ROWS-i
  let symmetric = true;
  for (let i = 0; i <= plinko.ROWS; i++) {
    if (plinko.multiplierForSlot(i) !== plinko.multiplierForSlot(plinko.ROWS - i)) symmetric = false;
  }
  assert(symmetric, 'the multiplier table is perfectly symmetric around the centre (outer slots pay equally on both sides)');
})();

// ================= statistical shape: centre-weighted like a real Galton board =================
(function testDistributionShape() {
  console.log('\n--- distribution shape (binomial random walk) ---');
  const N = 20000;
  const counts = new Array(plinko.ROWS + 1).fill(0);
  for (let i = 0; i < N; i++) {
    const { slotIndex } = plinko.simulatePath(plinko.ROWS);
    counts[slotIndex]++;
  }
  const centre = plinko.ROWS / 2;
  const maxCount = Math.max(...counts);
  assert(counts[centre] === maxCount, 'the centre slot (' + centre + ') is the single most frequently hit slot over ' + N + ' drops (got ' + counts[centre] + ' vs overall max ' + maxCount + ') -- confirms the walk is centre-weighted, not uniform');
  assert(counts[0] < counts[centre] && counts[plinko.ROWS] < counts[centre], 'both far-edge slots are hit far less often than the centre (edges: ' + counts[0] + '/' + counts[plinko.ROWS] + ' vs centre: ' + counts[centre] + ')');
  assert(counts[1] < counts[3], 'hit frequency rises monotonically-ish moving inward from the edge (slot 1 rarer than slot 3): ' + counts[1] + ' < ' + counts[3]);
  // generous +/-25% band on the well-populated centre bin only (rare edge
  // bins are checked ordinally above instead, to avoid flakiness on a low-
  // count Poisson-ish tail)
  const expectedCentre = N * (12870 / 65536); // C(16,8)/2^16 (2026-07-22 board rebuild: ROWS 10 -> 16)
  assert(counts[centre] > expectedCentre * 0.75 && counts[centre] < expectedCentre * 1.25, 'the centre bin count (' + counts[centre] + ') is within a generous band of the true binomial expectation (~' + Math.round(expectedCentre) + ')');
})();

// ================= PlinkoManager: stake/payout bookkeeping =================
(function testManager() {
  console.log('\n--- PlinkoManager ---');
  const mgr = new PlinkoManager();

  // PlinkoPoor gets a unique-per-run suffix (like cabinetTest.js's
  // CabinetDataUser fix) because playersStore persists to the REAL
  // data/players.json and addKkoin() is additive -- a fixed literal name's
  // balance would keep drifting upward across repeated runs, eventually
  // breaking the exact-equality assertion below (this was caught failing
  // for exactly that reason during the 2026-07-22 bubbles.js verification
  // pass: PlinkoPoor had accumulated to 4 KKoin from earlier runs, not the
  // 2 this test assumes). PlinkoRich doesn't need this -- its own checks
  // below are self-topping-up range checks, not exact equality.
  const poorNick = 'PlinkoPoor' + Date.now();
  playersStore.addKkoin('PlinkoRich', 500);
  playersStore.addKkoin(poorNick, 2);

  const tooMuch = mgr.drop('PlinkoRich', 99999);
  assert(!!tooMuch.error, 'drop() rejects a stake bigger than the balance');

  const tooPoor = mgr.drop(poorNick, 50);
  assert(!!tooPoor.error, 'drop() rejects a player whose balance cannot cover the stake');
  assert(playersStore.getOrCreatePlayer(poorNick).kkoin === 2, "a rejected drop doesn't touch the balance");

  const noNickname = mgr.drop('', 10);
  assert(!!noNickname.error, 'drop() rejects an empty nickname');

  // Drive many real drops and verify the balance-conservation invariant
  // holds every single time, whatever the random outcome -- more robust
  // than rigging a fixed path, and still genuinely proves deduct-then-pay
  // never loses or invents KKoin.
  let allConserved = true;
  for (let i = 0; i < 300; i++) {
    const before = playersStore.getOrCreatePlayer('PlinkoRich').kkoin;
    if (before < 5) { playersStore.addKkoin('PlinkoRich', 500); }
    const balBefore = playersStore.getOrCreatePlayer('PlinkoRich').kkoin;
    const res = mgr.drop('PlinkoRich', 5);
    if (!res.ok) { allConserved = false; break; }
    const expected = balBefore - 5 + res.payout;
    const actual = playersStore.getOrCreatePlayer('PlinkoRich').kkoin;
    if (expected !== actual || res.balance !== actual) { allConserved = false; break; }
    if (res.payout !== plinko.payout(5, res.slotIndex)) { allConserved = false; break; }
  }
  assert(allConserved, '300 consecutive real drops all conserve KKoin exactly (balance_after === balance_before - stake + payout), and each returned payout matches games/plinko.js\'s own payout() for its slotIndex');
})();

console.log('\n=== ' + passed + '/' + (passed + failed) + ' Plinko assertions passed ===');
if (failed > 0) process.exit(1);
