// Independent supplementary regression checks, written during a later
// verification pass on top of scripts/integrationTest.js. Focuses on things
// the socket-level integration test doesn't directly assert on: the actual
// baked content in data/themesBank.json (not just the generator in
// isolation), answerMatcher edge cases, and the snake-draft team balancer's
// real distribution behavior. Zero dependencies -- runs with plain `node`.
//
// Usage: node scripts/extraChecks.js

const path = require('path');
const fs = require('fs');
const bank = require('../data/themesBank.json');
const { checkTextAnswer, checkSelectAnswer } = require('../src/logic/answerMatcher');
const { snakeAssignTeams, accuracyOf } = require('../src/logic/teamBalancer');
const { readJson, writeJsonAtomic } = require('../src/state/jsonStore');

let fails = 0;
function check(cond, msg) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) fails++;
}

// ---------- 1. Logo dedup across the REAL baked bank (not just the generator in isolation) ----------
const logoThemes = bank.filter(t => t.category === 'logo');
check(logoThemes.length === 6, 'exactly 6 logo themes in bank (' + logoThemes.length + ')');
const allSvgsGlobal = new Map(); // svg -> "themeId/price" first seen
let logoQCount = 0;
let dupCount = 0;
let correctnessIssues = 0;
for (const t of logoThemes) {
  for (const q of t.questions) {
    logoQCount++;
    const svgs = q.clue.options.map(o => o.svg);
    const uniq = new Set(svgs);
    if (uniq.size !== 4) {
      dupCount++;
      console.log('  -> DUP within question ' + t.id + '/' + q.price + ' unique=' + uniq.size + '/4');
    }
    const optionIds = q.clue.options.map(o => o.optionId).sort().join(',');
    if (optionIds !== 'opt0,opt1,opt2,opt3') { correctnessIssues++; console.log('  -> bad optionId set', t.id, q.price, optionIds); }
    const hasCorrect = q.clue.options.some(o => o.optionId === q.correctOptionId);
    if (!hasCorrect) { correctnessIssues++; console.log('  -> correctOptionId not among options', t.id, q.price); }
    const leaksAnswer = q.clue.options.some(o => 'isCorrect' in o);
    if (leaksAnswer) { correctnessIssues++; console.log('  -> option object leaks isCorrect to client payload!', t.id, q.price); }
    for (const svg of svgs) {
      if (allSvgsGlobal.has(svg)) {
        console.log('  -> GLOBAL cross-question duplicate SVG:', t.id, q.price, 'matches', allSvgsGlobal.get(svg));
      } else {
        allSvgsGlobal.set(svg, t.id + '/' + q.price);
      }
    }
  }
}
check(logoQCount === 30, '30 total logo questions (' + logoQCount + ')');
check(dupCount === 0, 'zero questions with duplicate SVGs among their 4 options');
check(correctnessIssues === 0, 'zero optionId/correctness/answer-leak issues across all logo questions');
check(allSvgsGlobal.size === logoQCount * 4, 'all ' + (logoQCount * 4) + ' rendered SVGs across the whole bank are globally unique (' + allSvgsGlobal.size + ')');

// ---------- 2. Price ladder consistency (matches hardcoded [100,200,300,400,500] in public/js/{player,admin}.js) ----------
const PRICES = [100, 200, 300, 400, 500];
let priceIssues = 0;
for (const t of bank) {
  const prices = t.questions.map(q => q.price);
  if (JSON.stringify(prices) !== JSON.stringify(PRICES)) { priceIssues++; console.log('  -> price ladder mismatch', t.id, prices); }
}
check(priceIssues === 0, 'every theme has exactly the price ladder [100,200,300,400,500] the frontend hardcodes');

// ---------- 3. Text questions: accepted answers non-empty, display present ----------
let textIssues = 0;
for (const t of bank) {
  for (const q of t.questions) {
    if (q.type === 'text') {
      if (!Array.isArray(q.accepted) || q.accepted.length === 0) { textIssues++; console.log('  -> missing accepted', t.id, q.price); }
      if (q.accepted.some(a => !a || !String(a).trim())) { textIssues++; console.log('  -> empty accepted variant', t.id, q.price); }
      if (!q.display) { textIssues++; console.log('  -> missing display', t.id, q.price); }
    }
  }
}
check(textIssues === 0, 'no missing/empty accepted-answer or display fields among text questions');

// ---------- 4. answerMatcher behavior spot checks ----------
check(checkTextAnswer('avatar', ['Avatar']).correct, 'case-insensitive match works (avatar/Avatar)');
check(checkTextAnswer('  Avatar  ', ['Avatar']).correct, 'surrounding whitespace tolerated');
check(checkTextAnswer('avatr', ['Avatar']).correct, 'single-letter-missing typo tolerated on a longer word (avatr/Avatar)');
check(!checkTextAnswer('', ['Avatar']).correct, 'empty input never matches');
check(!checkTextAnswer('cs', ['GTA']).correct, 'unrelated short input does not false-positive match');
check(checkTextAnswer('CS', ['CS']).correct, 'exact short-answer match works (CS)');
check(!checkTextAnswer('XY', ['CS']).correct, 'short accepted answers (<=3 chars) require exact/near match, not loose typo tolerance');
check(checkTextAnswer('Гаррі Поттер', ['Гаррі Поттер', 'Harry Potter']).correct, 'Ukrainian exact match');
check(checkTextAnswer('harry potter', ['Гаррі Поттер', 'Harry Potter']).correct, 'English alt-spelling accepted variant matches');
check(checkSelectAnswer('opt2', 'opt2').correct, 'select-answer exact id match');
check(!checkSelectAnswer('opt1', 'opt2').correct, 'select-answer mismatch correctly rejected');

// ---------- 5. Team balancer: snake draft actually balances strong/weak across teams ----------
function accFromCounts(c, i) { return { nickname: 'p' + c + '_' + i, correct: c, incorrect: 10 - c }; }
// 9 players: 3 "strong" (9 correct/10), 3 "medium" (5/10), 3 "weak" (1/10)
const roster = [
  accFromCounts(9, 1), accFromCounts(9, 2), accFromCounts(9, 3),
  accFromCounts(5, 1), accFromCounts(5, 2), accFromCounts(5, 3),
  accFromCounts(1, 1), accFromCounts(1, 2), accFromCounts(1, 3)
];
const teams = snakeAssignTeams(roster, 3);
check(teams.length === 3, 'snake draft produced 3 teams');
check(teams.every(t => t.length === 3), 'each of the 3 teams got exactly 3 players (9 players / 3 teams)');
const teamAccSums = teams.map(t => t.reduce((s, p) => s + accuracyOf(p), 0));
const maxDiff = Math.max(...teamAccSums) - Math.min(...teamAccSums);
console.log('  team accuracy sums:', teamAccSums.map(x => x.toFixed(2)));
check(maxDiff < 0.15, 'snake draft keeps per-team total accuracy within a tight band (maxDiff=' + maxDiff.toFixed(3) + ') -- strong/weak really are spread out, not stacked');
const tierOf = (nick) => nick.startsWith('p9') ? 'strong' : nick.startsWith('p5') ? 'medium' : 'weak';
const tiersPerTeam = teams.map(t => t.map(p => tierOf(p.nickname)).sort().join(','));
console.log('  tiers per team:', tiersPerTeam);
check(tiersPerTeam.every(t => t === 'medium,strong,weak'), 'every team has exactly one strong + one medium + one weak player (no stacking)');

// ---------- 6. jsonStore atomic round-trip ----------
const tmpFile = path.join(require('os').tmpdir(), 'sigame_jsonstore_test_' + Date.now() + '.json');
writeJsonAtomic(tmpFile, { hello: 'world', n: 42 });
const back = readJson(tmpFile, null);
check(back && back.hello === 'world' && back.n === 42, 'jsonStore atomic write + read round-trip works');
fs.unlinkSync(tmpFile);
const missing = readJson(path.join(require('os').tmpdir(), 'sigame_does_not_exist_' + Date.now() + '.json'), { fallback: true });
check(missing.fallback === true, 'jsonStore returns fallback for missing file instead of throwing');

// ---------- 7. Theme bank size (point 2, added 2026-07-20 run) ----------
// Locks in the "significantly more themes" request as a real regression
// check, not just a one-time claim in PROGRESS.md -- if a future session
// ever accidentally shrinks the bank back down, this fails loudly.
check(bank.length >= 60, 'theme bank has at least 60 themes after the 2026-07-20 expansion (' + bank.length + ')');
const totalQuestions = bank.reduce((s, t) => s + t.questions.length, 0);
check(totalQuestions >= 300, 'theme bank has at least 300 questions after the 2026-07-20 expansion (' + totalQuestions + ')');
const NEW_CATEGORIES_2026_07_20 = ['sport-vibe', 'history-vibe', 'cartoon-vibe', 'food-vibe', 'flag-vibe', 'slogan'];
for (const cat of NEW_CATEGORIES_2026_07_20) {
  check(bank.some(t => t.category === cat), 'new category "' + cat + '" has at least one theme in the bank');
}

console.log('');
console.log(fails === 0 ? 'ALL EXTRA CHECKS PASSED' : (fails + ' EXTRA CHECK(S) FAILED'));
process.exit(fails ? 1 : 0);
