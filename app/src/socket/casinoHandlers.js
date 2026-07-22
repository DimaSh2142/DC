// Socket wiring for casino games. Blackjack has TWO modes sharing this one
// file: solo vs-the-house (blackjackManager, original 2026-07-22 build --
// this half is untouched) and the shared multiplayer TABLE (blackjackTableManager,
// added same day per dima's "грати з іншими учасниками" ask). Namespaced
// "casino:" the same way mini-games use "mg:". The solo events stay
// single-socket request/response (no broadcast, see their own comments
// below); the table events DO need a broadcast, same idea as
// miniGameHandlers.js's broadcastRoomState, but simpler -- see
// blackjackTableManager.publicState's header comment for why one shared
// object (not one-per-socket) is enough here.

const playersStore = require('../state/playersStore');

function safe(handler) {
  return async function (...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      await handler(...args);
    } catch (err) {
      console.error('[casino-socket] handler error:', err);
      if (cb) cb({ error: 'Внутрішня помилка сервера' });
    }
  };
}

function registerCasinoHandlers(io, { blackjackManager, blackjackTableManager, rouletteTableManager, plinkoManager }) {
  function broadcastTable(table) {
    io.to('bjt-' + table.code).emit('casino:table_state', blackjackTableManager.publicState(table));
  }
  function broadcastRoulette(table) {
    io.to('rt-' + table.code).emit('casino:roulette_state', rouletteTableManager.publicState(table));
  }

  io.on('connection', (socket) => {
    socket.data.bjTableCode = null;
    socket.data.bjNickname = null;

    // ---------- Blackjack: shared multiplayer table ----------
    socket.on('casino:table_create', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const avatar = payload && payload.avatar;
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackTableManager.createTable(nickname, socket.id, avatar);
      if (result.error) return cb && cb({ error: result.error });
      socket.data.bjTableCode = result.table.code;
      socket.data.bjNickname = nickname;
      socket.join('bjt-' + result.table.code);
      if (cb) cb({ ok: true, table: blackjackTableManager.publicState(result.table) });
    }));

    socket.on('casino:table_join', safe(async (payload, cb) => {
      const roomCode = (payload && payload.roomCode || '').trim().toUpperCase();
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const avatar = payload && payload.avatar;
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackTableManager.joinTable(roomCode, nickname, socket.id, avatar);
      if (result.error) return cb && cb({ error: result.error });
      socket.data.bjTableCode = result.table.code;
      socket.data.bjNickname = nickname;
      socket.join('bjt-' + result.table.code);
      if (cb) cb({ ok: true, table: blackjackTableManager.publicState(result.table) });
      broadcastTable(result.table);
    }));

    // Re-attach after a refresh -- same idea as mg:reconnect.
    socket.on('casino:table_reconnect', safe(async (payload, cb) => {
      const roomCode = (payload && payload.roomCode || '').trim().toUpperCase();
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const table = blackjackTableManager.getTable(roomCode);
      if (!table) return cb && cb({ error: 'Стіл не знайдено' });
      if (blackjackTableManager.seatIdxOf(table, playersStore.keyOf(nickname)) === -1) return cb && cb({ error: 'Вас немає за цим столом' });
      const result = blackjackTableManager.joinTable(roomCode, nickname, socket.id, null);
      if (result.error) return cb && cb({ error: result.error });
      socket.data.bjTableCode = table.code;
      socket.data.bjNickname = nickname;
      socket.join('bjt-' + table.code);
      if (cb) cb({ ok: true, table: blackjackTableManager.publicState(table) });
      broadcastTable(table);
    }));

    function currentTable(socket) {
      return socket.data.bjTableCode ? blackjackTableManager.getTable(socket.data.bjTableCode) : null;
    }

    socket.on('casino:table_leave', safe(async (payload, cb) => {
      const table = currentTable(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = blackjackTableManager.leaveTable(table.code, socket.data.bjNickname);
      if (result.error) return cb && cb({ error: result.error });
      socket.leave('bjt-' + table.code);
      socket.data.bjTableCode = null;
      if (result.table) broadcastTable(result.table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:table_bet', safe(async (payload, cb) => {
      const table = currentTable(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = blackjackTableManager.placeBet(table.code, socket.data.bjNickname, payload && payload.stake);
      if (result.error) return cb && cb({ error: result.error });
      broadcastTable(table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:table_start', safe(async (payload, cb) => {
      const table = currentTable(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = blackjackTableManager.startRound(table.code, socket.data.bjNickname);
      if (result.error) return cb && cb({ error: result.error });
      broadcastTable(table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:table_hit', safe(async (payload, cb) => {
      const table = currentTable(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = blackjackTableManager.hit(table.code, socket.data.bjNickname);
      if (result.error) return cb && cb({ error: result.error });
      broadcastTable(table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:table_stand', safe(async (payload, cb) => {
      const table = currentTable(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = blackjackTableManager.stand(table.code, socket.data.bjNickname);
      if (result.error) return cb && cb({ error: result.error });
      broadcastTable(table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:table_new_round', safe(async (payload, cb) => {
      const table = currentTable(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = blackjackTableManager.newRound(table.code, socket.data.bjNickname);
      if (result.error) return cb && cb({ error: result.error });
      broadcastTable(table);
      if (cb) cb({ ok: true });
    }));

    // ---------- Roulette: shared multiplayer table ----------
    socket.data.rtTableCode = null;
    socket.data.rtNickname = null;

    socket.on('casino:roulette_create', safe(async (payload, cb) => {
      const rNickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const avatar = payload && payload.avatar;
      if (!rNickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = rouletteTableManager.createTable(rNickname, socket.id, avatar);
      if (result.error) return cb && cb({ error: result.error });
      socket.data.rtTableCode = result.table.code;
      socket.data.rtNickname = rNickname;
      socket.join('rt-' + result.table.code);
      if (cb) cb({ ok: true, table: rouletteTableManager.publicState(result.table) });
    }));

    socket.on('casino:roulette_join', safe(async (payload, cb) => {
      const roomCode = (payload && payload.roomCode || '').trim().toUpperCase();
      const rNickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const avatar = payload && payload.avatar;
      if (!rNickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = rouletteTableManager.joinTable(roomCode, rNickname, socket.id, avatar);
      if (result.error) return cb && cb({ error: result.error });
      socket.data.rtTableCode = result.table.code;
      socket.data.rtNickname = rNickname;
      socket.join('rt-' + result.table.code);
      if (cb) cb({ ok: true, table: rouletteTableManager.publicState(result.table) });
      broadcastRoulette(result.table);
    }));

    socket.on('casino:roulette_reconnect', safe(async (payload, cb) => {
      const roomCode = (payload && payload.roomCode || '').trim().toUpperCase();
      const rNickname = (payload && payload.nickname || '').trim().slice(0, 24);
      if (!rNickname) return cb && cb({ error: 'Введіть нікнейм' });
      const table = rouletteTableManager.getTable(roomCode);
      if (!table) return cb && cb({ error: 'Стіл не знайдено' });
      if (rouletteTableManager.seatIdxOf(table, playersStore.keyOf(rNickname)) === -1) return cb && cb({ error: 'Вас немає за цим столом' });
      const result = rouletteTableManager.joinTable(roomCode, rNickname, socket.id, null);
      if (result.error) return cb && cb({ error: result.error });
      socket.data.rtTableCode = table.code;
      socket.data.rtNickname = rNickname;
      socket.join('rt-' + table.code);
      if (cb) cb({ ok: true, table: rouletteTableManager.publicState(table) });
      broadcastRoulette(table);
    }));

    function currentRoulette(socket) {
      return socket.data.rtTableCode ? rouletteTableManager.getTable(socket.data.rtTableCode) : null;
    }

    socket.on('casino:roulette_leave', safe(async (payload, cb) => {
      const table = currentRoulette(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = rouletteTableManager.leaveTable(table.code, socket.data.rtNickname);
      if (result.error) return cb && cb({ error: result.error });
      socket.leave('rt-' + table.code);
      socket.data.rtTableCode = null;
      if (result.table) broadcastRoulette(result.table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:roulette_bet', safe(async (payload, cb) => {
      const table = currentRoulette(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = rouletteTableManager.placeBets(table.code, socket.data.rtNickname, payload && payload.bets);
      if (result.error) return cb && cb({ error: result.error });
      broadcastRoulette(table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:roulette_spin', safe(async (payload, cb) => {
      const table = currentRoulette(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = rouletteTableManager.spin(table.code, socket.data.rtNickname);
      if (result.error) return cb && cb({ error: result.error });
      broadcastRoulette(table);
      if (cb) cb({ ok: true });
    }));

    socket.on('casino:roulette_new_round', safe(async (payload, cb) => {
      const table = currentRoulette(socket);
      if (!table) return cb && cb({ error: 'Ви не за столом' });
      const result = rouletteTableManager.newRound(table.code, socket.data.rtNickname);
      if (result.error) return cb && cb({ error: result.error });
      broadcastRoulette(table);
      if (cb) cb({ ok: true });
    }));

    socket.on('disconnect', () => {
      blackjackTableManager.disconnectSocket(socket.id);
      const table = currentTable(socket);
      if (table) broadcastTable(table);
      rouletteTableManager.disconnectSocket(socket.id);
      const rTable = currentRoulette(socket);
      if (rTable) broadcastRoulette(rTable);
    });

    // ---------- Blackjack: solo vs the house (unchanged since first ship) ----------
    socket.on('casino:blackjack_deal', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const stake = payload && payload.stake;
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackManager.deal(nickname, stake);
      if (result.error) return cb && cb({ error: result.error });
      if (cb) cb({ ok: true, view: result.view });
    }));

    socket.on('casino:blackjack_hit', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackManager.hit(nickname);
      if (result.error) return cb && cb({ error: result.error });
      if (cb) cb({ ok: true, view: result.view });
    }));

    socket.on('casino:blackjack_stand', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackManager.stand(nickname);
      if (result.error) return cb && cb({ error: result.error });
      if (cb) cb({ ok: true, view: result.view });
    }));

    // Used on page load/refresh to resume an in-progress hand (mirrors the
    // mini-games' mg:reconnect idea, just much simpler -- there's no seat/
    // room to re-attach to, only "is there a hand for this nickname").
    socket.on('casino:blackjack_state', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const view = nickname ? blackjackManager.currentView(nickname) : null;
      if (cb) cb({ ok: true, view });
    }));

    // ---------- Plinko: solo, stateless request/response (no room at all) ----------
    socket.on('casino:plinko_drop', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const stake = payload && payload.stake;
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = plinkoManager.drop(nickname, stake);
      if (result.error) return cb && cb({ error: result.error });
      if (cb) cb(result);
    }));
  });
}

module.exports = { registerCasinoHandlers };
