// Persistent per-player accuracy stats (correct/incorrect answer counts),
// used by the team balancer. Identity is simply the nickname (lowercased) --
// deliberate simplification for a no-login casual friend-group app. This is
// documented in README.md.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const FILE = path.join(__dirname, '..', '..', 'data', 'players.json');
const BUBBLE_MAX_LEVEL = 200; // "Бульбашки" -- dima: "загалом було 200 рівнів"

let cache = null;

function load() {
  if (cache === null) {
    cache = readJson(FILE, {});
  }
  return cache;
}

function save() {
  writeJsonAtomic(FILE, cache);
}

function keyOf(nickname) {
  return String(nickname || '').trim().toLowerCase();
}

function getOrCreatePlayer(nickname) {
  const data = load();
  const key = keyOf(nickname);
  if (!data[key]) {
    data[key] = {
      nickname: String(nickname).trim(),
      correct: 0,
      incorrect: 0,
      gamesPlayed: 0,
      lastSeen: new Date().toISOString(),
      // "Особистий кабінет" fields (2026-07-21 expansion) -- avatar now lives
      // here (server truth, follows the nickname across devices) instead of
      // only in the browser's localStorage; kkoin is the new site-wide
      // currency, awarded by roomManager on a quiz win (see config.KKOIN_WIN_POOL).
      avatar: null,
      kkoin: 0,
      // "Як отримати більше коінів" expansion (2026-07-21): own persistent
      // level in the Бульбашки mini-game, and a forward-looking inventory for
      // future Казино lootbox winnings -- see bubbleRoutes/profileRoutes and
      // profile.html's "Речі на вивід" panel.
      bubbleLevel: 1,
      items: []
    };
    save();
  } else {
    backfillProfileFields(data[key]);
  }
  return data[key];
}

/**
 * Profiles created before the 2026-07-21 "Бульбашки"/"Речі на вивід"
 * expansion won't have these fields on disk yet -- fill them in the first
 * time such an older profile is touched, rather than a one-off migration
 * script, so nothing special has to run on deploy.
 */
function backfillProfileFields(profile) {
  let changed = false;
  if (typeof profile.bubbleLevel !== 'number' || profile.bubbleLevel < 1) { profile.bubbleLevel = 1; changed = true; }
  if (!Array.isArray(profile.items)) { profile.items = []; changed = true; }
  if (changed) save();
  return profile;
}

function recordAnswer(nickname, wasCorrect) {
  const data = load();
  const key = keyOf(nickname);
  if (!data[key]) getOrCreatePlayer(nickname);
  if (wasCorrect) data[key].correct += 1;
  else data[key].incorrect += 1;
  data[key].lastSeen = new Date().toISOString();
  save();
  return data[key];
}

function markPlayed(nicknames) {
  const data = load();
  for (const nickname of nicknames) {
    const key = keyOf(nickname);
    if (!data[key]) getOrCreatePlayer(nickname);
    data[key].gamesPlayed += 1;
  }
  save();
}

function getAllPlayers() {
  const data = load();
  return Object.values(data);
}

function getStatsFor(nicknames) {
  const data = load();
  return nicknames.map(n => data[keyOf(n)] || getOrCreatePlayer(n));
}

/**
 * Used by admin answer-override: move a player's tally from one bucket to
 * the other when a grading mistake is corrected after the fact.
 */
function adjustAnswer(nickname, fromCorrect, toCorrect) {
  const data = load();
  const key = keyOf(nickname);
  if (!data[key]) getOrCreatePlayer(nickname);
  if (fromCorrect === toCorrect) return data[key];
  if (fromCorrect) data[key].correct = Math.max(0, data[key].correct - 1);
  else data[key].incorrect = Math.max(0, data[key].incorrect - 1);
  if (toCorrect) data[key].correct += 1;
  else data[key].incorrect += 1;
  save();
  return data[key];
}

/**
 * Full "Особистий кабінет" profile -- lifetime stats + avatar + kkoin.
 * getOrCreatePlayer() already returns this same object, but a distinct
 * name here reads better at the profile-route call site than reusing the
 * "get or create" verb for what's conceptually a read.
 */
function getProfile(nickname) {
  return getOrCreatePlayer(nickname);
}

/**
 * avatar: a data:image/... URL (see roomManager.normalizeAvatar for the
 * same size/format validation used at room-join time) or null to clear.
 */
function setAvatar(nickname, avatar) {
  const data = load();
  const key = keyOf(nickname);
  if (!data[key]) getOrCreatePlayer(nickname);
  data[key].avatar = avatar || null;
  save();
  return data[key];
}

/**
 * Changes the nickname itself -- which, since identity IS the lowercased
 * nickname (see file header), means migrating the whole profile record to a
 * new key rather than just editing a field. Rejects if the new nickname is
 * already someone else's (case-insensitive) -- but a same-key case-only
 * change (e.g. "dima" -> "Dima") is allowed and just updates display casing.
 */
function renameNickname(oldNickname, newNickname) {
  const trimmed = String(newNickname || '').trim().slice(0, 24);
  if (!trimmed) return { error: 'Введіть нікнейм' };
  const data = load();
  const oldKey = keyOf(oldNickname);
  const newKey = keyOf(trimmed);
  if (!data[oldKey]) getOrCreatePlayer(oldNickname);
  if (newKey !== oldKey && data[newKey]) {
    return { error: 'Цей нікнейм вже зайнято' };
  }
  const profile = { ...data[oldKey], nickname: trimmed };
  if (newKey !== oldKey) {
    delete data[oldKey];
  }
  data[newKey] = profile;
  save();
  return { profile };
}

/**
 * Awards (or, with a negative amount, spends -- used later by Казино/mini-
 * games) kkoin. Clamped at 0 so a spend can never push a balance negative;
 * callers that need "can they afford this" should check the balance BEFORE
 * calling, this is just the floor of last resort.
 */
function addKkoin(nickname, amount) {
  const data = load();
  const key = keyOf(nickname);
  if (!data[key]) getOrCreatePlayer(nickname);
  const n = Number(amount) || 0;
  data[key].kkoin = Math.max(0, (data[key].kkoin || 0) + n);
  save();
  return data[key];
}

/**
 * Records a cleared Бульбашки level: awards `rewardAmount` KKoin and bumps
 * the player's persistent level by one, but only if `clearedLevel` matches
 * what the server has on file for them right now. That check exists purely
 * so a stale/duplicate "I cleared level N" request (e.g. a double-submit
 * from a flaky connection, or someone replaying an old request) can't award
 * coins twice or skip the player ahead -- it is NOT trying to defend against
 * a determined cheater editing their own client, which is out of scope for
 * a casual friend-group app (same trust level as everything else here).
 */
function advanceBubbleLevel(nickname, clearedLevel, rewardAmount) {
  const data = load();
  const key = keyOf(nickname);
  if (!data[key]) getOrCreatePlayer(nickname);
  const profile = data[key];
  backfillProfileFields(profile);
  const clearedLevelNum = Number(clearedLevel);
  if (!Number.isInteger(clearedLevelNum) || clearedLevelNum !== profile.bubbleLevel) {
    return { error: 'Рівень не збігається з поточним прогресом', profile };
  }
  // 200 is the last level (2026-07-21, dima: "загалом було 200 рівнів") --
  // once there, re-clearing it just keeps paying out KKoin forever rather
  // than trying to advance past a level that doesn't exist.
  profile.bubbleLevel = Math.min(profile.bubbleLevel + 1, BUBBLE_MAX_LEVEL);
  profile.kkoin = Math.max(0, (profile.kkoin || 0) + (Number(rewardAmount) || 0));
  save();
  return { profile, awarded: Number(rewardAmount) || 0 };
}

module.exports = {
  getOrCreatePlayer, recordAnswer, markPlayed, getAllPlayers, getStatsFor, keyOf, adjustAnswer,
  getProfile, setAvatar, renameNickname, addKkoin, advanceBubbleLevel
};
