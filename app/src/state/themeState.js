// Theme bank access + anti-repeat tracking. The "generator" the admin
// triggers with one button draws a never-before-used theme from a
// pre-authored content bank (data/themesBank.json) rather than calling a
// live LLM -- there is no LLM API key available inside this deployed app
// by design (see PROGRESS.md / README.md for the full rationale). Usage is
// tracked persistently in data/usedThemes.json so themes don't repeat
// across separate game nights / server restarts, with a graceful
// least-recently-used fallback if the bank is ever exhausted.

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const BANK_FILE = path.join(__dirname, '..', '..', 'data', 'themesBank.json');
const USED_FILE = path.join(__dirname, '..', '..', 'data', 'usedThemes.json');

let bankCache = null;
function loadBank() {
  if (bankCache === null) {
    bankCache = readJson(BANK_FILE, []);
    if (!Array.isArray(bankCache) || bankCache.length === 0) {
      console.error('[themeState] WARNING: themesBank.json is empty or missing at', BANK_FILE);
    }
  }
  return bankCache;
}

function loadUsed() {
  return readJson(USED_FILE, []); // [{id, usedAt}]
}

function saveUsed(list) {
  writeJsonAtomic(USED_FILE, list);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick `count` themes that haven't been used before. Falls back to the
 * least-recently-used already-seen themes if the bank runs out of fresh
 * ones, rather than erroring -- the game must still be playable.
 * Marks the returned themes as used (persisted) before returning.
 *
 * @returns {{ themes: object[], reusedCount: number }}
 */
function pickFreshThemes(count) {
  const bank = loadBank();
  if (bank.length === 0) return { themes: [], reusedCount: 0 };

  const used = loadUsed();
  const usedIds = new Set(used.map(u => u.id));

  const freshPool = shuffle(bank.filter(t => !usedIds.has(t.id)));
  let selected = freshPool.slice(0, count);
  let reusedCount = 0;

  if (selected.length < count) {
    const stillNeeded = count - selected.length;
    // Reuse the oldest-used themes first (least-recently-used), excluding
    // ones already picked in this call.
    const usedSortedOldestFirst = [...used].sort((a, b) => new Date(a.usedAt) - new Date(b.usedAt));
    const alreadyPickedIds = new Set(selected.map(t => t.id));
    const reusable = usedSortedOldestFirst
      .map(u => bank.find(t => t.id === u.id))
      .filter(t => t && !alreadyPickedIds.has(t.id));
    const extra = reusable.slice(0, stillNeeded);
    reusedCount = extra.length;
    selected = selected.concat(extra);
  }

  // persist usage (update/insert usedAt = now for everything just served)
  const now = new Date().toISOString();
  const usedMap = new Map(used.map(u => [u.id, u]));
  for (const t of selected) usedMap.set(t.id, { id: t.id, usedAt: now });
  saveUsed(Array.from(usedMap.values()));

  return { themes: selected, reusedCount };
}

function getBankStats() {
  const bank = loadBank();
  const used = loadUsed();
  return { totalThemes: bank.length, usedThemes: used.length, freshRemaining: Math.max(0, bank.length - used.length) };
}

function resetUsedThemes() {
  saveUsed([]);
}

module.exports = { pickFreshThemes, getBankStats, resetUsedThemes, loadBank };
