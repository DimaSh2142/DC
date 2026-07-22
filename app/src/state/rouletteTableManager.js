// Multiplayer Roulette TABLE manager -- mirrors blackjackTableManager.js's
// seat/lobby/broadcast shape (see that file's header comment for the full
// reasoning on why this is its own small manager rather than forcing
// roulette through miniGameManager's fixed-2-player room model), but
// simpler: roulette has no turn order at all -- every seated player places
// (or clears) their own bets independently during the 'lobby' window, then
// ANY seated player can trigger the spin once at least one seat has a bet
// down. Unlike Blackjack, a table of exactly 1 betting player is a
// perfectly normal roulette table (there's no opponent to wait for, the
// "shared table" part is purely social -- friends can watch the same spin
// together), so MIN_BETTORS_TO_SPIN is 1, not 2.
//
// Round lifecycle (status field):
//   'lobby'  -- seats join/leave freely, each independently sets their own
//               list of bets for the upcoming spin. Nobody's KKoin moves yet.
//   'result' -- set the instant spin() runs. The winning number is decided
//               HERE, server-side, and only here -- see games/roulette.js's
//               spin() header comment. Stakes are deducted and payouts
//               applied in the same tick (settleSpin), same "pay out the
//               moment a round becomes final" discipline as every other
//               staked game in this app. Any seated player can start a
//               fresh 'lobby' window (newRound) without re-sharing the code.

const playersStore = require('./playersStore');
const roulette = require('../games/roulette');
let activityStore = null;
try { activityStore = require('./activityStore'); } catch (e) { /* optional, see blackjackTableManager.js's identical guard */ }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SEATS = 6;
const MIN_BETTORS_TO_SPIN = 1;

function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

function logActivity(nickname, entry) {
  if (!activityStore) return;
  try { activityStore.logActivity(nickname, entry); } catch (e) { /* best-effort only */ }
}

class RouletteSeat {
  constructor(key, nickname, avatar, socketId) {
    this.key = key;
    this.nickname = nickname;
    this.avatar = avatar || null;
    this.socketId = socketId;
    this.connected = true;
    this.pendingBets = []; // [{ type, number?, amount }] -- set via placeBets, cleared each newRound
    this.lastResult = null; // { totalStaked, totalReturned, net } after a spin, until the next newRound
  }
}

class RouletteTable {
  constructor(code) {
    this.code = code;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.status = 'lobby'; // 'lobby' | 'result'
    this.seats = [];
    this.winningNumber = null;
  }
}

class RouletteTableManager {
  constructor() {
    this.tables = new Map();
  }

  getTable(code) { return this.tables.get(String(code || '').trim().toUpperCase()); }
  deleteTable(code) { this.tables.delete(String(code || '').trim().toUpperCase()); }

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
    const table = new RouletteTable(code);
    table.seats.push(new RouletteSeat(key, String(nickname).trim(), avatar, socketId));
    this.tables.set(code, table);
    return { table, seatIdx: 0 };
  }

  seatIdxOf(table, nicknameKey) { return table.seats.findIndex(s => s.key === nicknameKey); }

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
    const seat = new RouletteSeat(key, String(nickname).trim(), avatar, socketId);
    table.seats.push(seat);
    return { table, seatIdx: table.seats.length - 1, reconnect: false };
  }

  leaveTable(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
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

  // Replaces this seat's whole bet list in one call (the client always
  // sends its full current chip layout, not incremental deltas -- simpler
  // and there's no per-chip identity that needs preserving between sends).
  placeBets(code, nickname, bets) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'lobby') return { error: 'Ставки приймаються лише між спінами' };
    const key = playersStore.keyOf(nickname);
    const seat = table.seats.find(s => s.key === key);
    if (!seat) return { error: 'Вас немає за цим столом' };

    const list = Array.isArray(bets) ? bets : [];
    if (list.length === 0) { seat.pendingBets = []; table.updatedAt = Date.now(); return { ok: true, table }; }
    if (list.length > 20) return { error: 'Забагато ставок за раз (максимум 20)' };
    for (const b of list) {
      if (!roulette.isValidBet(b)) return { error: 'Некоректна ставка' };
    }
    const total = list.reduce((sum, b) => sum + Math.floor(Number(b.amount)), 0);
    const profile = playersStore.getOrCreatePlayer(nickname);
    if ((profile.kkoin || 0) < total) {
      return { error: 'Недостатньо KKoin для таких ставок (потрібно ' + total + ', у вас ' + (profile.kkoin || 0) + ')' };
    }
    seat.pendingBets = list.map(b => ({ type: b.type, number: b.type === 'straight' ? Math.floor(Number(b.number)) : undefined, amount: Math.floor(Number(b.amount)) }));
    table.updatedAt = Date.now();
    return { ok: true, table };
  }

  // Any seated player can spin once someone has money down -- same
  // "whoever's ready clicks it" trust model as blackjackTableManager.startRound.
  spin(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'lobby') return { error: 'Спін вже відбувся -- почніть нову ставку' };
    const key = playersStore.keyOf(nickname);
    if (this.seatIdxOf(table, key) === -1) return { error: 'Вас немає за цим столом' };

    const bettingSeats = table.seats.filter(s => s.pendingBets.length > 0);
    if (bettingSeats.length < MIN_BETTORS_TO_SPIN) return { error: 'Потрібна хоча б одна ставка, щоб крутити колесо' };

    // Re-verify affordability right before touching any balance -- a seat's
    // KKoin could have moved since placeBets (spent elsewhere, topped up).
    const short = bettingSeats.find((s) => {
      const total = s.pendingBets.reduce((sum, b) => sum + b.amount, 0);
      return (playersStore.getOrCreatePlayer(s.nickname).kkoin || 0) < total;
    });
    if (short) return { error: short.nickname + ' більше не має достатньо KKoin для своїх ставок' };

    const winningNumber = roulette.spin(); // THE authoritative outcome -- decided exactly once, right here
    table.winningNumber = winningNumber;

    bettingSeats.forEach((seat) => {
      const totalStaked = seat.pendingBets.reduce((sum, b) => sum + b.amount, 0);
      playersStore.addKkoin(seat.nickname, -totalStaked);
      const { totalReturned, net } = roulette.resolveBets(seat.pendingBets, winningNumber);
      if (totalReturned > 0) playersStore.addKkoin(seat.nickname, totalReturned);
      seat.lastResult = { totalStaked, totalReturned, net, bets: seat.pendingBets };
      logActivity(seat.nickname, {
        label: 'Казино · Рулетка',
        detail: (net >= 0 ? 'Виграш +' : 'Програш ') + (net >= 0 ? net : net) + ' KKoin · випало ' + winningNumber,
        accent: net > 0 ? '#00FFD1' : (net === 0 ? '#666666' : '#C71585'),
        win: net > 0
      });
    });
    table.seats.forEach((s) => { if (!bettingSeats.includes(s)) s.lastResult = null; });
    table.status = 'result';
    table.updatedAt = Date.now();
    return { ok: true, table };
  }

  newRound(code, nickname) {
    const table = this.getTable(code);
    if (!table) return { error: 'Стіл не знайдено' };
    if (table.status !== 'result') return { error: 'Спін ще не відбувся' };
    const key = playersStore.keyOf(nickname);
    if (this.seatIdxOf(table, key) === -1) return { error: 'Вас немає за цим столом' };
    table.seats.forEach((s) => { s.pendingBets = []; s.lastResult = null; });
    table.status = 'lobby';
    table.winningNumber = null;
    table.updatedAt = Date.now();
    return { ok: true, table };
  }

  publicState(table) {
    return {
      code: table.code,
      status: table.status,
      winningNumber: table.winningNumber,
      winningColor: table.winningNumber === null ? null : roulette.colorOf(table.winningNumber),
      seats: table.seats.map(s => ({
        nickname: s.nickname,
        avatar: s.avatar,
        connected: s.connected,
        pendingBets: s.pendingBets,
        pendingTotal: s.pendingBets.reduce((sum, b) => sum + b.amount, 0),
        lastResult: s.lastResult
      }))
    };
  }
}

module.exports = { RouletteTableManager, MAX_SEATS, MIN_BETTORS_TO_SPIN };
