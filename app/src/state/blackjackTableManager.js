// Multiplayer Blackjack TABLE manager -- dima 2026-07-22: "зроби щоб блек
// джек можна було грати з іншими учасниками" (make Blackjack playable WITH
// other participants). Standard casino multiplayer Blackjack is NOT
// head-to-head: it's a shared table where 2-6 human seats each have their
// own independent hand/stake against ONE shared dealer sequence, and
// everyone at the table sees everyone else's cards/bets/actions live. This
// is a SEPARATE manager from blackjackManager.js (1-player-vs-house, kept
// completely untouched -- see that file and blackjack.html's mode-select
// screen) rather than a replacement of it, and it does NOT reuse
// miniGameManager.js's room model either: that class is hard-wired to
// exactly 2 human players (players[0]/players[1] everywhere), while a
// Blackjack table needs 2-6 seats, a betting window, and a strict per-seat
// turn order feeding into one shared dealer-resolution -- different enough
// shapes that forcing it through the 2-player room class would need more
// special-casing than just writing its own small manager here.
//
// Round lifecycle per table (status field):
//   'lobby'   -- seats can join/leave freely; each seated player independently
//                places (or clears) a bet for the upcoming round. Nobody's
//                KKoin is touched yet -- affordability is only CHECKED here,
//                the same "don't touch balances until the round for-real
//                starts" discipline miniGameManager.createRoom/joinRoom uses
//                for staked mini-game rooms.
//   'playing' -- triggered once >=2 seated players have a bet placed (any
//                seated player can trigger the deal once that's true, same
//                trust-based "whoever's ready clicks it" spirit as this
//                app's existing rematch/ready-check flows). Stakes are
//                deducted at this instant. Seats WITHOUT a bet just sit out
//                this round (spectating, eligible to bet next round) rather
//                than blocking everyone else. Turn order is seat order among
//                only the seats actually in this round.
//   'result'  -- set the instant every in-round seat has stood/bust and the
//                single shared dealer-resolution has run; payouts already
//                applied by then (settleRound), same "pay out the moment a
//                round becomes final" discipline as miniGameManager.settleStakes.
//                Any seated player can start a fresh 'lobby' betting window
//                (newRound) without anyone having to re-share the table code.
//
// A disconnected seat whose turn comes up is auto-stood (see advanceTurn)
// rather than freezing the whole table for everyone else -- the real-money
// equivalent of a casino dealer moving on when a player steps away.

const playersStore = require('./playersStore');
const bjTable = require('../games/blackjackTable');
let activityStore = null;
try { activityStore = require('./activityStore'); } catch (e) { /* optional -- see logActivity() below */ }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, same as roomManager.js/miniGameManager.js
const MAX_SEATS = 6;
const MIN_SEATS_TO_START = 2;

function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

function logActivity(nickname, entry) {
  // Activity logging (src/state/activityStore.js, added alongside the
  // 2026-07-22 cabinet rebuild) is a nice-to-have signal for the profile
  // page's activity feed/chart -- never worth failing a real-money
  // Blackjack settle over, so this is guarded defensively on both "the
  // module didn't load" (require above) and "logging itself threw".
  if (!activityStore) return;
  try { activityStore.logActivity(nickname, entry); } catch (e) { /* best-effort only */ }
}

class BlackjackSeat {
  constructor(key, nickname, avatar, socketId) {
    this.key = key;
    this.nickname = nickname;
    this.avatar = avatar || null;
    this.socketId = socketId;
    this.connected = true;
    this.pendingBet = 0;   // set during 'lobby' via placeBet, 0 = sitting out the next round
    this.inRound = false;  // true once dealRound has actually dealt this seat in
    this.hand = [];
    this.done = false;     // this seat has stood/bust/finished its turn this round
    this.result = null;    // null | 'win' | 'lose' | 'push' | 'bust'
    this.settled = false;
  }
}

class BlackjackTable {
  constructor(code) {
    this.code = code;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.status = 'lobby'; // 'lobby' | 'playing' | 'result'
    this.seats = [];
    this.deck = [];
    this.dealerHand = [];
    this.turnIdx = -1; // index into seats[] currently acting, only meaningful while status==='playing'
  }
}

class BlackjackTableManager {
  constructor() {
    this.tables = new Map();
  }

  getTable(code) {
    return this.tables.get(String(code || '').trim().toUpperCase());
  }

  deleteTable(code) {
    this.tables.delete(String(code || '').trim().toUpperCase());
  }

  cleanupStale(maxAgeMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [code, table] of this.tables) {
      const anyConnected = table.seats.some(s => s.connected);
      if (!anyConnected && now - table.updatedAt > maxAgeMs) this.deleteTable(code);
    }
  }

  createTable(nickname, socketId, avatar) {
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    let code;
    do { code = randomCode(4); } while (this.tables.has(code));
    const table = new BlackjackTable(code);
    table.seats.push(new BlackjackSeat(key, String(nickname).trim(), avatar, socketId));
    this.tables.set(code, table);
    return { table, seatIdx: 0 };
  }

  seatIdxOf(table, nicknameKey) {
    return table.seats.findIndex(s => s.key === nicknameKey);
  }

  joinTable(code, nickname, socketId, avatar) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    table.updatedAt = Date.now();

    const existing = table.seats.find(s => s.key === key);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      if (avatar) existing.avatar = avatar;
      return { table, seatIdx: table.seats.indexOf(existing), reconnect: true };
    }
    if (table.seats.length >= MAX_SEATS) return { error: 'Стіл вже заповнений (' + MAX_SEATS + '/' + MAX_SEATS + ')' };
    // Joining mid-round is allowed (the task explicitly wants friends able to
    // pull up a chair) -- the new seat just has no bet/hand yet, so it sits
    // out (pendingBet stays 0, inRound stays false) until the next 'lobby'
    // betting window, exactly like a seat that chose not to bet this round.
    const seat = new BlackjackSeat(key, String(nickname).trim(), avatar, socketId);
    table.seats.push(seat);
    return { table, seatIdx: table.seats.length - 1, reconnect: false };
  }

  // Explicit "get up from the table" -- only during 'lobby' (removing a seat
  // mid-hand would corrupt the turn-order array mid-flight; a mid-hand
  // leaver is just left connected:false via disconnectSocket instead, same
  // as every other multiplayer game in this app).
  leaveTable(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'lobby') return { error: 'Не можна вийти під час роздачі' };
    const key = playersStore.keyOf(nickname);
    const idx = this.seatIdxOf(table, key);
    if (idx === -1) return { error: 'Вас немає за цим столом' };
    table.seats.splice(idx, 1);
    table.updatedAt = Date.now();
    if (table.seats.length === 0) this.deleteTable(table.code);
    return { ok: true, table };
  }

  disconnectSocket(socketId) {
    for (const table of this.tables.values()) {
      const seat = table.seats.find(s => s.socketId === socketId);
      if (seat) { seat.connected = false; table.updatedAt = Date.now(); }
    }
  }

  placeBet(code, nickname, stake) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'lobby') return { error: 'Ставки приймаються лише між роздачами' };
    const key = playersStore.keyOf(nickname);
    const seat = table.seats.find(s => s.key === key);
    if (!seat) return { error: 'Вас немає за цим столом' };
    const stakeAmt = Math.max(0, Math.floor(Number(stake) || 0));
    if (stakeAmt === 0) { seat.pendingBet = 0; table.updatedAt = Date.now(); return { ok: true, table }; }
    const profile = playersStore.getOrCreatePlayer(nickname);
    if ((profile.kkoin || 0) < stakeAmt) {
      return { error: 'Недостатньо KKoin для такої ставки (у вас ' + (profile.kkoin || 0) + ')' };
    }
    seat.pendingBet = stakeAmt;
    table.updatedAt = Date.now();
    return { ok: true, table };
  }

  // Any seated player can deal once enough people are ready -- same
  // "whoever's ready clicks it" trust model as this app's existing
  // rematch/ready-check flows (see miniGameHandlers.js's mg:rematch comment).
  startRound(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'lobby') return { error: 'Роздача вже триває' };
    const key = playersStore.keyOf(nickname);
    if (this.seatIdxOf(table, key) === -1) return { error: 'Вас немає за цим столом' };

    const bettingSeats = table.seats.filter(s => s.pendingBet > 0);
    if (bettingSeats.length < MIN_SEATS_TO_START) {
      return { error: 'Потрібно щонайменше ' + MIN_SEATS_TO_START + ' гравці зі ставкою, щоб здати карти' };
    }
    // Re-verify affordability right before actually touching anyone's
    // balance (a seat's KKoin could have moved since placeBet -- e.g. they
    // also topped up or spent elsewhere) -- same re-check-before-deduct
    // discipline as miniGameManager.joinRoom's staked-room path.
    const short = bettingSeats.find(s => (playersStore.getOrCreatePlayer(s.nickname).kkoin || 0) < s.pendingBet);
    if (short) return { error: short.nickname + ' більше не має достатньо KKoin для своєї ставки (' + short.pendingBet + ')' };

    table.seats.forEach((s) => {
      s.inRound = bettingSeats.includes(s);
      s.hand = [];
      s.done = !s.inRound; // sitting-out seats start already "done" so turn-advance skips them
      s.result = null;
      s.settled = false;
    });
    bettingSeats.forEach((s) => playersStore.addKkoin(s.nickname, -s.pendingBet));

    const { deck, seatHands, dealerHand } = bjTable.dealRound(bettingSeats.length);
    table.deck = deck;
    table.dealerHand = dealerHand;
    bettingSeats.forEach((s, i) => { s.hand = seatHands[i]; });
    table.status = 'playing';
    table.turnIdx = -1;
    table.updatedAt = Date.now();
    this.advanceTurn(table); // lands on the first in-round seat (or resolves immediately in the degenerate all-done case)
    return { ok: true, table };
  }

  currentSeat(table) {
    return table.turnIdx >= 0 && table.turnIdx < table.seats.length ? table.seats[table.turnIdx] : null;
  }

  hit(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'playing') return { error: 'Зараз не триває роздача' };
    const key = playersStore.keyOf(nickname);
    const seat = this.currentSeat(table);
    if (!seat || seat.key !== key) return { error: 'Зараз не твій хід' };
    const res = bjTable.hitSeat(table.deck, seat.hand);
    table.updatedAt = Date.now();
    if (res.bust || res.autoStand) {
      seat.done = true;
      seat.result = res.bust ? 'bust' : null; // final win/lose/push for a clean 21 is still decided once the dealer plays -- see settleRound
      this.advanceTurn(table);
    }
    return { ok: true, table };
  }

  stand(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'playing') return { error: 'Зараз не триває роздача' };
    const key = playersStore.keyOf(nickname);
    const seat = this.currentSeat(table);
    if (!seat || seat.key !== key) return { error: 'Зараз не твій хід' };
    seat.done = true;
    table.updatedAt = Date.now();
    this.advanceTurn(table);
    return { ok: true, table };
  }

  // Moves turnIdx to the next in-round seat that hasn't finished yet.
  // Auto-stands any seat found disconnected along the way (a real table
  // can't just freeze because someone's wifi died) instead of skipping it
  // outright -- they still get a fair dealer-resolution against whatever
  // hand they had. Once nobody is left to act, runs the ONE shared dealer
  // play and settles every seat.
  advanceTurn(table) {
    let next = table.turnIdx;
    for (let step = 0; step < table.seats.length; step++) {
      next = (next + 1) % table.seats.length;
      const seat = table.seats[next];
      if (!seat.inRound || seat.done) continue;
      if (!seat.connected) { seat.done = true; continue; } // auto-stand an absent seat, keep scanning for the next real actor
      table.turnIdx = next;
      return;
    }
    // nobody left to act
    table.turnIdx = -1;
    this.resolveDealerAndSettle(table);
  }

  resolveDealerAndSettle(table) {
    const inRoundSeats = table.seats.filter(s => s.inRound);
    if (inRoundSeats.length === 0) { table.status = 'result'; return; }
    const dealerValue = bjTable.resolveDealer(table.deck, table.dealerHand);
    const dealerBust = dealerValue > 21;
    inRoundSeats.forEach((seat) => {
      seat.result = bjTable.outcomeForSeat(seat.hand, table.dealerHand, dealerBust);
    });
    table.status = 'result';
    table.updatedAt = Date.now();
    this.settleRound(table);
  }

  // seat.pendingBet doubles as "the stake this round was played for" -- it's
  // only ever set in the 'lobby' phase (placeBet) and only ever cleared in
  // newRound(), so it's still exactly the deducted amount by the time a
  // round reaches 'result', the same "reuse the field, don't duplicate it"
  // choice blackjackManager.js makes with state.stake.
  settleRound(table) {
    table.seats.forEach((seat) => {
      if (!seat.inRound || seat.settled) return;
      seat.settled = true;
      const mult = bjTable.payoutMultiplier(seat.result);
      if (mult > 0) playersStore.addKkoin(seat.nickname, seat.pendingBet * mult);
      const netLine = mult === 0 ? ('-' + seat.pendingBet) : (mult === 1 ? '+0 (push)' : ('+' + seat.pendingBet * (mult - 1)));
      logActivity(seat.nickname, {
        label: 'Казино · Блекджек (стіл)',
        detail: (seat.result === 'win' ? 'Виграш' : seat.result === 'push' ? 'Нічия' : seat.result === 'bust' ? 'Перебір' : 'Програш') + ' · ' + netLine + ' KKoin',
        accent: mult > 1 ? '#00FFD1' : (mult === 1 ? '#666666' : '#C71585'),
        win: mult > 1
      });
    });
  }

  // dima's next round -- keeps the same seats/code (no re-sharing needed),
  // clears hands/bets/results back to a fresh 'lobby' window. Any seated
  // player can call it once the table is in 'result'.
  newRound(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'result') return { error: 'Поточна роздача ще не завершена' };
    const key = playersStore.keyOf(nickname);
    if (this.seatIdxOf(table, key) === -1) return { error: 'Вас немає за цим столом' };
    table.seats.forEach((s) => {
      s.pendingBet = 0;
      s.inRound = false;
      s.hand = [];
      s.done = false;
      s.result = null;
      s.settled = false;
    });
    table.status = 'lobby';
    table.deck = [];
    table.dealerHand = [];
    table.turnIdx = -1;
    table.updatedAt = Date.now();
    return { ok: true, table };
  }

  // No per-viewer redaction needed (task spec: "no hidden info between
  // players") -- the ONLY thing ever hidden is the dealer's hole card, and
  // that's hidden from EVERYONE equally while status is 'playing', so a
  // single shared view object (not one-per-socket like miniGameManager's
  // publicState/viewerPlayerIdx) is enough here.
  publicState(table) {
    const dealerHidden = table.status === 'playing';
    const visibleDealer = dealerHidden && table.dealerHand.length ? table.dealerHand.slice(0, 1) : table.dealerHand;
    return {
      code: table.code,
      status: table.status,
      turnIdx: table.turnIdx,
      dealer: visibleDealer,
      dealerHasHiddenCard: dealerHidden && table.dealerHand.length > 1,
      dealerValue: dealerHidden ? null : bjTable.handValue(table.dealerHand),
      seats: table.seats.map(s => ({
        nickname: s.nickname,
        avatar: s.avatar,
        connected: s.connected,
        pendingBet: s.pendingBet,
        inRound: s.inRound,
        hand: s.hand,
        handValue: s.hand.length ? bjTable.handValue(s.hand) : 0,
        done: s.done,
        result: s.result
      }))
    };
  }
}

module.exports = { BlackjackTableManager, MAX_SEATS, MIN_SEATS_TO_START };
