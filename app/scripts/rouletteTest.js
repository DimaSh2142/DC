// Tests for Roulette -- pure logic (src/games/roulette.js) plus the
// seat/betting/spin/settlement bookkeeping (src/state/rouletteTableManager.js).
// Same PASS/FAIL/assert style as scripts/blackjackTest.js.

const roulette = require('../src/games/roulette');
const { RouletteTableManager, MIN_BETTORS_TO_SPIN } = require('../src/state/rouletteTableManager');
const playersStore = require('../src/state/playersStore');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

// ================= pure logic: colorOf =================
(function testColorOf() {
  console.log('\n--- colorOf ---');
  assert(roulette.colorOf(0) === 'green', '0 is green');
  assert(roulette.colorOf(1) === 'red', '1 is a known red number');
  assert(roulette.colorOf(2) === 'black', '2 is a known black number');
  assert(roulette.colorOf(36) === 'red', '36 is a known red number');
  assert(roulette.RED_NUMBERS.size === 18, 'exactly 18 red numbers (18 black + 18 red + 1 green(0) = 37 total)');
})();

// ================= pure logic: isValidBet =================
(function testIsValidBet() {
  console.log('\n--- isValidBet ---');
  assert(roulette.isValidBet({ type: 'red', amount: 10 }) === true, 'a red bet with a positive amount is valid');
  assert(roulette.isValidBet({ type: 'straight', number: 17, amount: 5 }) === true, 'a straight bet on a valid number is valid');
  assert(roulette.isValidBet({ type: 'straight', number: 37, amount: 5 }) === false, 'a straight bet on 37 (out of range) is invalid');
  assert(roulette.isValidBet({ type: 'straight', number: -1, amount: 5 }) === false, 'a straight bet on -1 is invalid');
  assert(roulette.isValidBet({ type: 'straight', number: 5.5, amount: 5 }) === false, 'a non-integer straight number is invalid');
  assert(roulette.isValidBet({ type: 'red', amount: 0 }) === false, 'a zero-amount bet is invalid');
  assert(roulette.isValidBet({ type: 'red', amount: -5 }) === false, 'a negative-amount bet is invalid');
  assert(roulette.isValidBet({ type: 'nonsense', amount: 5 }) === false, 'an unknown bet type is invalid');
  assert(roulette.isValidBet(null) === false, 'null is not a valid bet');
})();

// ================= pure logic: payoutMultiplierForBet =================
(function testPayout() {
  console.log('\n--- payoutMultiplierForBet ---');
  assert(roulette.payoutMultiplierForBet({ type: 'straight', number: 17 }, 17) === 36, 'straight-up hit returns 36x total (35:1 profit + stake back)');
  assert(roulette.payoutMultiplierForBet({ type: 'straight', number: 17 }, 18) === 0, 'straight-up miss returns 0');
  assert(roulette.payoutMultiplierForBet({ type: 'red' }, 1) === 2, 'red bet wins 2x total on a red number (1)');
  assert(roulette.payoutMultiplierForBet({ type: 'red' }, 2) === 0, 'red bet loses on a black number (2)');
  assert(roulette.payoutMultiplierForBet({ type: 'red' }, 0) === 0, 'red bet loses on 0 (the house edge number)');
  assert(roulette.payoutMultiplierForBet({ type: 'black' }, 2) === 2, 'black bet wins on a black number (2)');
  assert(roulette.payoutMultiplierForBet({ type: 'odd' }, 3) === 2, 'odd bet wins on an odd number');
  assert(roulette.payoutMultiplierForBet({ type: 'even' }, 4) === 2, 'even bet wins on an even number');
  assert(roulette.payoutMultiplierForBet({ type: 'even' }, 0) === 0, 'even bet loses on 0 (0 is neither odd nor even for betting purposes)');
  assert(roulette.payoutMultiplierForBet({ type: 'low' }, 18) === 2, 'low (1-18) bet wins at the boundary 18');
  assert(roulette.payoutMultiplierForBet({ type: 'low' }, 19) === 0, 'low bet loses just past the boundary (19)');
  assert(roulette.payoutMultiplierForBet({ type: 'high' }, 19) === 2, 'high (19-36) bet wins at the boundary 19');
})();

// ================= pure logic: resolveBets aggregation =================
(function testResolveBets() {
  console.log('\n--- resolveBets ---');
  const bets = [{ type: 'straight', number: 7, amount: 10 }, { type: 'red', amount: 20 }, { type: 'black', amount: 15 }];
  const res = roulette.resolveBets(bets, 7); // 7 is red
  assert(res.totalStaked === 45, 'totalStaked sums every bet amount');
  assert(res.results[0].multiplier === 36 && res.results[0].returned === 360, 'the straight-up bet on the exact winner returns 36x');
  assert(res.results[1].multiplier === 2 && res.results[1].returned === 40, 'the red bet wins (7 is red)');
  assert(res.results[2].multiplier === 0 && res.results[2].returned === 0, 'the black bet loses (7 is red, not black)');
  assert(res.totalReturned === 400, 'totalReturned sums every individual payout');
  assert(res.net === 400 - 45, 'net is totalReturned minus totalStaked');
})();

// ================= statistical sanity: spin() is roughly uniform over 0-36 =================
(function testSpinUniformity() {
  console.log('\n--- spin() statistical fairness ---');
  const N = 37000;
  const counts = new Array(37).fill(0);
  let outOfRange = 0;
  for (let i = 0; i < N; i++) {
    const n = roulette.spin();
    if (n < 0 || n > 36 || !Number.isInteger(n)) outOfRange++;
    else counts[n]++;
  }
  assert(outOfRange === 0, 'every single spin (checked ' + N + ' of them) lands on an integer 0-36, never out of range');
  const expected = N / 37;
  // Generous +/-30% band around the expected per-number count -- at N=37000
  // the true standard deviation per bucket is ~31, so this band is roughly
  // 10 standard deviations wide (astronomically unlikely to false-positive
  // on a fair RNG) while still catching a genuinely broken/biased spin().
  const low = expected * 0.7, high = expected * 1.3;
  const allWithinBand = counts.every(c => c >= low && c <= high);
  assert(allWithinBand, 'every number 0-36 comes up within a generous statistical band of the expected ~' + Math.round(expected) + ' hits over ' + N + ' spins (min seen: ' + Math.min(...counts) + ', max seen: ' + Math.max(...counts) + ')');
})();

// ================= RouletteTableManager: seating + betting =================
(function testSeatingBetting() {
  console.log('\n--- table seating / betting ---');
  const mgr = new RouletteTableManager();
  // Unique-per-run suffix (same fix as cabinetTest.js's CabinetDataUser and
  // plinkoTest.js's PlinkoPoor) -- playersStore persists to the REAL
  // data/players.json and addKkoin() is additive, so a fixed literal name's
  // balance drifts upward across repeated runs and eventually breaks the
  // exact-equality assertion below. Caught failing during the 2026-07-22
  // bubbles.js verification pass (RtHost had drifted well past 100 from
  // earlier runs).
  const hostNick = 'RtHost' + Date.now();
  const guestNick = 'RtGuest' + Date.now();
  const { table } = mgr.createTable(hostNick, 'sock-1', null);
  const code = table.code;
  mgr.joinTable(code, guestNick, 'sock-2', null);
  assert(mgr.getTable(code).seats.length === 2, 'two players seated');

  playersStore.addKkoin(hostNick, 100);
  playersStore.addKkoin(guestNick, 3);

  const tooMuch = mgr.placeBets(code, hostNick, [{ type: 'red', amount: 999 }]);
  assert(!!tooMuch.error, 'placeBets rejects a total that exceeds the balance');

  const badShape = mgr.placeBets(code, hostNick, [{ type: 'straight', number: 99, amount: 5 }]);
  assert(!!badShape.error, 'placeBets rejects an invalid bet shape (out-of-range straight number)');

  const ok = mgr.placeBets(code, hostNick, [{ type: 'red', amount: 10 }, { type: 'straight', number: 4, amount: 5 }]);
  assert(ok.ok, 'placeBets accepts a valid multi-bet list');
  assert(playersStore.getOrCreatePlayer(hostNick).kkoin === 100, 'placing bets alone never touches the balance yet');

  const notSeated = mgr.placeBets(code, 'RandomStranger', [{ type: 'red', amount: 1 }]);
  assert(!!notSeated.error, 'placeBets rejects a nickname that never joined this table');

  const cleared = mgr.placeBets(code, guestNick, []);
  assert(cleared.ok, 'an empty bet list is accepted (sitting out this spin)');
})();

// ================= RouletteTableManager: spin resolution + KKoin conservation =================
(function testSpinResolution() {
  console.log('\n--- spin(): deterministic payout + balance conservation ---');
  const mgr = new RouletteTableManager();
  const { table } = mgr.createTable('SpinA', 'sock-1', null);
  const code = table.code;
  mgr.joinTable(code, 'SpinB', 'sock-2', null);
  playersStore.addKkoin('SpinA', 200);
  playersStore.addKkoin('SpinB', 200);

  mgr.placeBets(code, 'SpinA', [{ type: 'straight', number: 22, amount: 10 }]); // will WIN if the rigged spin lands on 22
  mgr.placeBets(code, 'SpinB', [{ type: 'straight', number: 5, amount: 10 }]);  // will LOSE (spin rigged to 22)

  const balBeforeA = playersStore.getOrCreatePlayer('SpinA').kkoin;
  const balBeforeB = playersStore.getOrCreatePlayer('SpinB').kkoin;

  // Rig the outcome deterministically by stubbing Math.random for exactly
  // this one call -- restored immediately in a finally so no other test in
  // this process (or the shared card-shuffle logic elsewhere) is affected.
  const realRandom = Math.random;
  Math.random = () => 22 / 37 + 0.001; // floor((22/37+eps)*37) === 22
  let spinRes;
  try {
    spinRes = mgr.spin(code, 'SpinA');
  } finally {
    Math.random = realRandom;
  }
  assert(spinRes.ok, 'spin() succeeds with 2 seats staked');
  const t = mgr.getTable(code);
  assert(t.status === 'result', 'table moves to the result phase after spinning');
  assert(t.winningNumber === 22, 'the rigged Math.random stub produced exactly the intended winning number (22)');

  assert(playersStore.getOrCreatePlayer('SpinA').kkoin === balBeforeA - 10 + 360, 'SpinA staked 10 on the exact winner and gets 360 back (36x), net +350');
  assert(playersStore.getOrCreatePlayer('SpinB').kkoin === balBeforeB - 10, 'SpinB staked 10 on a losing number and gets nothing back, net -10');

  const seatA = t.seats.find(s => s.nickname === 'SpinA');
  assert(seatA.lastResult && seatA.lastResult.net === 350, "SpinA's lastResult.net matches the real balance change");

  const spinAgain = mgr.spin(code, 'SpinA');
  assert(!!spinAgain.error, 'spin() refuses to run again before a new betting round starts');

  const newRoundRes = mgr.newRound(code, 'SpinA');
  assert(newRoundRes.ok, 'newRound succeeds once the table is in "result"');
  assert(mgr.getTable(code).status === 'lobby', 'newRound returns the table to the lobby phase');
  assert(mgr.getTable(code).seats.every(s => s.pendingBets.length === 0 && s.lastResult === null), 'newRound clears every seat\'s bets/results');
})();

// ================= RouletteTableManager: MIN_BETTORS_TO_SPIN =================
(function testMinBettors() {
  console.log('\n--- MIN_BETTORS_TO_SPIN ---');
  assert(MIN_BETTORS_TO_SPIN === 1, 'unlike Blackjack (needs 2 to play a turn order), a single bettor is enough to spin the wheel -- roulette has no opponent to wait for');
  const mgr = new RouletteTableManager();
  const { table } = mgr.createTable('SoloSpinner', 'sock-1', null);
  playersStore.addKkoin('SoloSpinner', 50);
  const noBetYet = mgr.spin(table.code, 'SoloSpinner');
  assert(!!noBetYet.error, 'spin() refuses with zero bets down');
  mgr.placeBets(table.code, 'SoloSpinner', [{ type: 'red', amount: 5 }]);
  const soloSpin = mgr.spin(table.code, 'SoloSpinner');
  assert(soloSpin.ok, 'a lone seated player can still spin once they have a bet down');
})();

console.log('\n=== ' + passed + '/' + (passed + failed) + ' Roulette assertions passed ===');
if (failed > 0) process.exit(1);
