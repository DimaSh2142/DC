// Tests reportsStore.js directly (no HTTP-level test harness in this
// codebase -- see profileRoutes.js's own header comment on buildCabinetData
// for why: everything else tests pure logic/state modules directly too).
//
// Deliberately does NOT try to delete/restore data/reports.json around the
// run: files under the connected workspace folder can't be removed by
// either `rm` or fs.unlinkSync here (both fail with EPERM -- learned the
// hard way testing this very file), so every assertion below is written to
// be additive/relative instead -- unique nicknames per run (same fix
// already applied to plinkoTest.js/rouletteTest.js/miniGameSocketTest.js
// this session for the identical reason) and before/after deltas rather
// than assuming a pristine empty file.

const reportsStore = require('../src/state/reportsStore');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

const nick = 'ReportsTester' + Date.now();

// ---- validation ----
const emptyMsg = reportsStore.createReport(nick, 'idea', '   ');
assert(!!emptyMsg.error, 'createReport rejects a blank/whitespace-only message');

const badType = reportsStore.createReport(nick, 'bug', 'Гра лагає');
assert(!!badType.error, 'createReport rejects a type other than idea/complaint');

const noNick = reportsStore.createReport('', 'idea', 'Щось цікаве');
assert(!!noNick.error, 'createReport rejects an empty nickname');

const tooLong = reportsStore.createReport(nick, 'idea', 'x'.repeat(1001));
assert(!!tooLong.error, 'createReport rejects a message over the length cap');

// None of the rejected calls above should have written anything.
const countBeforeValid = reportsStore.listReports().length;

// ---- happy path ----
const idea = reportsStore.createReport(nick, 'idea', 'Додайте покер! (тест ' + nick + ')');
assert(idea.report && idea.report.id && idea.report.type === 'idea' && idea.report.resolved === false,
  'a valid idea is created with an id, the right type, and starts unresolved');

const complaint = reportsStore.createReport(nick, 'complaint', 'Шахи лагають на телефоні (тест ' + nick + ')');
assert(complaint.report && complaint.report.type === 'complaint', 'a valid complaint is created with the right type');

assert(reportsStore.listReports().length === countBeforeValid + 2, 'exactly the 2 valid submissions above actually got persisted -- the 4 rejected ones did not add anything');

const all = reportsStore.listReports();
assert(all[0].id === complaint.report.id, 'newest report is listed first');
assert(all.some((r) => r.id === idea.report.id), 'the earlier idea is still present in the full list, just not first');

// ---- admin resolve toggle ----
const resolved = reportsStore.setResolved(idea.report.id, true);
assert(resolved.report && resolved.report.resolved === true, 'setResolved(id, true) marks a specific report as resolved');
const stillThere = reportsStore.listReports().find((r) => r.id === complaint.report.id);
assert(stillThere && stillThere.resolved === false, "resolving one report doesn't touch the other");

const badId = reportsStore.setResolved('nope-' + Date.now(), true);
assert(!!badId.error, 'setResolved on an unknown id returns an error instead of silently doing nothing');

// ---- persistence across a fresh require (simulates a server restart) ----
delete require.cache[require.resolve('../src/state/reportsStore')];
const reloaded = require('../src/state/reportsStore');
assert(reloaded.listReports().some((r) => r.id === idea.report.id), 'reports survive a fresh module load (real file persistence, not just in-memory)');

console.log('\n=== ' + passed + '/' + (passed + failed) + ' reports assertions passed ===');
if (failed > 0) process.exit(1);
