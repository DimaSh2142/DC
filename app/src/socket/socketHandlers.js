// Socket.IO wiring: real-time room join, gameplay, and admin control.
//
// Security note: admin-only actions are gated by `socket.isAdmin`, which is
// only set to true after a socket sends `admin:authenticate` with a token
// that adminAuth.isValid() accepts (issued at POST /api/admin/login after
// checking the real password). Players cannot reach privileged actions by
// emitting the raw event names directly -- every admin handler re-checks
// `socket.isAdmin` server-side on every call, it is not just hidden in the
// UI. This satisfies "players can't reach admin functions even via API".
//
// Public vs. admin state: roomManager.publicState() is what players see;
// roomManager.adminState() is a superset that additionally exposes the
// correct answer/accepted variants for every question in the round (not
// just the active one) and is used ONLY for the 'admin:room_state' event,
// which is only ever emitted to the 'admin-'+code room. A player socket can
// never join that room (nothing in this file joins a non-admin socket to
// it), so this is a real boundary, not just "the client doesn't render it".
// Every place below that used to broadcast the exact same publicState()
// object to both the player room AND the admin room has been split into two
// separate calls with two different payloads -- see broadcastPublicState()/
// broadcastAdminState() helpers just below.

const themeState = require('../state/themeState');
const playersStore = require('../state/playersStore');

function safe(handler) {
  return async function (...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      await handler(...args);
    } catch (err) {
      console.error('[socket] handler error:', err);
      if (cb) cb({ error: 'Внутрішня помилка сервера' });
    }
  };
}

function requireAdmin(socket, cb) {
  if (!socket.isAdmin) {
    if (cb) cb({ error: 'Потрібна авторизація адміністратора' });
    return false;
  }
  return true;
}

function registerSocketHandlers(io, { roomManager, adminAuth }) {
  // Players (and any admin socket that happens to also be joined to the
  // room, e.g. the admin who created it) get the answer-free view.
  function broadcastPublicState(room) {
    io.to(room.code).emit('room:state', roomManager.publicState(room));
  }
  // Admin-only, richer view (timers already live on publicState's
  // activeQuestion.msRemaining; this adds the full per-question answer key).
  // Always call this AFTER broadcastPublicState() for the same room so that,
  // for an admin socket joined to both channels, the richer payload is the
  // last one applied client-side.
  function broadcastAdminState(room) {
    io.to('admin-' + room.code).emit('admin:room_state', roomManager.adminState(room));
  }

  // dima's point 7: only that team's own members should get the update --
  // targets each member's individual socket by the id already tracked on
  // room.players (server-side truth), no separate join/leave group needed
  // (unlike voice chat, there's no signaling handshake here, just state).
  function broadcastTeamMusic(room, teamId, state) {
    const payload = { code: room.code, teamId, state };
    for (const p of room.players.values()) {
      if (p.teamId === teamId && p.socketId) io.to(p.socketId).emit('team_music:state', payload);
    }
  }

  // ---------- VOICE CHAT signaling state (team-scoped mesh WebRTC) ----------
  // Deliberately NOT using socket.io's built-in room adapter for the actual
  // isolation guarantee (that's just used for the join-your-own-id emit
  // trick below) -- voiceGroups is our own explicit bookkeeping so the
  // "can these two sockets hear each other" check is one obvious line we
  // control, not something implicit in adapter internals. Key is always
  // `${roomCode}:${teamId}`, and teamId always comes from the AUTHORITATIVE
  // server-side roomManager assignment (never trusted from the client), so
  // a socket can only ever be placed in the voice group for the team it is
  // actually on -- this is the "structural isolation" dima asked for, not
  // just a client-side convention.
  const voiceGroups = new Map(); // `${roomCode}:${teamId}` -> Set<socketId>
  const socketMeta = new Map();  // socketId -> { nickname }

  function voiceLeaveInternal(socket) {
    const groupKey = socket.data.voiceGroupKey;
    if (!groupKey) return;
    const group = voiceGroups.get(groupKey);
    if (group) {
      group.delete(socket.id);
      for (const id of group) io.to(id).emit('voice:peer-left', { socketId: socket.id });
      if (group.size === 0) voiceGroups.delete(groupKey);
    }
    socket.data.voiceGroupKey = null;
  }

  io.on('connection', (socket) => {
    socket.data.nickname = null;
    socket.data.roomCode = null;
    socket.data.voiceGroupKey = null;
    // Real Socket.IO already auto-joins every socket to a room named after
    // its own id; this call is a harmless no-op there. It's what lets the
    // zero-dependency test harness (scripts/fakeSocketHarness.js) support
    // the same `io.to(someSocketId).emit(...)` targeted-delivery pattern
    // used below for voice:offer/answer/ice, so the signaling relay logic
    // can be exercised by the existing socket-level integration test too.
    socket.join(socket.id);

    // ---------- ADMIN AUTH HANDSHAKE ----------
    socket.on('admin:authenticate', safe(async (payload, cb) => {
      const token = payload && payload.token;
      if (adminAuth.isValid(token)) {
        socket.isAdmin = true;
        if (cb) cb({ ok: true });
      } else {
        socket.isAdmin = false;
        if (cb) cb({ error: 'Недійсний токен' });
      }
    }));

    // ---------- ADMIN ACTIONS ----------
    socket.on('admin:create_room', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.createRoom();
      socket.join(room.code);
      socket.join('admin-' + room.code);
      if (cb) cb({ room: roomManager.adminState(room) });
      io.to('admin-lobby').emit('admin:rooms_changed');
    }));

    socket.on('admin:watch_room', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      socket.join(room.code);
      socket.join('admin-' + room.code);
      if (cb) cb({ room: roomManager.adminState(room) });
    }));

    socket.on('admin:watch_lobby', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      socket.join('admin-lobby');
      const rooms = roomManager.listRooms().map(r => roomManager.adminState(r));
      if (cb) cb({ rooms });
    }));

    socket.on('admin:list_rooms', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const rooms = roomManager.listRooms().map(r => roomManager.adminState(r));
      if (cb) cb({ rooms });
    }));

    socket.on('admin:generate_board', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const result = roomManager.generateBoard(room, {
        numRounds: payload.numRounds,
        themesPerRound: payload.themesPerRound
      });
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true, reusedCount: result.reusedCount, bankStats: themeState.getBankStats(), room: roomManager.adminState(room) });
    }));

    socket.on('admin:assign_teams', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const result = roomManager.assignTeamsSnake(room, payload.numTeams);
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      io.to(room.code).emit('teams:rebalanced', { teams: room.teams });
      if (cb) cb({ ok: true, teams: result.teams });
    }));

    socket.on('admin:rename_team', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      roomManager.renameTeam(room, payload.teamId, payload.name);
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true });
    }));

    // Manual host override for team assignment (dima: "щоб я їх сам міг
    // перекидати по командам також!") -- on top of the balanced snake draft
    // above. Same lobby-only restriction as admin:assign_teams, enforced
    // server-side in roomManager.movePlayerToTeam (not just hidden in the UI).
    socket.on('admin:move_player_to_team', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const result = roomManager.movePlayerToTeam(room, payload.nicknameKey, payload.teamId);
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true, teams: result.teams });
    }));

    socket.on('admin:start_game', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const result = roomManager.startGame(room);
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      io.to(room.code).emit('game:started', { activeTeamId: roomManager.getActiveTeamId(room) });
      if (cb) cb({ ok: true });
    }));

    socket.on('admin:override_answer', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const result = roomManager.adminOverrideAnswer(room, !!payload.correct);
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      io.to(room.code).emit('answer:corrected', { corrected: result.corrected });
      if (cb) cb({ ok: true });
    }));

    // Host ("ведучий") free-form scoring tools -- see roomManager.adjustTeamScore
    // / adjustPlayerScore doc comments for the team-vs-personal design note.
    socket.on('admin:adjust_team_score', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const result = roomManager.adjustTeamScore(room, payload.teamId, payload.delta);
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true, team: result.team });
    }));

    socket.on('admin:adjust_player_score', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const result = roomManager.adjustPlayerScore(room, payload.nicknameKey, payload.delta);
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true, player: result.player });
    }));

    socket.on('admin:force_resolve_stuck', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      if (!room.activeQuestion) return cb && cb({ error: 'Немає відкритого питання' });
      const result = roomManager.resolveTimeout(room);
      io.to(room.code).emit('answer:resolved', result);
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true });
    }));

    socket.on('admin:kick_player', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      roomManager.kickPlayer(room, payload.nicknameKey);
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true });
    }));

    socket.on('admin:end_game', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      const room = roomManager.getRoom(payload.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      room.status = 'finished';
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true });
    }));

    socket.on('admin:bank_stats', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      if (cb) cb({ stats: themeState.getBankStats() });
    }));

    socket.on('admin:reset_used_themes', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      themeState.resetUsedThemes();
      if (cb) cb({ ok: true, stats: themeState.getBankStats() });
    }));

    socket.on('admin:player_stats', safe(async (payload, cb) => {
      if (!requireAdmin(socket, cb)) return;
      if (cb) cb({ players: playersStore.getAllPlayers() });
    }));

    // ---------- PLAYER ACTIONS ----------
    socket.on('player:join', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const roomCode = (payload && payload.roomCode || '').trim().toUpperCase();
      const avatar = payload && payload.avatar; // optional data: URL, see roomManager.normalizeAvatar
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const room = roomManager.getRoom(roomCode);
      if (!room) return cb && cb({ error: 'Кімнату з таким кодом не знайдено' });

      const result = roomManager.joinPlayer(room, nickname, socket.id, avatar);
      if (result.error) return cb && cb({ error: result.error });

      socket.data.nickname = nickname;
      socket.data.roomCode = room.code;
      socketMeta.set(socket.id, { nickname });
      socket.join(room.code);

      const state = roomManager.publicState(room);
      // avatarRejected is a soft signal (join itself is never blocked by a bad
      // avatar) -- the client uses it to toast "photo didn't apply" instead
      // of silently pretending the upload worked.
      if (cb) cb({ ok: true, room: state, you: result.player, avatarRejected: result.avatarRejected });
      socket.to(room.code).emit('room:state', state);
      broadcastAdminState(room);
    }));

    // Lets a player change (or clear) their own avatar later, e.g. a "change
    // photo" link in the lobby, not just at initial join. nicknameKey is
    // derived from the socket's OWN joined session -- never a client-supplied
    // target -- so a player can only ever touch their own avatar.
    socket.on('player:set_avatar', safe(async (payload, cb) => {
      if (!socket.data.roomCode || !socket.data.nickname) return cb && cb({ error: 'Спочатку приєднайтесь до кімнати' });
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const key = playersStore.keyOf(socket.data.nickname);
      const result = roomManager.setPlayerAvatar(room, key, payload && payload.avatar);
      if (result.error) return cb && cb({ error: result.error });
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true });
    }));

    socket.on('player:pick_question', safe(async (payload, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Ви не в кімнаті' });
      const player = room.players.get(playersStore.keyOf(socket.data.nickname));
      if (!player) return cb && cb({ error: 'Гравця не знайдено в кімнаті' });

      const opened = roomManager.pickQuestion(room, player.teamId, payload.themeId, payload.price, (r) => {
        const timeoutResult = roomManager.resolveTimeout(r);
        if (timeoutResult) {
          io.to(r.code).emit('answer:resolved', timeoutResult);
          broadcastPublicState(r);
          broadcastAdminState(r);
        }
      });
      if (opened.error) return cb && cb({ error: opened.error });

      io.to(room.code).emit('question:opened', opened);
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true });
    }));

    socket.on('player:submit_answer', safe(async (payload, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Ви не в кімнаті' });
      const result = roomManager.submitAnswer(room, socket.data.nickname, payload);
      if (result.error) return cb && cb({ error: result.error });

      io.to(room.code).emit('answer:resolved', result);
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true });
    }));

    // dima's point 5: active team spends 50% of the question's price (from
    // their own team score) to buy 15 extra answer-clock seconds. teamId
    // comes from the caller's OWN roster entry, never the client payload --
    // same server-is-truth pattern as pick_question/voice:join, so a player
    // can never spend a hint funded by a team they aren't on.
    socket.on('player:use_hint', safe(async (payload, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Ви не в кімнаті' });
      const player = room.players.get(playersStore.keyOf(socket.data.nickname));
      if (!player || !player.teamId) return cb && cb({ error: 'Спочатку маєте бути в команді' });

      const result = roomManager.useHint(room, player.teamId, payload.themeId, payload.price);
      if (result.error) return cb && cb({ error: result.error });

      io.to(room.code).emit('hint:used', {
        code: room.code, teamId: player.teamId, themeId: payload.themeId, price: payload.price,
        cost: result.cost, extraMs: result.extraMs, msRemaining: result.msRemaining, totalMs: result.totalMs
      });
      broadcastPublicState(room);
      broadcastAdminState(room);
      if (cb) cb({ ok: true, cost: result.cost });
    }));

    // ---------- TEAM MUSIC (dima's point 7: synced across a team's separate
    // devices, "команда чула музику навіть якщо грають на відстані") ----------
    // teamId always comes from the caller's own roster entry, never the
    // client payload -- same isolation guarantee as voice chat, just without
    // a signaling handshake since this is plain shared state, not P2P audio.
    socket.on('player:team_music_play', safe(async (payload, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Ви не в кімнаті' });
      const player = room.players.get(playersStore.keyOf(socket.data.nickname));
      if (!player || !player.teamId) return cb && cb({ error: 'Спочатку маєте бути в команді' });
      const videoId = ((payload && payload.videoId) || '').trim();
      if (!videoId) return cb && cb({ error: 'Не вдалося розпізнати посилання YouTube' });

      const result = roomManager.setTeamMusic(room, player.teamId, {
        videoId, isPlaying: true, positionSec: (payload && payload.positionSec) || 0
      });
      if (result.error) return cb && cb({ error: result.error });
      broadcastTeamMusic(room, player.teamId, result.state);
      if (cb) cb({ ok: true });
    }));

    socket.on('player:team_music_pause', safe(async (payload, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Ви не в кімнаті' });
      const player = room.players.get(playersStore.keyOf(socket.data.nickname));
      if (!player || !player.teamId) return cb && cb({ error: 'Спочатку маєте бути в команді' });
      const current = room.teamMusic[player.teamId];
      if (!current || !current.videoId) return cb && cb({ error: 'Немає активного треку' });

      const result = roomManager.setTeamMusic(room, player.teamId, {
        videoId: current.videoId, isPlaying: false, positionSec: (payload && payload.positionSec) || 0
      });
      if (result.error) return cb && cb({ error: result.error });
      broadcastTeamMusic(room, player.teamId, result.state);
      if (cb) cb({ ok: true });
    }));

    socket.on('player:team_music_stop', safe(async (payload, cb) => {
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Ви не в кімнаті' });
      const player = room.players.get(playersStore.keyOf(socket.data.nickname));
      if (!player || !player.teamId) return cb && cb({ error: 'Спочатку маєте бути в команді' });

      roomManager.clearTeamMusic(room, player.teamId);
      broadcastTeamMusic(room, player.teamId, null);
      if (cb) cb({ ok: true });
    }));

    // ---------- VOICE CHAT (team-scoped mesh WebRTC signaling) ----------
    // Mesh topology: each client opens one RTCPeerConnection per teammate
    // directly (audio only flows peer-to-peer after signaling, media never
    // touches this server). STUN-only (stun.l.google.com:19302, no
    // registration needed) -- see README/PROGRESS for the documented TURN
    // limitation (some strict NATs/corporate networks may fail to connect;
    // acceptable for a friend-group LAN/home-internet party game).
    socket.on('voice:join', safe(async (payload, cb) => {
      if (!socket.data.roomCode || !socket.data.nickname) return cb && cb({ error: 'Спочатку приєднайтесь до кімнати' });
      const room = roomManager.getRoom(socket.data.roomCode);
      if (!room) return cb && cb({ error: 'Кімнату не знайдено' });
      const player = room.players.get(playersStore.keyOf(socket.data.nickname));
      // teamId is read from the server's own roster, never from the client
      // payload -- this is the actual isolation guarantee, not just a UI nicety.
      if (!player || !player.teamId) return cb && cb({ error: 'Спочатку маєте бути в команді, щоб приєднатись до голосового чату' });

      voiceLeaveInternal(socket); // in case of a stale/previous group (defensive, see syncVoiceTeam on the client)
      const groupKey = room.code + ':' + player.teamId;
      if (!voiceGroups.has(groupKey)) voiceGroups.set(groupKey, new Set());
      const group = voiceGroups.get(groupKey);
      const existingPeers = Array.from(group).map(id => ({ socketId: id, nickname: (socketMeta.get(id) || {}).nickname || '?' }));
      group.add(socket.id);
      socket.data.voiceGroupKey = groupKey;

      if (cb) cb({ ok: true, peers: existingPeers });
      for (const peer of existingPeers) {
        io.to(peer.socketId).emit('voice:peer-joined', { socketId: socket.id, nickname: player.nickname });
      }
    }));

    socket.on('voice:leave', safe(async (payload, cb) => {
      voiceLeaveInternal(socket);
      if (cb) cb({ ok: true });
    }));

    function relayVoiceSignal(eventName) {
      return safe(async (payload, cb) => {
        const groupKey = socket.data.voiceGroupKey;
        if (!groupKey) return cb && cb({ error: 'Ви не в голосовому чаті' });
        const group = voiceGroups.get(groupKey);
        const targetId = payload && payload.to;
        if (!group || !group.has(socket.id) || !targetId || !group.has(targetId)) {
          return cb && cb({ error: 'Цей учасник не у вашій голосовій групі команди' });
        }
        const relayPayload = { from: socket.id };
        if (payload.sdp) relayPayload.sdp = payload.sdp;
        if (payload.candidate) relayPayload.candidate = payload.candidate;
        io.to(targetId).emit(eventName, relayPayload);
        if (cb) cb({ ok: true });
      });
    }
    socket.on('voice:offer', relayVoiceSignal('voice:offer'));
    socket.on('voice:answer', relayVoiceSignal('voice:answer'));
    socket.on('voice:ice', relayVoiceSignal('voice:ice'));

    socket.on('disconnect', () => {
      voiceLeaveInternal(socket);
      socketMeta.delete(socket.id);
      if (socket.data.roomCode) {
        const room = roomManager.getRoom(socket.data.roomCode);
        if (room) {
          roomManager.disconnectSocket(room, socket.id);
          broadcastPublicState(room);
          broadcastAdminState(room);
        }
      }
    });
  });
}

module.exports = { registerSocketHandlers };
