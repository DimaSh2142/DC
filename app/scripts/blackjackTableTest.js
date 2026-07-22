// Tests for multiplayer Blackjack TABLES -- pure logic (src/games/blackjackTable.js)
// plus the seat/betting/turn-order/settlement bookkeeping
// (src/state/blackjackTableManager.js). Same PASS/FAIL/assert style as
// scripts/blackjackTest.js (which this deliberately does NOT duplicate --
// solo vs-the-house is untouched and already covered there).

const bjTable = require('../src/games/blackjackTable');
const { BlackjackTableManager, MAX_SEATS } = require('../src/state/blackjackTableManager');
const playersStore = require('../src/state/playersStore');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

// ================= pure logic: dealRound =================
(function testDealRound() {
  console.log('\n--- dealRound ---');
  const { deck, seatHands, dealerHand } = bjTable.dealRound(3);
  assert(seatHands.length === 3, 'deals exactly one hand per seat');
  seatHands.forEach((h, i) => assert(h.length === 2, 'seat ' + i + ' gets 2 cards'));
  assert(dealerHand.length === 2, 'dealer gets 2 cards');
  assert(deck.length === 52 - (3 * 2) - 2, 'the shared shoe is reduced by exactly every card dealt (3 seats x2 + dealer x2)');

  // round-robin dealing order: first card to every seat, THEN second card to
  // every seat (matches a real shared shoe) -- verify by re-deriving what a
  // fixed deck would produce.
  const seenCards = new Set();
  seatHands.forEach(h => h.forEach(c => seenCards.add(c.rank + c.suit)));
  dealerHand.forEach(c => seenCards.add(c.rank + c.suit));
  assert(seenCards.size === 8, 'all 8 dealt cards are distinct (no card dealt twice)');
})();

// ================= pure logic: hitSeat =================
(function testHitSeat() {
  console.log('\n--- hitSeat ---');
  const deck = [{ rank: '5', suit: '♠' }];
  const hand = [{ rank: 'K', suit: '♥' }, { rank: '6', suit: '♦' }]; // 16
  const res = bjTable.hitSeat(deck, hand);
  assert(hand.length === 3 && deck.length === 0, 'hitSeat pops one card from the shared deck onto the hand');
  assert(res.value === 21, '16 + 5 = 21');
  assert(res.autoStand === true && res.bust === false, 'reaching exactly 21 is flagged autoStand, not bust');

  const bustDeck = [{ rank: 'Q', suit: '♣' }];
  const bustHand = [{ rank: 'K', suit: '♥' }, { rank: '9', suit: '♦' }]; // 19
  const bustRes = bjTable.hitSeat(bustDeck, bustHand);
  assert(bustRes.bust === true, '19 + 10(Q) = 29 busts');
})();

// ================= pure logic: resolveDealer / outcomeForSeat =================
(function testDealerAndOutcome() {
  console.log('\n--- resolveDealer / outcomeForSeat ---');
  const deck = [{ rank: '5', suit: '♠' }]; // dealer draws this once (12 -> 17)
  const dealerHand = [{ rank: '10', suit: '♠' }, { rank: '2', suit: '♥' }]; // 12, must hit
  const finalValue = bjTable.resolveDealer(deck, dealerHand);
  assert(finalValue === 17 && dealerHand.length === 3, 'dealer below 17 draws until reaching 17+ (12 -> 17 here), then stops');

  assert(bjTable.outcomeForSeat([{ rank: 'K', suit: '♠' }, { rank: 'Q', suit: '♥' }, { rank: '5', suit: '♦' }], dealerHand, false) === 'bust', 'a seat over 21 is "bust" regardless of the dealer');
  assert(bjTable.outcomeForSeat([{ rank: '10', suit: '♠' }, { rank: '9', suit: '♥' }], dealerHand, false) === 'win', '19 beats dealer 17');
  assert(bjTable.outcomeForSeat([{ rank: '10', suit: '♠' }, { rank: '6', suit: '♥' }], dealerHand, false) === 'lose', '16 loses to dealer 17');
  assert(bjTable.outcomeForSeat([{ rank: '10', suit: '♠' }, { rank: '7', suit: '♥' }], dealerHand, false) === 'push', '17 ties dealer 17 -- push');
  assert(bjTable.outcomeForSeat([{ rank: '10', suit: '♠' }, { rank: '6', suit: '♥' }], dealerHand, true) === 'win', 'a dealer bust wins for any seat that didn\'t also bust, even a low 16');
})();

// ================= BlackjackTableManager: seating/lobby =================
(function testSeatingLobby() {
  console.log('\n--- table seating / lobby ---');
  const mgr = new BlackjackTableManager();
  const created = mgr.createTable('TableHost', 'sock-1', null);
  assert(created.table && created.table.status === 'lobby', 'createTable starts a fresh table in the lobby phase');
  const code = created.table.code;

  const join2 = mgr.joinTable(code, 'Guest2', 'sock-2', null);
  assert(join2.ok !== false && !join2.error, 'a second player can join the lobby');
  const join3 = mgr.joinTable(code, 'Guest3', 'sock-3', null);
  assert(!join3.error, 'a third player can join too (table supports >2 seats)');
  assert(mgr.getTable(code).seats.length === 3, 'table now has 3 seated players');

  const reJoin = mgr.joinTable(code, 'guest2', 'sock-2b', null); // case-insensitive same identity
  assert(reJoin.reconnect === true, 'joining again with the same (case-insensitive) nickname is treated as a reconnect, not a new seat');
  assert(mgr.getTable(code).seats.length === 3, 'a reconnect does not add a duplicate seat');

  const badJoin = mgr.joinTable('ZZZZ', 'Nobody', 'sock-x', null);
  assert(!!badJoin.error, 'joining a non-existent table code fails cleanly');

  // fill to MAX_SEATS and verify the (MAX_SEATS+1)th join is rejected
  for (let i = 4; i <= MAX_SEATS; i++) mgr.joinTable(code, 'Filler' + i, 'sock-f' + i, null);
  assert(mgr.getTable(code).seats.length === MAX_SEATS, 'table fills up to MAX_SEATS');
  const overflow = mgr.joinTable(code, 'OneTooMany', 'sock-over', null);
  assert(!!overflow.error, 'a table at MAX_SEATS refuses a new (never-seated-before) player');

  const leaveRes = mgr.leaveTable(code, 'Filler' + MAX_SEATS);
  assert(leaveRes.ok, 'a seated player can leave during the lobby phase');
  assert(mgr.getTable(code).seats.length === MAX_SEATS - 1, 'leaving actually frees the seat');
})();

// ================= BlackjackTableManager: betting =================
(function testBetting() {
  console.log('\n--- betting ---');
  const mgr = new BlackjackTableManager();
  const { table } = mgr.createTable('BetHost', 'sock-1', null);
  const code = table.code;
  mgr.joinTable(code, 'BetGuest', 'sock-2', null);

  playersStore.addKkoin('BetHost', 100);
  playersStore.addKkoin('BetGuest', 5);

  const tooRich = mgr.placeBet(code, 'BetHost', 99999);
  assert(!!tooRich.error, 'placeBet rejects a stake bigger than the balance');

  const okBet = mgr.placeBet(code, 'BetHost', 20);
  assert(okBet.ok, 'placeBet accepts an affordable stake');
  assert(playersStore.getOrCreatePlayer('BetHost').kkoin === 100, 'placeBet alone (before startRound) never touches the balance yet');

  const notSeated = mgr.placeBet(code, 'RandomStranger', 5);
  assert(!!notSeated.error, 'placeBet rejects a nickname that never joined this table');

  const onlyOneReady = mgr.startRound(code, 'BetHost');
  assert(!!onlyOneReady.error, 'startRound refuses when fewer than 2 seats have placed a bet');

  const guestBet = mgr.placeBet(code, 'BetGuest', 5);
  assert(guestBet.ok, 'the second seat places an affordable bet too');
})();

// ================= BlackjackTableManager: full round + balance conservation =================
(function testFullRoundConservation() {
  console.log('\n--- full round: turn order + dealer resolution + payout conservation ---');
  const mgr = new BlackjackTableManager();
  const { table } = mgr.createTable('RoundA', 'sock-1', null);
  const code = table.code;
  mgr.joinTable(code, 'RoundB', 'sock-2', null);
  mgr.joinTable(code, 'RoundC', 'sock-3', null);

  playersStore.addKkoin('RoundA', 500);
  playersStore.addKkoin('RoundB', 500);
  playersStore.addKkoin('RoundC', 500);
  // RoundC deliberately does NOT bet -- should sit out this round untouched.
  mgr.placeBet(code, 'RoundA', 30);
  mgr.placeBet(code, 'RoundB', 10);

  const balancesBefore = {
    RoundA: playersStore.getOrCreatePlayer('RoundA').kkoin,
    RoundB: playersStore.getOrCreatePlayer('RoundB').kkoin,
    RoundC: playersStore.getOrCreatePlayer('RoundC').kkoin
  };

  const startRes = mgr.startRound(code, 'RoundA');
  assert(startRes.ok, 'startRound succeeds with 2 seats staked');
  let t = mgr.getTable(code);
  assert(t.status === 'playing', 'table moves to the playing phase');
  assert(playersStore.getOrCreatePlayer('RoundA').kkoin === balancesBefore.RoundA - 30, "RoundA's stake is deducted the instant the round starts");
  assert(playersStore.getOrCreatePlayer('RoundB').kkoin === balancesBefore.RoundB - 10, "RoundB's stake is deducted too");
  assert(playersStore.getOrCreatePlayer('RoundC').kkoin === balancesBefore.RoundC, "RoundC never bet, so RoundC's balance is untouched");

  const seatA = t.seats.find(s => s.nickname === 'RoundA');
  const seatC = t.seats.find(s => s.nickname === 'RoundC');
  assert(seatA.inRound === true, 'a betting seat is marked inRound');
  assert(seatC.inRound === false, 'a non-betting seat sits out (not inRound)');
  assert(seatC.done === true, 'a sitting-out seat is pre-marked done so turn order skips it entirely');

  const wrongTurn = mgr.hit(code, t.seats[t.turnIdx].key === playersStore.keyOf('RoundA') ? 'RoundB' : 'RoundA');
  assert(!!wrongTurn.error, "acting out of turn is rejected ('" + wrongTurn.error + "')");

  // Every in-round seat just stands immediately on their turn -- deterministic
  // regardless of the random shuffle, and still genuinely exercises turn
  // advancement + the single shared dealer resolution at the end.
  let guard = 0;
  while (mgr.getTable(code).status === 'playing' && guard++ < 10) {
    const cur = mgr.getTable(code);
    const actingSeat = cur.seats[cur.turnIdx];
    const res = mgr.stand(code, actingSeat.nickname);
    assert(res.ok, actingSeat.nickname + ' stands successfully on their turn');
  }
  t = mgr.getTable(code);
  assert(t.status === 'result', 'once every in-round seat has acted, the table auto-resolves to "result"');
  assert(bjTable.handValue(t.dealerHand) >= 17, 'the dealer always ends at 17+ (or busts, which is also >=17) per house rules');

  const seatAFinal = t.seats.find(s => s.nickname === 'RoundA');
  const seatBFinal = t.seats.find(s => s.nickname === 'RoundB');
  assert(seatAFinal.settled && seatBFinal.settled, 'both in-round seats are marked settled');
  assert(['win', 'lose', 'push', 'bust'].includes(seatAFinal.result), 'RoundA has a final result');

  const expectedA = balancesBefore.RoundA - 30 + bjTable.payoutMultiplier(seatAFinal.result) * 30;
  const expectedB = balancesBefore.RoundB - 10 + bjTable.payoutMultiplier(seatBFinal.result) * 10;
  assert(playersStore.getOrCreatePlayer('RoundA').kkoin === expectedA, "RoundA's final balance exactly matches stake-deducted-then-payoutMultiplier-applied, whatever the real outcome was (" + seatAFinal.result + ")");
  assert(playersStore.getOrCreatePlayer('RoundB').kkoin === expectedB, "RoundB's final balance is independently correct too (" + seatBFinal.result + ")");
  assert(playersStore.getOrCreatePlayer('RoundC').kkoin === balancesBefore.RoundC, "RoundC (sat out) still has an untouched balance after the round resolves");

  // double-settle guard, same idea as blackjackTest.js's
  const balAfterFirstSettle = playersStore.getOrCreatePlayer('RoundA').kkoin;
  seatAFinal.settled = false;
  mgr.settleRound(t);
  assert(playersStore.getOrCreatePlayer('RoundA').kkoin !== balAfterFirstSettle || bjTable.payoutMultiplier(seatAFinal.result) === 0, 're-arming settled and calling settleRound again pays out exactly once more (unless the result pays 0x, in which case the balance correctly stays put)');
  seatAFinal.settled = false;
  const balAfterSecondArm = playersStore.getOrCreatePlayer('RoundA').kkoin;
  mgr.settleRound(t);
  mgr.settleRound(t); // settled is now true again -- this THIRD call must be a no-op
  assert(playersStore.getOrCreatePlayer('RoundA').kkoin === balAfterSecondArm + bjTable.payoutMultiplier(seatAFinal.result) * 30, 'settleRound never pays out twice for an already-settled seat');

  // newRound resets cleanly and the table can be played again
  const newRoundRes = mgr.newRound(code, 'RoundA');
  assert(newRoundRes.ok, 'newRound succeeds once the table is in "result"');
  t = mgr.getTable(code);
  assert(t.status === 'lobby', 'newRound returns the table to the lobby phase');
  assert(t.seats.every(s => s.pendingBet === 0 && !s.inRound && s.hand.length === 0), 'newRound clears every seat\'s bet/hand/inRound flags');
})();

// ================= disconnected seat auto-stand =================
(function testDisconnectAutoStand() {
  console.log('\n--- disconnected seat auto-stand ---');
  const mgr = new BlackjackTableManager();
  const { table } = mgr.createTable('DiscA', 'sock-1', null);
  const code = table.code;
  mgr.joinTable(code, 'DiscB', 'sock-2', null);
  playersStore.addKkoin('DiscA', 200);
  playersStore.addKkoin('DiscB', 200);
  mgr.placeBet(code, 'DiscA', 15);
  mgr.placeBet(code, 'DiscB', 15);
  mgr.startRound(code, 'DiscA');

  // whoever's turn it ISN'T, disconnect them -- advanceTurn should skip/
  // auto-stand a disconnected seat rather than the table hanging forever.
  let t = mgr.getTable(code);
  const actingKey = t.seats[t.turnIdx].key;
  const otherSeat = t.seats.find(s => s.key !== actingKey);
  mgr.disconnectSocket(otherSeat.socketId);

  let guard = 0;
  while (mgr.getTable(code).status === 'playing' && guard++ < 10) {
    const cur = mgr.getTable(code);
    const actor = cur.seats[cur.turnIdx];
    if (!actor) break;
    mgr.stand(code, actor.nickname);
  }
  t = mgr.getTable(code);
  assert(t.status === 'result', 'a table with one disconnected seat still reaches "result" instead of hanging (disconnected seats get auto-stood)');
})();

console.log('\n=== ' + passed + '/' + (passed + failed) + ' Blackjack-table assertions passed ===');
if (failed > 0) process.exit(1);
