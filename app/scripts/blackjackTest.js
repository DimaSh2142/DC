// Tests for Blackjack -- pure game-logic (src/games/blackjack.js) plus the
// server-side session/KKoin-stake bookkeeping (src/state/blackjackManager.js).
// Same PASS/FAIL/assert style as scripts/miniGamesTest.js. This is a
// 1-player-vs-house game (see blackjackManager.js's header comment for why
// it deliberately does NOT reuse miniGameManager.js's 2-human-player room
// concept), so there's no socket/room harness needed to exercise the real
// money-math end to end -- calling the manager directly IS the real path.

const blackjack = require('../src/games/blackjack');
const { BlackjackManager } = require('../src/state/blackjackManager');
const playersStore = require('../src/state/playersStore');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

// ================= pure logic: handValue =================
(function testHandValue() {
  console.log('\n--- handValue ---');
  assert(blackjack.handValue([{ rank: '7', suit: '♠' }, { rank: '9', suit: '♥' }]) === 16, '7+9 sums to 16');
  assert(blackjack.handValue([{ rank: 'K', suit: '♠' }, { rank: 'Q', suit: '♥' }]) === 20, 'face cards each score 10 (K+Q=20)');
  assert(blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }]) === 21, 'Ace + King is a natural 21 (Ace counted as 11)');
  assert(blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: '9', suit: '♥' }, { rank: '5', suit: '♦' }]) === 15, 'A+9+5 softens the Ace to 1 (11+9+5=25 busts, so -10 -> 15)');
  assert(blackjack.handValue([{ rank: 'A', suit: '♠' }, { rank: 'A', suit: '♥' }, { rank: '9', suit: '♦' }]) === 21, 'two Aces + 9 only softens ONE Ace (11+1+9=21), not both (which would under-count)');
  assert(blackjack.handValue([{ rank: '10', suit: '♠' }, { rank: '9', suit: '♥' }, { rank: '5', suit: '♦' }]) === 24, '10+9+5 correctly busts at 24 with no aces to soften');
})();

// ================= pure logic: deal/hit/stand state machine =================
(function testStateMachine() {
  console.log('\n--- deal / hit / stand ---');

  const s1 = blackjack.dealInitial(100);
  assert(s1.player.length === 2 && s1.dealer.length === 2, 'dealInitial deals 2 cards to both player and dealer');
  assert(s1.phase === 'player' && s1.result === null && s1.stake === 100, 'a fresh hand starts in "player" phase with no result yet and the stake recorded');
  assert(s1.deck.length === 52 - 4, 'the shoe is a real 52-card deck minus the 4 dealt cards');

  const rejectedHit = blackjack.hit({ phase: 'dealer', player: [], deck: [] });
  assert(!!rejectedHit.error, 'hit() is rejected outside the "player" phase');
  const rejectedStand = blackjack.stand({ phase: 'result', player: [], deck: [], dealer: [] });
  assert(!!rejectedStand.error, 'stand() is rejected outside the "player" phase');

  // force a bust deterministically
  const bustState = { deck: [{ rank: 'K', suit: '♠' }], player: [{ rank: 'K', suit: '♥' }, { rank: 'Q', suit: '♦' }], dealer: [{ rank: '5', suit: '♠' }, { rank: '5', suit: '♥' }], phase: 'player', result: null, stake: 10 };
  blackjack.hit(bustState);
  assert(bustState.phase === 'result' && bustState.result === 'bust', 'drawing a card that pushes the player past 21 immediately ends the hand as "bust"');

  // force an auto-stand on hitting exactly 21 -- dealer already shows 19
  // (>=17), so the dealer draws nothing further and 21 beats 19: a win.
  const auto21 = { deck: [{ rank: '6', suit: '♠' }], player: [{ rank: '5', suit: '♥' }, { rank: '10', suit: '♦' }], dealer: [{ rank: '10', suit: '♠' }, { rank: '9', suit: '♥' }], phase: 'player', result: null, stake: 10 };
  blackjack.hit(auto21); // 5+10=15, +6=21 -> should auto-resolve via resolveStand
  assert(auto21.phase === 'result', 'reaching exactly 21 on a hit auto-stands (matches the reference\'s behavior) instead of waiting for an explicit stand()');
  assert(auto21.result === 'win', 'dealer already had 19 (>=17, draws nothing) so the player\'s auto-stood 21 wins');
})();

(function testDealerStandThreshold() {
  console.log('\n--- dealer play-to-17 threshold ---');
  const winState = { deck: [], player: [{ rank: '5', suit: '♥' }, { rank: '10', suit: '♦' }, { rank: '6', suit: '♠' }], dealer: [{ rank: '10', suit: '♠' }, { rank: '9', suit: '♥' }], phase: 'player', result: null, stake: 10 };
  blackjack.stand(winState);
  assert(winState.phase === 'result', 'stand() moves the hand to "result"');
  assert(winState.result === 'win', 'player 21 vs a dealer who stands at 19 (already >=17, draws nothing) is a clean win for the player');

  // dealer below 17 (10+2=12) must draw; draws the 5 -> 17, then stands.
  // Player has 18 (9+9), which beats the dealer's 17: a win for the player.
  const dealerDrawsState = { deck: [{ rank: '5', suit: '♣' }], player: [{ rank: '9', suit: '♥' }, { rank: '9', suit: '♦' }], dealer: [{ rank: '10', suit: '♠' }, { rank: '2', suit: '♥' }], phase: 'player', result: null, stake: 10 };
  blackjack.stand(dealerDrawsState);
  assert(dealerDrawsState.dealer.length === 3, 'a dealer below 17 (10+2=12) draws exactly one more card here (12+5=17, now stands)');
  assert(dealerDrawsState.result === 'win', 'player 18 (9+9) beats a dealer who draws to 17 (10+2+5)');
})();

// ================= payoutMultiplier =================
(function testPayout() {
  console.log('\n--- payoutMultiplier ---');
  assert(blackjack.payoutMultiplier('win') === 2, 'a win returns 2x the staked amount (the stake itself plus an equal winning)');
  assert(blackjack.payoutMultiplier('push') === 1, 'a push returns exactly 1x (a plain refund, no profit)');
  assert(blackjack.payoutMultiplier('lose') === 0, 'a loss returns 0x (the stake stays with the house)');
  assert(blackjack.payoutMultiplier('bust') === 0, 'a bust returns 0x same as a loss');
})();

// ================= getPublicView redaction =================
(function testPublicView() {
  console.log('\n--- getPublicView redaction ---');
  const s = blackjack.dealInitial(50);
  const viewDuringPlay = blackjack.getPublicView(s);
  assert(viewDuringPlay.dealer.length === 1, "while phase is 'player', only the dealer's FIRST card is exposed");
  assert(viewDuringPlay.dealerHasHiddenCard === true, 'the view explicitly flags that a card is still hidden');
  blackjack.stand(s);
  const viewAfterStand = blackjack.getPublicView(s);
  assert(viewAfterStand.dealer.length === s.dealer.length, "once the hand leaves 'player' phase, the FULL dealer hand is exposed");
  assert(viewAfterStand.dealerHasHiddenCard === false, 'the hidden-card flag clears once revealed');
})();

// ================= BlackjackManager: real KKoin stake lifecycle =================
(function testManager() {
  console.log('\n--- BlackjackManager (KKoin stakes) ---');
  const mgr = new BlackjackManager();

  playersStore.addKkoin('BjRich', 200);
  playersStore.addKkoin('BjPoor', 3);

  const tooRich = mgr.deal('BjRich', 5000);
  assert(!!tooRich.error, 'deal() rejects a stake bigger than the balance');

  const tooPoor = mgr.deal('BjPoor', 50);
  assert(!!tooPoor.error, 'deal() rejects a player whose balance cannot cover the stake');
  assert(playersStore.getOrCreatePlayer('BjPoor').kkoin === 3, "a rejected deal doesn't touch the balance at all");

  const balBefore = playersStore.getOrCreatePlayer('BjRich').kkoin;
  const dealRes = mgr.deal('BjRich', 40);
  assert(dealRes.ok, 'deal() succeeds when the stake is affordable');
  assert(playersStore.getOrCreatePlayer('BjRich').kkoin === balBefore - 40, 'the stake is deducted immediately once the hand is dealt');

  const doubleDeal = mgr.deal('BjRich', 10);
  assert(!!doubleDeal.error, "deal() refuses a second hand while the first one is still 'player'/'dealer' phase");

  const noHandHit = mgr.hit('NobodyPlayingAnything');
  assert(!!noHandHit.error, 'hit() with no active hand is rejected');

  // Drive the real hand to completion (whatever the random outcome is) and
  // verify the balance math is internally consistent no matter which of
  // win/lose/push/bust actually happened -- this is more robust than
  // rigging a specific deck, and still genuinely proves settle() pays out
  // exactly once and exactly the right amount.
  let view = dealRes.view;
  while (view.phase === 'player' && view.playerValue < 21) {
    // hit until either busting, hitting 21 (auto-stand), or we choose to stop at a reasonable total
    if (view.playerValue >= 17) break;
    const r = mgr.hit('BjRich');
    assert(r.ok, 'hit() succeeds while a hand is active');
    view = r.view;
  }
  const balBeforeStand = playersStore.getOrCreatePlayer('BjRich').kkoin;
  if (view.phase === 'player') {
    const standRes = mgr.stand('BjRich');
    assert(standRes.ok, 'stand() succeeds and resolves the hand');
    view = standRes.view;
  }
  assert(view.phase === 'result', 'the hand ends up in "result" phase one way or another (bust, or stand -> dealer resolution)');
  const balAfter = playersStore.getOrCreatePlayer('BjRich').kkoin;
  const expectedMultiplier = blackjack.payoutMultiplier(view.result);
  assert(balAfter === balBeforeStand + expectedMultiplier * 40, 'the balance change after settlement exactly matches payoutMultiplier(result) * stake, whatever the actual result was (' + view.result + ')');

  // double-settle guard
  const balAfterFirstSettle = playersStore.getOrCreatePlayer('BjRich').kkoin;
  mgr.hands.get(playersStore.keyOf('BjRich')).state.settled = false; // simulate a hypothetical duplicate settle attempt
  mgr.settle(mgr.hands.get(playersStore.keyOf('BjRich')));
  // (the line above intentionally re-arms the guard to test it fires once more, then we check it doesn't ALSO fire a 3rd time)
  mgr.settle(mgr.hands.get(playersStore.keyOf('BjRich')));
  const balAfterSecondSettle = playersStore.getOrCreatePlayer('BjRich').kkoin;
  assert(balAfterSecondSettle === balAfterFirstSettle + expectedMultiplier * 40, 'settle() re-armed once pays out exactly once more (not twice) -- the settled flag guards each individual arm/call correctly');

  // a fresh deal after a finished hand is allowed
  playersStore.addKkoin('BjRich', 1000); // top up generously so affordability is never the blocker here
  const secondHandDeal = mgr.deal('BjRich', 25);
  assert(secondHandDeal.ok, 'deal() is accepted again once the previous hand reached "result" phase');
})();

console.log('\n=== ' + passed + '/' + (passed + failed) + ' Blackjack assertions passed ===');
if (failed > 0) process.exit(1);
