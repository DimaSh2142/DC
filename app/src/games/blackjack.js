// Блекджек (Blackjack) -- pure game-logic module. UNLIKE checkers.js/chess.js/
// battleship.js, this is not a 2-human-player game: it's one player vs a
// server-controlled "dealer" (the house), so there's no MiniGameManager/room
// concept here at all -- see src/state/blackjackManager.js for the single-
// player-per-nickname session bookkeeping that sits on top of this file.
//
// Rules match dima's base44 reference design 1:1 (src/pages/Blackjack.jsx in
// the "6a5fd3917e81c2e03dba4d9a (1).zip" export he provided 2026-07-22 --
// note the "(1)" suffix matters, an earlier same-named upload without it was
// an older, blackjack-less export that got checked by mistake first): a
// standard 52-card deck, Ace scores 11 but softens to 1 (subtract 10) if the
// hand would otherwise bust, face cards score 10, the dealer hits while their
// total is below 17 and stands at 17+, a push (equal totals) just refunds the
// stake, a win pays even money (stake back plus an equal amount). No natural-
// blackjack 3:2 bonus, no double-down, no split -- the reference doesn't have
// them either, kept simple on purpose to match it exactly.

const SUITS = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildShuffledDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardScore(c) {
  if (c.rank === 'A') return 11;
  if (c.rank === 'J' || c.rank === 'Q' || c.rank === 'K') return 10;
  return parseInt(c.rank, 10);
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  cards.forEach((c) => {
    if (c.rank === 'A') aces++;
    total += cardScore(c);
  });
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

// state shape: { deck, player: [card], dealer: [card], phase, result, stake, settled }
// phase: 'player' (waiting on hit/stand) | 'dealer' (auto-playing, transient)
//        | 'result' (hand over, see `result`)
// result: null | 'win' | 'lose' | 'push' | 'bust'
function dealInitial(stake) {
  const deck = buildShuffledDeck();
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  return { deck, player, dealer, phase: 'player', result: null, stake, settled: false };
}

function hit(state) {
  if (state.phase !== 'player') return { error: 'Зараз не твоя фаза ходу' };
  const card = state.deck.pop();
  state.player.push(card);
  const v = handValue(state.player);
  if (v > 21) {
    state.phase = 'result';
    state.result = 'bust';
  } else if (v === 21) {
    resolveStand(state); // matches the reference: auto-stand on reaching exactly 21
  }
  return { ok: true, card };
}

function resolveStand(state) {
  state.phase = 'dealer';
  while (handValue(state.dealer) < 17) {
    state.dealer.push(state.deck.pop());
  }
  const pv = handValue(state.player);
  const dv = handValue(state.dealer);
  let result;
  if (dv > 21 || pv > dv) result = 'win';
  else if (dv > pv) result = 'lose';
  else result = 'push';
  state.result = result;
  state.phase = 'result';
}

function stand(state) {
  if (state.phase !== 'player') return { error: 'Зараз не твоя фаза ходу' };
  resolveStand(state);
  return { ok: true };
}

// How many multiples of the (already-deducted) stake to hand back:
// win -> 2x (the stake itself plus an equal winning), push -> 1x (just a
// refund, no profit), lose/bust -> 0x (stake stays with the house).
function payoutMultiplier(result) {
  if (result === 'win') return 2;
  if (result === 'push') return 1;
  return 0;
}

// Redacted view for the client -- the dealer's 2nd card (and anything dealt
// after it) stays hidden while phase is still 'player', exactly mirroring
// the reference's <PlayingCard hidden={hidden && i === 1} /> behavior.
function getPublicView(state) {
  const dealerHidden = state.phase === 'player';
  const visibleDealer = dealerHidden ? state.dealer.slice(0, 1) : state.dealer;
  return {
    player: state.player,
    dealer: visibleDealer,
    dealerHasHiddenCard: dealerHidden,
    phase: state.phase,
    result: state.result,
    playerValue: handValue(state.player),
    dealerValue: handValue(visibleDealer),
    stake: state.stake
  };
}

module.exports = {
  SUITS, RANKS, buildShuffledDeck, cardScore, handValue,
  dealInitial, hit, stand, payoutMultiplier, getPublicView
};
