// Рулетка (Roulette) -- pure game-logic module. European single-zero wheel
// (0-36, no American 00) per dima's Казино spec. Supports straight-up
// number bets and the standard even-money outside bets (red/black, odd/
// even, low/high). No dozens/columns/splits/streets -- the task only asked
// for "at minimum" straight-up + the standard even-money bets, and this
// app's casino already keeps rules deliberately simple (see blackjack.js's
// own "no double/no split" note), so the outside-bet set stops there too.
//
// Payout convention: payoutMultiplierForBet returns the TOTAL RETURN
// multiplier (stake included), the same convention games/blackjack.js's
// payoutMultiplier uses (win -> 2x total back, not "1:1" profit-only
// industry phrasing) so every game's payout math reads the same way across
// this app. In that convention, real-world "35:1" straight-up odds are a
// 36x total return (35x profit + the 1x stake back), and real-world "1:1"
// even-money odds are a 2x total return.

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BET_TYPES = ['straight', 'red', 'black', 'odd', 'even', 'low', 'high'];

function colorOf(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// Server-authoritative -- the ONLY place a winning number is ever decided.
// Clients never submit or trust an outcome, they only animate toward
// whatever this returns (see casinoHandlers.js / roulette.js client).
function spin() {
  return Math.floor(Math.random() * 37); // 0-36 inclusive
}

function isValidBet(bet) {
  if (!bet || typeof bet !== 'object') return false;
  const amount = Math.floor(Number(bet.amount));
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (!BET_TYPES.includes(bet.type)) return false;
  if (bet.type === 'straight') {
    const n = Number(bet.number);
    if (!Number.isInteger(n) || n < 0 || n > 36) return false;
  }
  return true;
}

function payoutMultiplierForBet(bet, winningNumber) {
  const n = winningNumber;
  switch (bet.type) {
    case 'straight': return Number(bet.number) === n ? 36 : 0;
    case 'red': return n !== 0 && RED_NUMBERS.has(n) ? 2 : 0;
    case 'black': return n !== 0 && !RED_NUMBERS.has(n) ? 2 : 0;
    case 'odd': return n !== 0 && n % 2 === 1 ? 2 : 0;
    case 'even': return n !== 0 && n % 2 === 0 ? 2 : 0;
    case 'low': return n >= 1 && n <= 18 ? 2 : 0;
    case 'high': return n >= 19 && n <= 36 ? 2 : 0;
    default: return 0;
  }
}

// Resolves a whole list of bets against one spin -- returns per-bet payout
// plus the totals a caller (the table manager) needs to settle KKoin.
function resolveBets(bets, winningNumber) {
  let totalStaked = 0, totalReturned = 0;
  const results = bets.map((bet) => {
    const amount = Math.floor(Number(bet.amount));
    const mult = payoutMultiplierForBet(bet, winningNumber);
    const returned = amount * mult;
    totalStaked += amount;
    totalReturned += returned;
    return { bet, multiplier: mult, returned };
  });
  return { results, totalStaked, totalReturned, net: totalReturned - totalStaked };
}

module.exports = { RED_NUMBERS, BET_TYPES, colorOf, spin, isValidBet, payoutMultiplierForBet, resolveBets };
