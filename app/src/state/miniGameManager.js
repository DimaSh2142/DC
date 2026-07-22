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
const tictactoe = require('../games/tictactoe'); // 2026-07-22: 4th mini-game, mirrors checkers.js's module shape exactly -- see that file's own header comment

const GAME_MODULES = { battleship, checkers, chess, tictactoe };
const GAME_LABELS = { battleship: 'Морський бій', checkers: 'Шашки', chess: 'Шахи', tictactoe: 'Хрестики-нулики' };

// Optional-require + try/catch guard, same pattern as blackjackTableManager.js
// /rouletteTableManager.js/plinkoManager.js -- 2026-07-22 cabinet rebuild
// wiring real data into ActivityFeed/ActivityChart for the 4 mini-games too
// (previously only the casino table games logged here).
let activityStore = null;
try { activityStore = require('./activityStore'); } catch (e) { /* optional, see logActivity() below */ }
function logActivity(nickname, entry) {
  if (!activityStore) return;
  try { activityStore.logActivity(nickname, entry); } catch (e) { /* best-effort only */ }
}

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
    // dima 2026-07-22 "якщо я хочу зіграти на гроші (KKoins)" -- optional bet,
    // set once at room creation and never changed for that room's lifetime
    // (a rematch re-uses the same amount, see rematch() below). 0 means "not
    // a staked room" everywhere in this file. stakeSettled guards against
    // ever paying out (or refunding) the same room's pot twice.
    this.stake = 0;
    this.stakeSettled = false;
  }
}

class MiniGameManager {
  constructor() {
    this.rooms = new Map();
  }

  isValidGameType(gameType) { return Object.prototype.hasOwnProperty.call(GAME_MODULES, gameType); }
  gameLabel(gameType) { return GAME_LABELS[gameType] || gameType; }

  createRoom(gameType, nickname, socketId, avatar, stake) {
    if (!this.isValidGameType(gameType)) return { error: 'Невідомий тип гри' };
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    const profile = playersStore.getOrCreatePlayer(nickname);
    // dima 2026-07-22 "якщо я хочу зіграти на гроші (KKoins) чому я ніде не
    // можу це поставити" -- the creator picks the stake once, up front;
    // whoever joins later must match it (see joinRoom below). Floor+clamp so
    // a negative/fractional/garbage value from the client can never sneak
    // through as a "stake".
    const stakeAmt = Math.max(0, Math.floor(Number(stake) || 0));
    if (stakeAmt > 0 && (profile.kkoin || 0) < stakeAmt) {
      return { error: 'Недостатньо KKoin для такої ставки (у вас ' + (profile.kkoin || 0) + ')' };
    }
    let code;
    do { code = randomCode(4); } while (this.rooms.has(code));
    const room = new MiniGameRoom(code, gameType);
    room.stake = stakeAmt;
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

    // A staked room (room.stake set by the creator, see createRoom above)
    // requires the joiner to affort the same amount BEFORE they take the
    // second seat -- reject the join outright rather than seating them and
    // discovering the shortfall only once the game is about to start. The
    // creator's own balance was already checked when they created the room.
    if (room.stake > 0) {
      const joinerProfile = playersStore.getOrCreatePlayer(nickname);
      if ((joinerProfile.kkoin || 0) < room.stake) {
        return { error: 'Потрібно ' + room.stake + ' KKoin для цієї ставки (у вас ' + (joinerProfile.kkoin || 0) + ')' };
      }
    }

    const player = { key, nickname: String(nickname).trim(), avatar: avatar || null, socketId, connected: true };
    room.players.push(player);
    const playerIdx = room.players.length - 1;

    if (room.players.length === 2 && room.status === 'waiting') {
      room.status = 'playing';
      room.gameState = GAME_MODULES[room.gameType].createInitialState();
      // Both balances were already verified affordable (creator above at
      // createRoom-time, joiner just above) -- the actual deduction only
      // ever happens here, at the instant the room genuinely starts, so a
      // room nobody ever joins never touches anyone's KKoin.
      if (room.stake > 0) {
        room.players.forEach(p => playersStore.addKkoin(p.nickname, -room.stake));
      }
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
    this.settleStakes(room);
    this.logGameFinish(room);
    return { ok: true, winnerIdx: 1 - playerIdx };
  }

  // Real activity-feed entry for both seated players the instant a mini-game
  // room finishes (win/loss/draw/resign) -- 2026-07-22 cabinet rebuild, same
  // "win only true on an outright win" accent convention blackjackTableManager
  // already established for Казино · Блекджек (стіл) (a push/draw there is
  // deliberately win:false too, i.e. dimmer, not a loss-red but not a bright
  // win either).
  logGameFinish(room) {
    if (!room.gameState || room.players.length < 2) return;
    const label = 'Міні-ігри · ' + this.gameLabel(room.gameType);
    const winnerIdx = room.gameState.winnerIdx;
    const isDraw = winnerIdx !== 0 && winnerIdx !== 1;
    room.players.forEach((p, idx) => {
      const won = !isDraw && idx === winnerIdx;
      let detail;
      if (isDraw) {
        detail = 'Нічия' + (room.stake > 0 ? ' · ставку повернено' : '');
      } else if (won) {
        detail = (room.resignedIdx === (1 - idx) ? 'Перемога (суперник здався)' : 'Перемога') + (room.stake > 0 ? (' · +' + room.stake + ' KKoin') : '');
      } else {
        detail = (room.resignedIdx === idx ? 'Ви здалися' : 'Поразка') + (room.stake > 0 ? (' · -' + room.stake + ' KKoin') : '');
      }
      logActivity(p.nickname, { label, detail, accent: won ? '#00FFD1' : (isDraw ? '#666666' : '#C71585'), win: won });
    });
  }

  // Pays out a staked room's pot the instant it becomes "finished" -- the
  // winner gets both stakes back (their own + the loser's), or on a draw
  // each player just gets their own stake back. Guarded by stakeSettled so
  // this can safely be called from every "just became finished" call site
  // (resign, applyModuleResult) without ever double-paying if both happened
  // to fire for the same room (they can't in practice, but cheap to guard).
  settleStakes(room) {
    if (room.stake <= 0 || room.stakeSettled) return;
    room.stakeSettled = true;
    const winnerIdx = room.gameState && room.gameState.winnerIdx;
    if (winnerIdx === 0 || winnerIdx === 1) {
      const winner = room.players[winnerIdx];
      if (winner) playersStore.addKkoin(winner.nickname, room.stake * 2);
    } else {
      // draw (chess stalemate/etc, drawReason set but no winnerIdx) -- nobody
      // profits, both simply get their own stake back.
      room.players.forEach(p => playersStore.addKkoin(p.nickname, room.stake));
    }
  }

  // dima 2026-07-22 "чому після гри я не можу запустити нову" -- рематч у
  // ТІЙ САМІЙ кімнаті (той самий код, ті самі 2 гравці) замість змушувати
  // когось заново створювати кімнату й ділитись кодом. room.players.reverse()
  // навмисно тут: воно міняє місцями playerIdx 0<->1 (хто ходить першим/грає
  // білими), щоб рематчі чесно чергувались, а не завжди той самий гравець
  // мав перевагу першого ходу. Обидва гравці мають бути на місці (2/2) --
  // інакше після дисконекту суперника "рематч" підвісив би room у
  // status:'playing' без опонента.
  rematch(room) {
    if (room.status !== 'finished') return { error: 'Гра ще не завершена' };
    if (room.players.length < 2) return { error: 'Суперник ще не приєднався' };
    // A staked room re-stakes the SAME amount for the rematch -- both
    // players must still be able to afford it (their balances moved since
    // the last game: the winner just got paid, the loser just paid out), so
    // re-check and re-deduct BEFORE touching any room state, and bail
    // cleanly (finished room untouched) if either can't cover it anymore.
    if (room.stake > 0) {
      const short = room.players.find(p => (playersStore.getOrCreatePlayer(p.nickname).kkoin || 0) < room.stake);
      if (short) return { error: short.nickname + ' не має достатньо KKoin для рематчу на ту ж ставку (' + room.stake + ')' };
      room.players.forEach(p => playersStore.addKkoin(p.nickname, -room.stake));
    }
    room.players.reverse();
    room.status = 'playing';
    room.resignedIdx = null;
    room.stakeSettled = false;
    room.gameState = GAME_MODULES[room.gameType].createInitialState();
    room.updatedAt = Date.now();
    return { ok: true };
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
    if (room.status === 'finished') { this.settleStakes(room); this.logGameFinish(room); }
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
      stake: room.stake,
      players: room.players.map(p => ({ nickname: p.nickname, avatar: p.avatar, connected: p.connected })),
      myPlayerIdx: viewerPlayerIdx,
      gameState: room.gameState ? mod.getPublicView(room.gameState, viewerPlayerIdx) : null
    };
  }
}

module.exports = { MiniGameManager, GAME_MODULES, GAME_LABELS };
