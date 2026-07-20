// Persistent per-player accuracy stats (correct/incorrect answer counts),
// used by the team balancer. Identity is simply the nickname (lowercased) --
// deliberate simplification for a no-login casual friend-group app. This is
// documented in README.md.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const FILE = path.join(__dirname, '..', '..', 'data', 'players.json');

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
      lastSeen: new Date().toISOString()
    };
    save();
  }
  return data[key];
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

module.exports = { getOrCreatePlayer, recordAnswer, markPlayed, getAllPlayers, getStatsFor, keyOf, adjustAnswer };
