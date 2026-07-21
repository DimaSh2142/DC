// Generic 2-player room lifecycle shared by all three mini-games
// (Battleship/Checkers/Chess). Deliberately separate from src/state/
// roomManager.js -- that class is the team-quiz engine (teams, turn-order,
// rounds, boards) and none of that applies here: a mini-game room is just
// "two nicknames, an opaque game-specific state blob, and a winner". Each
// concrete game's actual rules live in src/games/<name>.js as pure
// functions; this file only owns room/player bookkeeping and delegates all
// "what does a move mean" questions to whichever module matches
// room.gameType (see GAME_MODULES below).
//
// Same nickname-is-the-key identity as the rest of the app (see
// playersStore.js) -- no separate mini-game account system, and a
// disconnect/reconnect just re-attaches the same nickname to its seat
// (playerIdx 0 or 1) rather than losing the game.

const playersStore = require('./playersStore');
const battleship = require('../games/battleship');
const checkers = require('../games/checkers');
const chess = require('../games/chess');

const GAME_MODULES = { battleship, checkers, chess };
const GAME_LABELS = { battleship: 'Морський бій', checkers: 'Шашки', chess: 'Шахи' };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, same as roomManager.js
function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

class MiniGameRoom {
  constructor(code, gameType) {
    this.code = code;
    this.gameType = gameType;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.status = 'waiting'; // waiting (1 player seated) | playing | finished
    this.players = []; // [{ key, nickname, avatar, socketId, connected }] -- array index IS playerIdx (0 or 1)
    this.gameState = null; // opaque, owned entirely by GAME_MODULES[gameType]
    this.resignedIdx = null; // set if a player explicitly resigned (still funnels through "finished" + winnerIdx from the game state where applicable)
  }
}

class MiniGameManager {
  constructor() {
    this.rooms = new Map();
  }

  isValidGameType(gameType) { return Object.prototype.hasOwnProperty.call(GAME_MODULES, gameType); }
  gameLabel(gameType) { return GAME_LABELS[gameType] || gameType; }

  createRoom(gameType, nickname, socketId, avatar) {
    if (!this.isValidGameType(gameType)) return { error: 'Невідомий тип гри' };
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    playersStore.getOrCreatePlayer(nickname);
    let code;
    do { code = randomCode(4); } while (this.rooms.has(code));
    const room = new MiniGameRoom(code, gameType);
    room.players.push({ key, nickname: String(nickname).trim(), avatar: avatar || null, socketId, connected: true });
    this.rooms.set(code, room);
    return { room };
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase());
  }

  deleteRoom(code) {
    this.rooms.delete(String(code || '').trim().toUpperCase());
  }

  cleanupStale(maxAgeMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const anyConnected = room.players.some(p => p.connected);
      if (!anyConnected && now - room.updatedAt > maxAgeMs) this.deleteRoom(code);
    }
  }

  joinRoom(code, gameType, nickname, socketId, avatar) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Кімнату не знайдено' };
    if (room.gameType !== gameType) return { error: 'Це кімната для іншої гри (' + this.gameLabel(room.gameType) + ')' };
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    room.updatedAt = Date.now();

    const existing = room.players.find(p => p.key === key);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      if (avatar) existing.avatar = avatar;
      return { room, player: existing, playerIdx: room.players.indexOf(existing), reconnect: true };
    }
    if (room.players.length >= 2) return { error: 'Кімната вже заповнена (2/2 гравці)' };

    const player = { key, nickname: String(nickname).trim(), avatar: avatar || null, socketId, connected: true };
    room.players.push(player);
    const playerIdx = room.players.length - 1;

    if (room.players.length === 2 && room.status === 'waiting') {
      room.status = 'playing';
      room.gameState = GAME_MODULES[room.gameType].createInitialState();
    }
    return { room, player, playerIdx, reconnect: false };
  }

  playerIdxOf(room, nicknameKey) {
    return room.players.findIndex(p => p.key === nicknameKey);
  }

  disconnectSocket(socketId) {
    for (const room of this.rooms.values()) {
      const player = room.players.find(p => p.socketId === socketId);
      if (player) { player.connected = false; room.updatedAt = Date.now(); }
    }
  }

  // Explicit forfeit -- simplest possible way to end a game that's gone
  // stale (opponent AFK) without needing per-game "give up" logic; the
  // OTHER seated player is declared the winner regardless of game type.
  resign(room, playerIdx) {
    if (room.status !== 'playing') return { error: 'Гра не триває' };
    room.status = 'finished';
    room.resignedIdx = playerIdx;
    if (room.gameState) room.gameState.winnerIdx = 1 - playerIdx;
    room.updatedAt = Date.now();
    return { ok: true, winnerIdx: 1 - playerIdx };
  }

  applyModuleResult(room, result) {
    room.updatedAt = Date.now();
    if (room.gameState && room.gameState.winnerIdx !== null && room.gameState.winnerIdx !== undefined) {
      room.status = 'finished';
    }
    // Chess draws never set winnerIdx (nobody won) -- surface that as
    // "finished" too via drawReason, same idea as roomManager's own
    // status==='finished' meaning "nothing more to play here".
    if (room.gameState && room.gameState.drawReason) {
      room.status = 'finished';
    }
    return result;
  }

  module(room) { return GAME_MODULES[room.gameType]; }

  // Per-viewer sanitized snapshot. viewerPlayerIdx may be null (a pure
  // spectator/no-session case never happens in this app's UI, but stay
  // defensive) -- games with no hidden info (checkers/chess) ignore it.
  publicState(room, viewerPlayerIdx) {
    const mod = this.module(room);
    return {
      code: room.code,
      gameType: room.gameType,
      gameLabel: this.gameLabel(room.gameType),
      status: room.status,
      resignedIdx: room.resignedIdx,
      players: room.players.map(p => ({ nickname: p.nickname, avatar: p.avatar, connected: p.connected })),
      myPlayerIdx: viewerPlayerIdx,
      gameState: room.gameState ? mod.getPublicView(room.gameState, viewerPlayerIdx) : null
    };
  }
}

module.exports = { MiniGameManager, GAME_MODULES, GAME_LABELS };
