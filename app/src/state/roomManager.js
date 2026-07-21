// In-memory room/game state manager: the core round-robin team quiz engine.
// Rooms live in memory only (not persisted to disk) -- they're ephemeral
// game sessions; player accuracy stats (which DO need to survive restarts)
// live in playersStore/data/players.json instead.

const config = require('../config');
const themeState = require('./themeState');
const playersStore = require('./playersStore');
const { snakeAssignTeams } = require('../logic/teamBalancer');
const { checkTextAnswer, checkSelectAnswer } = require('../logic/answerMatcher');

const TEAM_COLOR_BASES = ['turquoise', 'crimson', 'orange'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity when read aloud

// Up to 3 teams get the 3 base hues. Teams 4-6 (needed for the 14-player /
// up-to-6-team case) reuse the same 3 hues but in their -dark shade -- still
// strictly inside the 4-color palette (documented shade exception in
// README "Про 4-колірну палітру"), just distinguishable from the first 3.
function colorForTeamIndex(idx) {
  const base = TEAM_COLOR_BASES[idx % TEAM_COLOR_BASES.length];
  const cycle = Math.floor(idx / TEAM_COLOR_BASES.length);
  return cycle === 0 ? base : base + '-dark';
}

// Small per-room avatar: a client-compressed image (square JPEG/PNG/WebP --
// see player.js readAndResizeImage) sent as a data: URL. Capped well under
// Socket.IO's default 1MB message size so a broadcast can never balloon --
// 60,000 base64 chars is roughly a 44KB image, plenty for a 96x96 thumbnail
// at reasonable JPEG quality. Deliberately NOT persisted to players.json
// (that file is cross-game accuracy stats, not room-session cosmetics) --
// lives only on the in-memory player object for the room's lifetime.
const MAX_AVATAR_DATA_URL_LENGTH = 60000;
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/;
function normalizeAvatar(avatar) {
  if (typeof avatar !== 'string') return null;
  if (avatar.length > MAX_AVATAR_DATA_URL_LENGTH) return null;
  if (!AVATAR_DATA_URL_RE.test(avatar)) return null;
  return avatar;
}

function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

class Room {
  constructor(code) {
    this.code = code;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.status = 'lobby'; // lobby | in_progress | finished
    this.players = new Map(); // key(nicknameLower) -> {nickname, key, socketId, teamId, connected}
    this.teams = []; // [{id, name, color, score, memberKeys:[]}]
    this.rounds = []; // [{ name, themes: [{id,name,category,questions:[{price,type,clue,accepted?,correctOptionId?,display,used}]}] }]
    this.currentRoundIndex = 0;
    this.turnOrder = [];
    this.currentTurnPos = 0;
    this.activeQuestion = null; // { themeId, price, openedAt, locked, timer }
    this.lastResolvedAnswer = null; // for admin override grace window
    this.teamMusic = {}; // teamId -> { videoId, isPlaying, positionSec, updatedAt } | null -- see setTeamMusic()
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom() {
    let code;
    do { code = randomCode(4); } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase());
  }

  listRooms() {
    return Array.from(this.rooms.values());
  }

  deleteRoom(code) {
    const room = this.getRoom(code);
    if (room && room.activeQuestion && room.activeQuestion.timer) clearTimeout(room.activeQuestion.timer);
    this.rooms.delete(String(code || '').trim().toUpperCase());
  }

  /** Garbage-collect rooms with nobody connected for a long while. */
  cleanupStale(maxAgeMs = 6 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const anyConnected = Array.from(room.players.values()).some(p => p.connected);
      if (!anyConnected && now - room.updatedAt > maxAgeMs) {
        this.deleteRoom(code);
      }
    }
  }

  // ---- players ----

  joinPlayer(room, nickname, socketId, avatar) {
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    playersStore.getOrCreatePlayer(nickname); // ensure persistent record exists
    const existing = room.players.get(key);
    room.updatedAt = Date.now();
    const normalizedAvatar = normalizeAvatar(avatar);
    const avatarRejected = !!(avatar && !normalizedAvatar);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      // Only overwrite on an actual new avatar -- a bare reconnect re-sends
      // just {nickname, roomCode} with no avatar (see player.js `connect`
      // handler), and that must NOT silently wipe a previously-set photo.
      if (normalizedAvatar) existing.avatar = normalizedAvatar;
      return { player: existing, reconnect: true, avatarRejected };
    }
    const player = { nickname: String(nickname).trim(), key, socketId, teamId: null, connected: true, personalScore: 0, avatar: normalizedAvatar };
    room.players.set(key, player);
    return { player, reconnect: false, avatarRejected };
  }

  disconnectSocket(room, socketId) {
    for (const player of room.players.values()) {
      if (player.socketId === socketId) {
        player.connected = false;
        room.updatedAt = Date.now();
        return player;
      }
    }
    return null;
  }

  kickPlayer(room, nicknameKey) {
    room.players.delete(nicknameKey);
    for (const team of room.teams) {
      team.memberKeys = team.memberKeys.filter(k => k !== nicknameKey);
    }
  }

  // ---- teams ----

  assignTeamsSnake(room, numTeams) {
    if (room.status === 'in_progress') {
      return { error: 'Гра вже триває -- спочатку завершіть її, щоб не обнулити рахунок і не зламати чергу ходів' };
    }
    const roster = Array.from(room.players.values());
    if (roster.length === 0) return { error: 'У кімнаті ще немає гравців' };
    const k = Math.max(2, Math.min(numTeams || config.DEFAULT_NUM_TEAMS, roster.length));
    const statsList = playersStore.getStatsFor(roster.map(p => p.nickname));
    const byKey = new Map(statsList.map(s => [playersStore.keyOf(s.nickname), s]));
    const playersForBalancer = roster.map(p => ({
      nickname: p.nickname,
      key: p.key,
      correct: (byKey.get(p.key) || {}).correct || 0,
      incorrect: (byKey.get(p.key) || {}).incorrect || 0
    }));
    const grouped = snakeAssignTeams(playersForBalancer, k);

    room.teams = grouped.map((members, idx) => ({
      id: 'team' + idx,
      name: 'Команда ' + (idx + 1),
      color: colorForTeamIndex(idx),
      score: 0,
      memberKeys: members.map(m => m.key)
    }));
    for (const team of room.teams) {
      for (const memberKey of team.memberKeys) {
        const player = room.players.get(memberKey);
        if (player) player.teamId = team.id;
      }
    }
    room.updatedAt = Date.now();
    return { teams: room.teams };
  }

  renameTeam(room, teamId, name) {
    const team = room.teams.find(t => t.id === teamId);
    if (team && name && name.trim()) team.name = name.trim().slice(0, 40);
  }

  /**
   * Manual host override for team assignment, on top of the balanced
   * assignTeamsSnake() draft -- dima wants to be able to hand-move a
   * specific player (e.g. two friends who want to be on the same team)
   * without re-running/undoing the whole balanced draft. Same mid-game
   * restriction as assignTeamsSnake(): only allowed in the lobby, since
   * moving a player once turnOrder/scores exist could orphan the turn
   * queue or double-count someone mid-question.
   */
  movePlayerToTeam(room, nicknameKey, teamId) {
    if (room.status !== 'lobby') {
      return { error: 'Перекидати гравців можна лише в лобі (до початку гри)' };
    }
    const player = room.players.get(nicknameKey);
    if (!player) return { error: 'Гравця не знайдено' };
    const team = room.teams.find(t => t.id === teamId);
    if (!team) return { error: 'Команду не знайдено' };
    for (const t of room.teams) {
      t.memberKeys = t.memberKeys.filter(k => k !== nicknameKey);
    }
    team.memberKeys.push(nicknameKey);
    player.teamId = team.id;
    room.updatedAt = Date.now();
    return { ok: true, teams: room.teams };
  }

  /**
   * Host ("ведучий") free-form score correction -- an arbitrary +/- applied
   * to a team's score at any moment, independent of the last-answer
   * override (admin:override_answer only flips the single most recent
   * answer). This is the general "SIGame host" power: fix a scoring
   * dispute, hand out a bonus, dock a penalty, at any point in the game
   * (including mid-question or after the game ends), matching how a human
   * host at the table can adjust the board at will.
   */
  adjustTeamScore(room, teamId, delta) {
    const team = room.teams.find(t => t.id === teamId);
    if (!team) return { error: 'Команду не знайдено' };
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0) return { error: 'Вкажіть ненульове число' };
    team.score += n;
    room.updatedAt = Date.now();
    return { team };
  }

  /**
   * Bonus host tool: a lightweight PERSONAL point counter per player,
   * separate from the team score that actually drives the game. dima's
   * request ("змінювати кількість балів кожного з учасників") was
   * ambiguous between team and individual scoring -- team score is the one
   * that resolves questions/wins the game (unchanged, classic SIGame
   * rules), and this personalScore is an extra free-form counter a host can
   * nudge for individual recognition (e.g. "best answer of the round")
   * without touching the real team score. Deliberately NOT persisted to
   * players.json (that file is accuracy stats across games) and NOT used
   * in any win condition -- purely a per-room, in-memory bonus tally.
   * See PROGRESS.md for the full design-decision writeup.
   */
  adjustPlayerScore(room, nicknameKey, delta) {
    const player = room.players.get(nicknameKey);
    if (!player) return { error: 'Гравця не знайдено' };
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0) return { error: 'Вкажіть ненульове число' };
    player.personalScore = (player.personalScore || 0) + n;
    room.updatedAt = Date.now();
    return { player };
  }

  /**
   * Lets a player change (or clear, with avatar=null/undefined) their own
   * avatar after already joining -- e.g. a "change photo" link in the lobby,
   * not just at initial join. Same validation/cap as joinPlayer(). The
   * caller (socketHandlers) MUST derive nicknameKey from the socket's own
   * joined session, never a client-supplied target, so one player can never
   * overwrite someone else's avatar -- same server-side-truth pattern as
   * voice:join's teamId lookup.
   */
  setPlayerAvatar(room, nicknameKey, avatar) {
    const player = room.players.get(nicknameKey);
    if (!player) return { error: 'Гравця не знайдено' };
    if (avatar) {
      const normalized = normalizeAvatar(avatar);
      if (!normalized) return { error: 'Некоректне зображення (PNG/JPEG/WebP, невеликий розмір)' };
      player.avatar = normalized;
    } else {
      player.avatar = null; // explicit clear
    }
    room.updatedAt = Date.now();
    return { player };
  }

  /**
   * dima's point 7: teammates on separate devices ("грають на відстані")
   * should hear the SAME track in sync, not just whoever has the panel open
   * on one shared screen (the earlier local-only design). The server holds
   * one authoritative {videoId, isPlaying, positionSec, updatedAt} per team;
   * every team member's client reconciles its own local YouTube player
   * against this (positionSec + elapsed-since-updatedAt when isPlaying) --
   * see socketHandlers.js's broadcastTeamMusic and player.js's
   * applyTeamMusicState. teamId comes from the caller's own roster entry
   * (never a client-supplied target), same server-is-truth pattern as
   * voice:join/useHint, so a player can only ever drive their OWN team's music.
   */
  setTeamMusic(room, teamId, { videoId, isPlaying, positionSec }) {
    const team = room.teams.find(t => t.id === teamId);
    if (!team) return { error: 'Команду не знайдено' };
    const state = {
      videoId: videoId || null,
      isPlaying: !!isPlaying,
      positionSec: Math.max(0, Number(positionSec) || 0),
      updatedAt: Date.now()
    };
    room.teamMusic[teamId] = state;
    room.updatedAt = Date.now();
    return { state };
  }

  clearTeamMusic(room, teamId) {
    room.teamMusic[teamId] = null;
    room.updatedAt = Date.now();
    return { ok: true };
  }

  // ---- board / rounds ----

  generateBoard(room, { numRounds, themesPerRound } = {}) {
    if (room.status === 'in_progress') {
      return { error: 'Гра вже триває -- дошку не можна перегенерувати посеред гри' };
    }
    const rounds = numRounds || config.DEFAULT_NUM_ROUNDS;
    const perRound = themesPerRound || config.DEFAULT_THEMES_PER_ROUND;
    const namePairs = config.ROUND_NAME_PAIRS[Math.floor(Math.random() * config.ROUND_NAME_PAIRS.length)];

    let totalReused = 0;
    const builtRounds = [];
    for (let r = 0; r < rounds; r++) {
      const { themes, reusedCount } = themeState.pickFreshThemes(perRound);
      totalReused += reusedCount;
      const roundThemes = themes.map(t => ({
        id: t.id,
        name: t.name,
        category: t.category,
        questions: t.questions.map(q => ({ ...q, used: false }))
      }));
      builtRounds.push({ name: namePairs[r] || ('Раунд ' + (r + 1)), themes: roundThemes });
    }
    room.rounds = builtRounds;
    room.currentRoundIndex = 0;
    room.updatedAt = Date.now();
    return { rounds: builtRounds, reusedCount: totalReused };
  }

  // ---- gameplay ----

  startGame(room) {
    if (room.teams.length < 2) return { error: 'Потрібно щонайменше 2 команди' };
    if (room.rounds.length === 0) return { error: 'Спочатку згенеруйте теми (адмін-кнопка)' };
    room.turnOrder = room.teams.map(t => t.id);
    for (let i = room.turnOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.turnOrder[i], room.turnOrder[j]] = [room.turnOrder[j], room.turnOrder[i]];
    }
    room.currentTurnPos = 0;
    room.status = 'in_progress';
    room.currentRoundIndex = 0;
    room.updatedAt = Date.now();
    const nicknames = Array.from(room.players.values()).map(p => p.nickname);
    playersStore.markPlayed(nicknames);
    return { ok: true };
  }

  /**
   * Returns the id of the team whose turn it currently is. Self-heals past
   * teams that have been emptied out mid-game (e.g. their only member was
   * kicked) by skipping forward to the next team that still has members --
   * otherwise the game could deadlock forever waiting on a team nobody can
   * ever act for. Returns null only if literally every team is empty.
   */
  getActiveTeamId(room) {
    if (!room.turnOrder.length) return null;
    for (let i = 0; i < room.turnOrder.length; i++) {
      const idx = (room.currentTurnPos + i) % room.turnOrder.length;
      const teamId = room.turnOrder[idx];
      const team = room.teams.find(t => t.id === teamId);
      if (team && team.memberKeys.length > 0) {
        if (i > 0) room.currentTurnPos = idx; // persist the auto-skip
        return teamId;
      }
    }
    return null;
  }

  getCurrentRound(room) {
    return room.rounds[room.currentRoundIndex] || null;
  }

  findQuestion(room, themeId, price) {
    const round = this.getCurrentRound(room);
    if (!round) return null;
    const theme = round.themes.find(t => t.id === themeId);
    if (!theme) return null;
    const question = theme.questions.find(q => q.price === price);
    if (!question) return null;
    return { theme, question };
  }

  pickQuestion(room, teamId, themeId, price, onTimeout) {
    if (room.status !== 'in_progress') return { error: 'Гра ще не почалась' };
    if (this.getActiveTeamId(room) !== teamId) return { error: 'Зараз не ваш хід' };
    if (room.activeQuestion) return { error: 'Питання вже відкрите' };
    const found = this.findQuestion(room, themeId, price);
    if (!found) return { error: 'Питання не знайдено' };
    if (found.question.used) return { error: 'Це питання вже розігране' };

    const { question, theme } = found;
    const publicClue = { kind: question.clue.kind, text: question.clue.text };
    if (question.clue.kind === 'logo') publicClue.options = question.clue.options;
    // Optional real screenshot/art attached to a text clue (e.g. the
    // "Незвичні ігри" theme, and now the imported real .siq packs) -- must be
    // explicitly forwarded here since this object is a hand-picked whitelist,
    // not a spread of the full clue.
    if (question.clue.imageUrl) publicClue.imageUrl = question.clue.imageUrl;
    if (question.clue.audioUrl) publicClue.audioUrl = question.clue.audioUrl;

    const openedPayload = {
      code: room.code, // lets a client (esp. an admin socket that may be
      // joined to more than one room's channels) verify this event is
      // actually about the room it's currently displaying
      themeId,
      themeName: theme.name,
      price,
      type: question.type,
      clue: publicClue,
      timeoutMs: config.ANSWER_TIMEOUT_MS,
      hintUsed: false // flips to true via useHint() below; kept on the payload so a
      // reconnecting client (which is handed this same object, see publicState())
      // knows the hint button should already be spent for this question.
    };

    const timer = setTimeout(() => onTimeout(room), config.ANSWER_TIMEOUT_MS);
    // openedPayload is kept on activeQuestion (not just returned) so that a
    // player who reconnects/refreshes mid-question -- publicState() below --
    // can be shown the clue immediately instead of just a bare board with no
    // way to answer until the timeout eventually fires. onTimeout/totalMs are
    // also kept here (not just closed over locally) so useHint() can later
    // reschedule the SAME timeout callback against an extended duration.
    room.activeQuestion = { themeId, price, openedAt: Date.now(), locked: false, timer, openedPayload, onTimeout, totalMs: config.ANSWER_TIMEOUT_MS, hintUsed: false };
    room.updatedAt = Date.now();

    return openedPayload;
  }

  /**
   * "Купити підказку у адміна" (dima's point 5): the active team can spend
   * HINT_COST_RATIO of the open question's price out of their OWN team score
   * to buy 15 extra seconds (HINT_EXTRA_MS) on the answer clock -- a
   * lifeline, not a real hint's content (there's no separate hint text in
   * the data model), matching how dima described it: pay points, the game
   * "stops" (extends) for 15s so the team has more time to think/discuss.
   * Capped at once per question via activeQuestion.hintUsed. teamId MUST be
   * derived server-side from the caller's own roster entry (same
   * server-is-truth pattern as pickQuestion/voice:join) so a player can never
   * spend a hint on behalf of a team they're not on.
   */
  useHint(room, teamId, themeId, price) {
    if (room.status !== 'in_progress') return { error: 'Гра ще не почалась' };
    const active = room.activeQuestion;
    if (!active || active.themeId !== themeId || active.price !== price) {
      return { error: 'Це питання вже не активне' };
    }
    if (this.getActiveTeamId(room) !== teamId) return { error: 'Зараз не хід вашої команди' };
    if (active.hintUsed) return { error: 'Підказку для цього питання вже використано' };

    const team = room.teams.find(t => t.id === teamId);
    if (!team) return { error: 'Команду не знайдено' };
    const cost = Math.round(price * config.HINT_COST_RATIO);

    clearTimeout(active.timer);
    const extraMs = config.HINT_EXTRA_MS;
    active.totalMs += extraMs;
    const msRemaining = Math.max(0, active.totalMs - (Date.now() - active.openedAt));
    active.timer = setTimeout(() => active.onTimeout(room), msRemaining);

    team.score -= cost;
    active.hintUsed = true;
    active.openedPayload.hintUsed = true;
    room.updatedAt = Date.now();

    return { cost, extraMs, msRemaining, totalMs: active.totalMs, team };
  }

  /** Shared by both real answers and timeouts. wasCorrect may be computed or forced false. */
  _resolve(room, { nickname, wasCorrect, matchedDisplay, timedOut }) {
    const active = room.activeQuestion;
    const found = this.findQuestion(room, active.themeId, active.price);
    const { theme, question } = found;
    question.used = true;

    const teamId = this.getActiveTeamId(room);
    const team = room.teams.find(t => t.id === teamId);
    const delta = wasCorrect ? active.price : (config.NEGATIVE_ON_WRONG ? -active.price : 0);
    team.score += delta;

    if (!timedOut && nickname) {
      playersStore.recordAnswer(nickname, wasCorrect);
    }

    room.lastResolvedAnswer = {
      themeId: active.themeId,
      price: active.price,
      teamId,
      nickname: nickname || null,
      wasCorrect,
      delta,
      timedOut: !!timedOut,
      resolvedAt: Date.now()
    };

    if (active.timer) clearTimeout(active.timer);
    room.activeQuestion = null;

    // advance turn regardless of correctness (explicit product requirement)
    room.currentTurnPos = (room.currentTurnPos + 1) % room.turnOrder.length;

    const round = this.getCurrentRound(room);
    const roundComplete = round.themes.every(t => t.questions.every(q => q.used));
    let gameComplete = false;
    if (roundComplete) {
      if (room.currentRoundIndex + 1 < room.rounds.length) {
        room.currentRoundIndex += 1;
      } else {
        gameComplete = true;
        room.status = 'finished';
      }
    }
    room.updatedAt = Date.now();

    return {
      code: room.code, // see pickQuestion()'s openedPayload comment -- same reasoning
      themeId: active.themeId,
      themeName: theme.name,
      price: active.price,
      wasCorrect,
      timedOut: !!timedOut,
      correctDisplay: question.display,
      scoringTeamId: teamId,
      delta,
      teams: room.teams,
      nextActiveTeamId: this.getActiveTeamId(room),
      roundComplete,
      gameComplete,
      currentRoundIndex: room.currentRoundIndex
    };
  }

  submitAnswer(room, nickname, payload) {
    if (!room.activeQuestion || room.activeQuestion.locked) return { error: 'Немає активного питання' };
    const player = room.players.get(playersStore.keyOf(nickname));
    if (!player || player.teamId !== this.getActiveTeamId(room)) {
      return { error: 'Зараз відповідає інша команда' };
    }
    room.activeQuestion.locked = true;

    const found = this.findQuestion(room, room.activeQuestion.themeId, room.activeQuestion.price);
    const { question } = found;
    let wasCorrect = false;
    if (question.type === 'text') {
      wasCorrect = checkTextAnswer(payload.text, question.accepted).correct;
    } else if (question.type === 'select') {
      wasCorrect = checkSelectAnswer(payload.optionId, question.correctOptionId).correct;
    }
    return this._resolve(room, { nickname: player.nickname, wasCorrect });
  }

  resolveTimeout(room) {
    if (!room.activeQuestion) return null;
    room.activeQuestion.locked = true;
    return this._resolve(room, { nickname: null, wasCorrect: false, timedOut: true });
  }

  adminOverrideAnswer(room, correct) {
    const last = room.lastResolvedAnswer;
    if (!last) return { error: 'Немає останньої відповіді для корекції' };
    if (last.wasCorrect === correct) return { error: 'Відповідь вже саме така' };

    const team = room.teams.find(t => t.id === last.teamId);
    // Use the question's actual price, not Math.abs(last.delta) -- delta is
    // 0 for a wrong answer when NEGATIVE_ON_WRONG is disabled, which would
    // otherwise make "correct" overrides silently award 0 points.
    const priceAbs = last.price || 0;
    const oldDelta = last.delta;
    const newDelta = correct ? priceAbs : (config.NEGATIVE_ON_WRONG ? -priceAbs : 0);
    team.score += (newDelta - oldDelta);

    if (last.nickname) {
      playersStore.adjustAnswer(last.nickname, last.wasCorrect, correct);
    }
    last.wasCorrect = correct;
    last.delta = newDelta;
    room.updatedAt = Date.now();
    return { teams: room.teams, corrected: last };
  }

  publicState(room) {
    return {
      code: room.code,
      status: room.status,
      players: Array.from(room.players.values()).map(p => ({ nickname: p.nickname, teamId: p.teamId, connected: p.connected, personalScore: p.personalScore || 0, avatar: p.avatar || null })),
      teams: room.teams,
      rounds: room.rounds.map(r => ({
        name: r.name,
        themes: r.themes.map(t => ({
          id: t.id, name: t.name, category: t.category,
          questions: t.questions.map(q => ({ price: q.price, used: q.used }))
        }))
      })),
      currentRoundIndex: room.currentRoundIndex,
      activeTeamId: this.getActiveTeamId(room),
      teamMusic: room.teamMusic || {}, // teamId -> state|null, see setTeamMusic() doc comment
      // Include the full clue (not just themeId/price) so a player who
      // reconnects or refreshes mid-question can be shown the answer panel
      // right away instead of being stuck looking at a plain board until
      // the answer timer eventually times out (see pickQuestion()).
      activeQuestion: room.activeQuestion ? {
        themeId: room.activeQuestion.themeId,
        price: room.activeQuestion.price,
        openedPayload: room.activeQuestion.openedPayload,
        // totalMs grows when useHint() extends the clock, so a reconnecting
        // client sees the correct remaining time instead of the original 45s.
        msRemaining: Math.max(0, (room.activeQuestion.totalMs || config.ANSWER_TIMEOUT_MS) - (Date.now() - room.activeQuestion.openedAt))
      } : null
    };
  }

  /**
   * Host-only view: everything in publicState() PLUS, for every question in
   * the current round (not just the currently-active one), the correct
   * answer (display / accepted text variants / correctOptionId for logo
   * questions) -- so the admin can see answers "зарання" (ahead of time),
   * not just after a question resolves. This must NEVER be sent to a player
   * socket -- socketHandlers.js only broadcasts this to the 'admin-'+code
   * room, which players can never join (see adminAuth/requireAdmin). Keeping
   * this as a fully separate function (rather than a flag on publicState)
   * makes that boundary a single obvious call-site decision instead of a
   * conditional that could accidentally default the wrong way.
   */
  adminState(room) {
    const pub = this.publicState(room);
    return {
      ...pub,
      rounds: room.rounds.map(r => ({
        name: r.name,
        themes: r.themes.map(t => ({
          id: t.id, name: t.name, category: t.category,
          questions: t.questions.map(q => ({
            price: q.price,
            used: q.used,
            type: q.type,
            display: q.display,
            accepted: q.accepted || null,
            correctOptionId: q.correctOptionId || null
          }))
        }))
      }))
    };
  }
}

module.exports = { RoomManager };
