// Per-player activity log -- new 2026-07-22 alongside the Особистий кабінет
// rebuild (see profile.html/profile.js's "ActivityFeed"/"ActivityChart"
// sections). dima's base44 reference (components/cabinet/ActivityFeed.jsx +
// ActivityChart.jsx) hardcodes fake entries/fake weekly numbers -- rather
// than copy fake data into a real app, this is the smallest real feature
// that can honestly back both: a capped, append-only, per-nickname list of
// "something happened" entries, written by whichever manager just settled a
// real result (quiz win payout, any mini-game finishing, any casino game
// settling). Same plain-JSON-atomic-write convention as playersStore.js --
// deliberately NOT folded into players.json itself, since this is an
// unbounded-over-time log rather than a single profile record, and keeping
// it in its own file means a corrupt/huge log can never risk the far more
// important players.json (balances, avatars) in the same read/write.
//
// Entries are capped at MAX_PER_PLAYER, oldest dropped first -- this is a
// "recent activity" feed, not a permanent audit trail, so unbounded growth
// was never a goal worth the disk/complexity.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonStore');
const playersStoreKeyOf = (nickname) => String(nickname || '').trim().toLowerCase();

const FILE = path.join(__dirname, '..', '..', 'data', 'activity.json');
const MAX_PER_PLAYER = 50;

let cache = null;
function load() {
  if (cache === null) cache = readJson(FILE, {});
  return cache;
}
function save() { writeJsonAtomic(FILE, cache); }

/**
 * entry: { label: string, detail: string, accent?: '#rrggbb', win?: boolean }
 * -- label/detail match ActivityFeed.jsx's { game, result } shape (renamed
 * slightly since "game" felt off for a quiz win), accent is a hex color used
 * exactly like the reference's per-row dot color, win just controls dimmer
 * vs. brighter text styling for a loss vs a win/neutral entry.
 */
function logActivity(nickname, entry) {
  const key = playersStoreKeyOf(nickname);
  if (!key || !entry || !entry.label) return;
  const data = load();
  if (!Array.isArray(data[key])) data[key] = [];
  data[key].unshift({
    ts: Date.now(),
    label: String(entry.label).slice(0, 80),
    detail: String(entry.detail || '').slice(0, 120),
    accent: entry.accent || '#00FFD1',
    win: entry.win !== false
  });
  if (data[key].length > MAX_PER_PLAYER) data[key].length = MAX_PER_PLAYER;
  save();
}

function getRecentActivity(nickname, limit = 20) {
  const data = load();
  const list = data[playersStoreKeyOf(nickname)] || [];
  return list.slice(0, Math.max(0, limit));
}

const UK_DAY_LABELS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']; // Date#getDay() index order (0=Sunday)

/**
 * Real "activity per day, last N days" series for ActivityChart -- oldest
 * day first, today last, matching the reference's Пн..Нд reading order
 * closely enough (a real rolling week, rather than always-Monday-first,
 * reads more honestly for "the last 7 days" than forcing calendar-week
 * boundaries would). Days with zero logged activity are real zeroes, not
 * omitted -- an honest mostly-flat chart for a brand-new log beats a fake
 * lively one.
 */
function getDailyCounts(nickname, days = 7) {
  const data = load();
  const list = data[playersStoreKeyOf(nickname)] || [];
  const buckets = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    buckets.push({ dateKey: d.toDateString(), label: UK_DAY_LABELS[d.getDay()], count: 0 });
  }
  const byDateKey = new Map(buckets.map(b => [b.dateKey, b]));
  list.forEach((entry) => {
    const dk = new Date(entry.ts).toDateString();
    const bucket = byDateKey.get(dk);
    if (bucket) bucket.count++;
  });
  return buckets.map(b => ({ d: b.label, v: b.count }));
}

module.exports = { logActivity, getRecentActivity, getDailyCounts };
