// Player ideas/complaints ("система репортів", 2026-07-22, dima: "зроби
// систему репортів - що гравець зможе в особистому кабінеті закинути якусь
// ідею або скаргу, а адмін з кабінету зміг переглядати від всіх гравців
// скарги та пропозиції до проекту"). Deliberately its own file rather than
// folded into playersStore.js -- same reasoning as activityStore.js's own
// header comment: this is an unbounded-over-time log, not a single profile
// record, so keeping it separate means it can never risk corrupting the far
// more important players.json in the same read/write. Same plain-JSON-
// atomic-write convention as every other state module here.
//
// No moderation/approval gate on SUBMITTING (same trust-based tone as the
// rest of this friend-group app -- see profileRoutes.js's .siq-submit
// comment for the same idea already established elsewhere): anyone
// registered can send one any time. Only VIEWING the full list is
// admin-gated (authSessions.requireAdmin, same guard as grant-kkoin).

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const FILE = path.join(__dirname, '..', '..', 'data', 'reports.json');
const MAX_MESSAGE_LEN = 1000;
const MAX_REPORTS = 500; // oldest dropped first once exceeded -- a feedback inbox, not a permanent archive

let cache = null;
function load() {
  if (cache === null) cache = readJson(FILE, []);
  return cache;
}
function save() { writeJsonAtomic(FILE, cache); }

/**
 * type: 'idea' | 'complaint'. Returns the created report, or { error }.
 */
function createReport(nickname, type, message) {
  const trimmedNick = String(nickname || '').trim();
  const trimmedMsg = String(message || '').trim();
  if (!trimmedNick) return { error: 'Невідомий гравець' };
  if (type !== 'idea' && type !== 'complaint') return { error: 'Невірний тип звернення' };
  if (!trimmedMsg) return { error: 'Напишіть текст повідомлення' };
  if (trimmedMsg.length > MAX_MESSAGE_LEN) return { error: 'Занадто довге повідомлення (максимум ' + MAX_MESSAGE_LEN + ' символів)' };

  const data = load();
  const report = {
    id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    nickname: trimmedNick,
    type,
    message: trimmedMsg,
    createdAt: new Date().toISOString(),
    resolved: false
  };
  data.unshift(report); // newest first, same convention as activityStore.js
  if (data.length > MAX_REPORTS) data.length = MAX_REPORTS;
  save();
  return { report };
}

function listReports() {
  return load().slice();
}

/**
 * Admin-only "mark as reviewed" toggle -- purely a read/organize aid (there's
 * no notification back to the player either way), so a plain boolean flip is
 * enough; no separate reply/thread system was asked for.
 */
function setResolved(id, resolved) {
  const data = load();
  const report = data.find((r) => r.id === id);
  if (!report) return { error: 'Звернення не знайдено' };
  report.resolved = !!resolved;
  save();
  return { report };
}

module.exports = { createReport, listReports, setResolved };
