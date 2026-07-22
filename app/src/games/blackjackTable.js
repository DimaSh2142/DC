// Блекджек за спільним столом (multiplayer Blackjack) -- pure game-logic
// module for the "2-6 seats, one shared dealer sequence" mode dima asked for
// 2026-07-22 ("зроби щоб блек джек можна було грати з іншими учасниками").
// This is deliberately a SEPARATE module from games/blackjack.js, not an
// extension of it -- that file's dealInitial/hit/stand state machine bakes
// in a single-hand-IS-the-whole-game assumption (its own embedded deck,
// hit() auto-triggering the dealer's play the instant a hand reaches 21)
// that doesn't hold once several independent hands share one shoe and only
// ONE shared dealer-resolution should ever happen, after every seat is
// done, not after each seat's own 21.
//
// What genuinely IS reused from games/blackjack.js (the "already correct and
// tested" parts, per dima's ask): buildShuffledDeck, handValue/cardScore
// (Ace soft-reduction etc.), and payoutMultiplier -- those are pure card-math
// with no single-player assumptions baked in, so there was no reason to
// duplicate them. Only the turn-sequencing/dealer-orchestration is new here.
//
// Table-round shape (owned by blackjackTableManager.js, this file just
// operates on plain data it's handed):
//   deck: [card]  -- ONE shared shoe for every seat + the dealer this round
//   dealerHand: [card]
//   Each seat's own hand array lives on the seat object in the manager;
//   this module's functions take (deck, hand) rather than a whole seat so
//   they stay simple, pure, and easy to unit-test in isolation.

const { buildShuffledDeck, handValue, cardScore, payoutMultiplier } = require('./blackjack');

// Deals 2 cards to each of `seatCount` seats (in seat order, one card per
// seat, twice -- matches how a real shared shoe is dealt round-robin) then 2
// to the dealer, all from one freshly shuffled deck. Returns the deck
// (already popped down) plus the dealt hands so the caller can assign them.
function dealRound(seatCount) {
  const deck = buildShuffledDeck();
  const seatHands = Array.from({ length: seatCount }, () => []);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < seatCount; i++) seatHands[i].push(deck.pop());
  }
  const dealerHand = [deck.pop(), deck.pop()];
  return { deck, seatHands, dealerHand };
}

// Draws one card from the shared deck into a single seat's hand. Unlike
// games/blackjack.js's hit(), this deliberately does NOT auto-trigger dealer
// play on reaching 21 -- with several seats sharing a turn order, "this seat
// is done" and "the dealer plays" are two different events (the dealer only
// plays once, after the LAST seat finishes; see resolveDealer below).
function hitSeat(deck, hand) {
  const card = deck.pop();
  hand.push(card);
  const value = handValue(hand);
  return { card, value, bust: value > 21, autoStand: value === 21 };
}

// Runs the house's fixed strategy (hit while <17, stand at 17+) exactly once
// for the whole table, after every seat has either stood or bust. Mirrors
// games/blackjack.js's resolveStand threshold so the house plays identically
// in both modes.
function resolveDealer(deck, dealerHand) {
  while (handValue(dealerHand) < 17) dealerHand.push(deck.pop());
  return handValue(dealerHand);
}

// Per-seat outcome once the dealer's hand is final. A seat that already
// bust loses regardless of the dealer's total (the dealer doesn't even need
// to have played for a bust seat to know its own fate, but by the time this
// is called the dealer always has, since it only runs once at the end).
function outcomeForSeat(seatHand, dealerHand, dealerBust) {
  const seatValue = handValue(seatHand);
  if (seatValue > 21) return 'bust';
  const dealerValue = handValue(dealerHand);
  if (dealerBust) return 'win';
  if (seatValue > dealerValue) return 'win';
  if (seatValue < dealerValue) return 'lose';
  return 'push';
}

module.exports = {
  buildShuffledDeck, handValue, cardScore, payoutMultiplier, // re-exported for convenience so callers only need one require()
  dealRound, hitSeat, resolveDealer, outcomeForSeat
};
