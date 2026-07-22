// Socket.IO wiring for the 3 mini-games (Battleship/Checkers/Chess). Mirrors
// the conventions in src/socket/socketHandlers.js (the quiz's handler file)
// -- same safe() error-wrapping, same socket.data-carries-session-identity
// pattern -- but events are namespaced with an "mg:" prefix and everything
// funnels through src/state/miniGameManager.js + the per-game pure-logic
// modules in src/games/, so this file itself contains almost no game rules.
//
// Redaction note: Battleship has hidden information (you must not see your
// opponent's unsunk ships), so every broadcast here emits to EACH player's
// own socket individually with miniGameManager.publicState(room, playerIdx)
// -- never a single io.to(room.code).emit() of one shared object. For
// checkers/chess this is a harmless no-op (getPublicView ignores viewerIdx),
// but keeping ONE code path for all three games is simpler than special-
// casing "this game needs per-player views, that one doesn't".

const playersStore = require('../state/playersStore');

function safe(handler) {
  return async function (...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      await handler(...args);
    } catch (err) {
      console.error('[minigame-socket] handler error:', err);
      if (cb) cb({ error: 'Внутрішня помилка сервера' });
    }
  };
}

function registerMiniGameHandlers(io, { miniGameManager }) {
  function broadcastRoomState(room) {
    room.players.forEach((player, idx) => {
      io.to(player.socketId).emit('mg:room_state', miniGameManager.publicState(room, idx));
    });
  }

  io.on('connection', (socket) => {
    socket.data.mgRoomCode = null;
    socket.data.mgNickname = null;

    socket.on('mg:create_room', safe(async (payload, cb) => {
      const gameType = payload && payload.gameType;
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const avatar = payload && payload.avatar;
      const stake = payload && payload.stake;
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = miniGameManager.createRoom(gameType, nickname, socket.id, avatar, stake);
      if (result.error) return cb && cb({ error: result.error });

      socket.data.mgRoomCode = result.room.code;
      socket.data.mgNickname = nickname;
      socket.join('mg-' + result.room.code);
      if (cb) cb({ ok: true, room: miniGameManager.publicState(result.room, 0), playerIdx: 0 });
    }));

    socket.on('mg:join_room', safe(async (payload, cb) => {
      const gameType = payload && payload.gameType;
      const roomCode = (payload && payload.roomCode || '').trim().toUpperCase();
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const avatar = payload && payload.avatar;
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = miniGameManager.joinRoom(roomCode, gameType, nickname, socket.id, avatar);
      if (result.error) return cb && cb({ error: result.error });

      socket.data.mgRoomCode = result.room.code;
      socket.data.mgNickname = nickname;
      socket.join('mg-' + result.room.code);
      if (cb) cb({ ok: true, room: miniGameManager.publicState(result.room, result.playerIdx), playerIdx: result.playerIdx });
      broadcastRoomState(result.room);
    }));

    // Re-attach an already-open browser tab after a refresh/reconnect --
    // same nickname-is-the-key idea as player:join in socketHandlers.js.
    socket.on('mg:reconnect', safe(async (payload, cb) => {
      const gameType = payload && payload.gameType;
      const roomCode = (payload && payload.roomCode || '').trim().toUpperCase();
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const room = miniGameManager.getRoom(roomCode);
      if (!room || room.gameType !== gameType) return cb && cb({ error: 'Кімнату не знайдено' });
      const idx = miniGameManager.playerIdxOf(room, playersStore.keyOf(nickname));
      if (idx === -1) return cb && cb({ error: 'Вас немає в цій кімнаті' });
      const result = miniGameManager.joinRoom(roomCode, gameType, nickname, socket.id, null);
      if (result.error) return cb && cb({ error: result.error });
      socket.data.mgRoomCode = room.code;
      socket.data.mgNickname = nickname;
      socket.join('mg-' + room.code);
      if (cb) cb({ ok: true, room: miniGameManager.publicState(room, result.playerIdx), playerIdx: result.playerIdx });
      broadcastRoomState(room);
    }));

    function currentRoomAndIdx(socket) {
      const room = miniGameManager.getRoom(socket.data.mgRoomCode);
      if (!room) return {};
      const idx = miniGameManager.playerIdxOf(room, playersStore.keyOf(socket.data.mgNickname));
      return { room, idx };
    }

    // ---------- Battleship ----------
    socket.on('mg:battleship_submit_layout', safe(async (payload, cb) => {
      const { room, idx } = currentRoomAndIdx(socket);
      if (!room || idx === -1 || idx === undefined) return cb && cb({ error: 'Ви не в кімнаті' });
      if (room.gameType !== 'battleship') return cb && cb({ error: 'Невірний тип гри' });
      const battleship = miniGameManager.module(room);
      const result = battleship.submitLayout(room.gameState, idx, payload && payload.placements);
      if (result.error) return cb && cb({ error: result.error });
      miniGameManager.applyModuleResult(room, result);
      broadcastRoomState(room);
      if (cb) cb({ ok: true });
    }));

    socket.on('mg:battleship_fire', safe(async (payload, cb) => {
      const { room, idx } = currentRoomAndIdx(socket);
      if (!room || idx === -1 || idx === undefined) return cb && cb({ error: 'Ви не в кімнаті' });
      if (room.gameType !== 'battleship') return cb && cb({ error: 'Невірний тип гри' });
      const battleship = miniGameManager.module(room);
      const x = payload && payload.x, y = payload && payload.y;
      const result = battleship.fireShot(room.gameState, idx, x, y);
      if (result.error) return cb && cb({ error: result.error });
      miniGameManager.applyModuleResult(room, result);
      broadcastRoomState(room);
      if (cb) cb({ ok: true, hit: result.hit, sunk: result.sunk, gameOver: result.gameOver });
    }));

    // ---------- Checkers ----------
    socket.on('mg:checkers_move', safe(async (payload, cb) => {
      const { room, idx } = currentRoomAndIdx(socket);
      if (!room || idx === -1 || idx === undefined) return cb && cb({ error: 'Ви не в кімнаті' });
      if (room.gameType !== 'checkers') return cb && cb({ error: 'Невірний тип гри' });
      const checkers = miniGameManager.module(room);
      const result = checkers.applyMove(room.gameState, idx, payload && payload.from, payload && payload.to);
      if (result.error) return cb && cb({ error: result.error });
      miniGameManager.applyModuleResult(room, result);
      broadcastRoomState(room);
      // continueJump matters to the client: a mandatory multi-jump keeps the
      // SAME piece selected client-side so the forced follow-up jump is
      // immediately highlighted, instead of the player having to re-click it.
      if (cb) cb({ ok: true, captured: result.captured, promoted: result.promoted, continueJump: result.continueJump });
    }));

    // ---------- Chess ----------
    socket.on('mg:chess_move', safe(async (payload, cb) => {
      const { room, idx } = currentRoomAndIdx(socket);
      if (!room || idx === -1 || idx === undefined) return cb && cb({ error: 'Ви не в кімнаті' });
      if (room.gameType !== 'chess') return cb && cb({ error: 'Невірний тип гри' });
      const chess = miniGameManager.module(room);
      const result = chess.applyMove(room.gameState, idx, payload && payload.from, payload && payload.to, payload && payload.promotion);
      if (result.error) return cb && cb({ error: result.error });
      miniGameManager.applyModuleResult(room, result);
      broadcastRoomState(room);
      if (cb) cb({ ok: true, captured: result.captured });
    }));

    // ---------- Tic-Tac-Toe ----------
    socket.on('mg:tictactoe_move', safe(async (payload, cb) => {
      const { room, idx } = currentRoomAndIdx(socket);
      if (!room || idx === -1 || idx === undefined) return cb && cb({ error: 'Ви не в кімнаті' });
      if (room.gameType !== 'tictactoe') return cb && cb({ error: 'Невірний тип гри' });
      const tictactoe = miniGameManager.module(room);
      const result = tictactoe.applyMove(room.gameState, idx, payload && payload.index);
      if (result.error) return cb && cb({ error: result.error });
      miniGameManager.applyModuleResult(room, result);
      broadcastRoomState(room);
      if (cb) cb({ ok: true });
    }));

    // ---------- shared ----------
    socket.on('mg:resign', safe(async (payload, cb) => {
      const { room, idx } = currentRoomAndIdx(socket);
      if (!room || idx === -1 || idx === undefined) return cb && cb({ error: 'Ви не в кімнаті' });
      const result = miniGameManager.resign(room, idx);
      if (result.error) return cb && cb({ error: result.error });
      broadcastRoomState(room);
      if (cb) cb({ ok: true });
    }));

    // dima 2026-07-22: "Грати знову" на екрані фіналу -- будь-який з двох
    // гравців може запросити рематч, спрацьовує одразу (без окремого
    // підтвердження другого гравця, як і решта цього trust-based додатку).
    socket.on('mg:rematch', safe(async (payload, cb) => {
      const { room, idx } = currentRoomAndIdx(socket);
      if (!room || idx === -1 || idx === undefined) return cb && cb({ error: 'Ви не в кімнаті' });
      const result = miniGameManager.rematch(room);
      if (result.error) return cb && cb({ error: result.error });
      broadcastRoomState(room);
      if (cb) cb({ ok: true });
    }));

    socket.on('disconnect', () => {
      miniGameManager.disconnectSocket(socket.id);
      if (socket.data.mgRoomCode) {
        const room = miniGameManager.getRoom(socket.data.mgRoomCode);
        if (room) broadcastRoomState(room);
      }
    });
  });
}

module.exports = { registerMiniGameHandlers };
