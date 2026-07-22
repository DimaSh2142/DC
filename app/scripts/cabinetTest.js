// Tests for the "Особистий кабінет" dashboard rebuild (2026-07-22): the
// achievement condition engine (src/logic/achievements.js), the real KKoin-
// balance leaderboard rank (playersStore.getRank), the cabinet response
// composition (profileRoutes.buildCabinetData), and the new activityStore
// wiring added to roomManager.js (quiz win), miniGameManager.js (mini-game
// finish), and blackjackManager.js (solo Blackjack) -- previously only the
// 3 casino TABLE managers (blackjackTableManager/rouletteTableManager/
// plinkoManager) logged here. Same PASS/FAIL/assert style as every other
// scripts/*.js file. Every nickname used below is unique to its own
// assertion block (same convention scripts/miniGameSocketTest.js already
// uses) so this file works correctly no matter what order its blocks run in
// and never needs to reset data/*.json mid-file.

const fs = require('fs');
const path = require('path');
const playersStore = require('../src/state/playersStore');
const activityStore = require('../src/state/activityStore');
const { ACHIEVEMENTS, computeAchievements } = require('../src/logic/achievements');
const { buildCabinetData } = require('../src/routes/profileRoutes');
const { RoomManager } = require('../src/state/roomManager');
const { MiniGameManager } = require('../src/state/miniGameManager');
const { BlackjackManager } = require('../src/state/blackjackManager');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

// ================= achievements.js (pure logic) =================
(function testAchievements() {
  console.log('\n--- Achievements: real conditions, no fabricated numbers ---');
  assert(ACHIEVEMENTS.length === 8, 'exactly 8 achievement definitions are registered');
  assert(ACHIEVEMENTS.every((a) => a.id && a.title && a.desc && a.emoji && a.accent && typeof a.test === 'function'),
    'every achievement definition has id/title/desc/emoji/accent and a test() function');

  const noneUnlocked = computeAchievements({});
  assert(noneUnlocked.every((a) => a.unlocked === false), 'a completely empty context (brand-new profile) unlocks NOTHING -- no achievement is ever unlocked by default');

  const erudite = computeAchievements({ correct: 49 }).find((a) => a.id === 'erudite');
  assert(erudite.unlocked === false, "'Ерудит' stays locked at 49 correct answers (one below the real threshold)");
  const eruditeUnlocked = computeAchievements({ correct: 50 }).find((a) => a.id === 'erudite');
  assert(eruditeUnlocked.unlocked === true, "'Ерудит' unlocks at exactly 50 correct answers");

  const veteran = computeAchievements({ gamesPlayed: 10 }).find((a) => a.id === 'veteran');
  assert(veteran.unlocked === true, "'Завсідник' unlocks at 10 games played (real playersStore.gamesPlayed)");

  const rich = computeAchievements({ kkoin: 500 }).find((a) => a.id === 'rich');
  assert(rich.unlocked === true, "'Багатій' unlocks at 500 KKoin balance");
  const notRich = computeAchievements({ kkoin: 499 }).find((a) => a.id === 'rich');
  assert(notRich.unlocked === false, "'Багатій' stays locked one KKoin below the threshold");

  const gamblerNo = computeAchievements({ recentActivity: [{ label: 'Вікторина · Перемога команди', win: true }] }).find((a) => a.id === 'gambler');
  assert(gamblerNo.unlocked === false, "'Азартний гравець' does NOT unlock from quiz activity alone -- it specifically requires a 'Казино' -prefixed entry");
  const gamblerYes = computeAchievements({ recentActivity: [{ label: 'Казино · Plinko', win: false }] }).find((a) => a.id === 'gambler');
  assert(gamblerYes.unlocked === true, "'Азартний гравець' unlocks from ANY real Казино activity entry, win or lose");

  const streakShort = computeAchievements({ recentActivity: [{ win: true }, { win: true }] }).find((a) => a.id === 'streak');
  assert(streakShort.unlocked === false, "'На хвилі' needs at least 3 logged events -- 2 wins isn't enough data to claim a 3-streak");
  const streakBroken = computeAchievements({ recentActivity: [{ win: true }, { win: false }, { win: true }] }).find((a) => a.id === 'streak');
  assert(streakBroken.unlocked === false, "'На хвилі' requires the 3 MOST RECENT entries to all be wins -- a loss in between breaks it");
  const streakGood = computeAchievements({ recentActivity: [{ win: true }, { win: true }, { win: true }, { win: false }] }).find((a) => a.id === 'streak');
  assert(streakGood.unlocked === true, "'На хвилі' unlocks when the 3 newest entries are all wins, regardless of what happened before that");

  const teamPlayerLoss = computeAchievements({ recentActivity: [{ label: 'Вікторина · Перемога команди', win: false }] }).find((a) => a.id === 'team_player');
  assert(teamPlayerLoss.unlocked === false, "'Командний гравець' checks win===true, not just the label -- defensive against a mislabeled entry");

  const collector = computeAchievements({ items: [{ name: 'Капелюх' }] }).find((a) => a.id === 'collector');
  assert(collector.unlocked === true, "'Колекціонер' unlocks the moment items.length >= 1");

  const bubbleMaster = computeAchievements({ bubbleLevel: 10 }).find((a) => a.id === 'bubble_master');
  assert(bubbleMaster.unlocked === true, "'Бульбашковий майстер' unlocks at persistent bubbleLevel 10");
})();

// ================= playersStore.getRank =================
(function testRank() {
  console.log('\n--- playersStore.getRank: real KKoin-balance leaderboard ---');
  // getRank() ranks against the COMPLETE player set on disk, unlike every
  // other assertion in this suite (which only ever reads/writes its own
  // uniquely-named nicknames and so is immune to whatever other scripts
  // already wrote to data/players.json). Exact rank-NUMBER assertions below
  // would be silently skewed by however many players integrationTest.js/
  // blackjackTest.js/etc already created earlier in the same test run --
  // reset first. Safe to do here: this file's own playersStore usage hasn't
  // started yet (testAchievements above never touches the store), and every
  // other script in the suite runs as its own separate `node` process that
  // has already fully exited by the time this one starts, so this can't
  // retroactively invalidate anything they already asserted.
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'players.json'), '{}');
  playersStore.getOrCreatePlayer('RankAlice'); playersStore.addKkoin('RankAlice', 900);
  playersStore.getOrCreatePlayer('RankBob'); playersStore.addKkoin('RankBob', 900); // ties Alice
  playersStore.getOrCreatePlayer('RankCarl'); playersStore.addKkoin('RankCarl', 300);

  const aliceRank = playersStore.getRank('RankAlice');
  const bobRank = playersStore.getRank('RankBob');
  const carlRank = playersStore.getRank('RankCarl');
  assert(aliceRank.rank === 1 && bobRank.rank === 1, 'two players tied on KKoin balance share the SAME rank (competition ranking, not arbitrary tie-breaking)');
  assert(carlRank.rank === 3, "the next distinct (lower) balance skips ahead to rank 3, not 2 -- standard competition-ranking semantics (1,1,3)");
  assert(aliceRank.total === bobRank.total && bobRank.total === carlRank.total, 'total player count is consistent across all 3 lookups');

  const unknown = playersStore.getRank('SomeoneWhoNeverPlayed');
  assert(unknown.rank === null, 'a nickname with no stored profile at all gets rank:null, never a misleading 0 or a crash');
})();

// ================= profileRoutes.buildCabinetData =================
(function testBuildCabinetData() {
  console.log('\n--- profileRoutes.buildCabinetData: real composition of all 4 sources ---');
  const nickname = 'CabinetDataUser';
  playersStore.getOrCreatePlayer(nickname);
  playersStore.recordAnswer(nickname, true);
  playersStore.recordAnswer(nickname, true);
  playersStore.addKkoin(nickname, 50);
  activityStore.logActivity(nickname, { label: 'Казино · Рулетка', detail: 'Виграш +20 KKoin', accent: '#00FFD1', win: true });

  const profile = playersStore.getProfile(nickname);
  const cabinet = buildCabinetData(profile);
  assert(Array.isArray(cabinet.recentActivity) && cabinet.recentActivity.length === 1, 'buildCabinetData surfaces the real activity log entry just written');
  assert(cabinet.recentActivity[0].label === 'Казино · Рулетка', 'the surfaced entry is the real one, not a placeholder');
  assert(Array.isArray(cabinet.dailyCounts) && cabinet.dailyCounts.length === 7, 'buildCabinetData surfaces a real 7-day daily-count series');
  assert(cabinet.dailyCounts.reduce((sum, d) => sum + d.v, 0) === 1, "today's bucket in dailyCounts reflects the one real activity entry just logged");
  assert(Array.isArray(cabinet.achievements) && cabinet.achievements.length === 8, 'buildCabinetData surfaces all 8 achievement entries with real unlock states');
  assert(cabinet.achievements.find((a) => a.id === 'gambler').unlocked === true, "the 'gambler' achievement is correctly unlocked from this profile's real Казино activity");
  assert(typeof cabinet.rank === 'number' && cabinet.rank >= 1, 'buildCabinetData surfaces a real numeric rank for a profile that exists in the store');
})();

// ================= roomManager: real quiz-win activity logging =================
// _computeMvpAndKkoin is exercised directly against a minimal hand-built
// room shape (same "construct the exact object the function reads/writes,
// skip the full lifecycle" technique scripts/miniGameSocketTest.js already
// uses for miniGameManager.settleStakes) -- driving a REAL quiz from lobby
// through N rounds of real questions just to reach this one function is
// already thoroughly covered by scripts/integrationTest.js and would add
// nothing here except setup noise.
(function testRoomManagerActivityLogging() {
  console.log('\n--- roomManager._computeMvpAndKkoin: real quiz-win activity logging ---');
  const roomManager = new RoomManager();
  const fakeRoom = {
    players: new Map([
      ['quizwinnerone', { nickname: 'QuizWinnerOne', gameCorrect: 3 }],
      ['quizwinnertwo', { nickname: 'QuizWinnerTwo', gameCorrect: 1 }],
      ['quizloserone', { nickname: 'QuizLoserOne', gameCorrect: 0 }]
    ]),
    teams: [
      { id: 't1', name: 'Альфа', score: 100, memberKeys: ['quizwinnerone', 'quizwinnertwo'] },
      { id: 't2', name: 'Бета', score: 50, memberKeys: ['quizloserone'] }
    ]
  };
  roomManager._computeMvpAndKkoin(fakeRoom);

  const winnerActivity = activityStore.getRecentActivity('QuizWinnerOne', 1);
  assert(winnerActivity.length === 1 && winnerActivity[0].label === 'Вікторина · Перемога команди', 'a winning-team member gets a real "Вікторина · Перемога команди" activity entry the instant the quiz resolves');
  assert(winnerActivity[0].detail.indexOf('Альфа') !== -1, "the entry's detail names the actual winning team");
  assert(winnerActivity[0].win === true, 'the quiz-win activity entry is marked win:true');

  const loserActivity = activityStore.getRecentActivity('QuizLoserOne', 1);
  assert(loserActivity.length === 0, 'a member of the LOSING team gets no quiz-win activity entry at all (only winners are logged here)');
})();

// ================= miniGameManager: real mini-game-finish activity logging =================
(function testMiniGameActivityLogging() {
  console.log('\n--- miniGameManager: real mini-game-finish activity logging (via the real public API) ---');
  const miniGameManager = new MiniGameManager();
  const createRes = miniGameManager.createRoom('tictactoe', 'MgWinner', 'sockA', null, 0);
  const joinRes = miniGameManager.joinRoom(createRes.room.code, 'tictactoe', 'MgLoser', 'sockB', null);
  const room = joinRes.room;

  // X (MgWinner, idx 0) wins the top row: 0,1,2
  const tictactoe = miniGameManager.module(room);
  let res = tictactoe.applyMove(room.gameState, 0, 0); miniGameManager.applyModuleResult(room, res); // X
  res = tictactoe.applyMove(room.gameState, 1, 3); miniGameManager.applyModuleResult(room, res); // O
  res = tictactoe.applyMove(room.gameState, 0, 1); miniGameManager.applyModuleResult(room, res); // X
  res = tictactoe.applyMove(room.gameState, 1, 4); miniGameManager.applyModuleResult(room, res); // O
  res = tictactoe.applyMove(room.gameState, 0, 2); miniGameManager.applyModuleResult(room, res); // X completes top row
  assert(room.status === 'finished' && room.gameState.winnerIdx === 0, 'sanity: the scripted tic-tac-toe game really did end with X (MgWinner) winning');

  const winnerActivity = activityStore.getRecentActivity('MgWinner', 1);
  assert(winnerActivity.length === 1 && winnerActivity[0].label === 'Міні-ігри · Хрестики-нулики', 'the winning player gets a real mini-game-finish activity entry labeled with the actual game');
  assert(winnerActivity[0].win === true, "the winner's entry is win:true");
  const loserActivity = activityStore.getRecentActivity('MgLoser', 1);
  assert(loserActivity.length === 1 && loserActivity[0].win === false, "the loser ALSO gets an entry (unlike the quiz case above), but marked win:false");

  // resign path
  const r1 = miniGameManager.createRoom('checkers', 'ResignWinner', 'sockC', null, 0);
  miniGameManager.joinRoom(r1.room.code, 'checkers', 'ResignLoser', 'sockD', null);
  miniGameManager.resign(r1.room, 1); // playerIdx 1 (ResignLoser) resigns
  const resignWinnerActivity = activityStore.getRecentActivity('ResignWinner', 1);
  assert(resignWinnerActivity.length === 1 && resignWinnerActivity[0].detail.indexOf('здався') !== -1, 'resigning logs a real activity entry for the opponent noting the resignation');
})();

// ================= blackjackManager: real solo-Blackjack activity logging =================
(function testSoloBlackjackActivityLogging() {
  console.log('\n--- blackjackManager: real solo-Blackjack activity logging ---');
  const blackjackManager = new BlackjackManager();
  const nickname = 'SoloBjPlayer';
  playersStore.addKkoin(nickname, 100);
  const dealRes = blackjackManager.deal(nickname, 10);
  assert(dealRes.ok, 'sanity: dealing a solo Blackjack hand succeeds with a covered stake');

  // Stand immediately -- whatever the dealer resolves to, settle() must fire
  // and log exactly one real activity entry (win/push/loss all covered by
  // the same code path, see blackjackManager.js's settle()).
  const standRes = blackjackManager.stand(nickname);
  assert(standRes.ok, 'sanity: standing on the dealt hand is accepted');
  const activity = activityStore.getRecentActivity(nickname, 1);
  assert(activity.length === 1 && activity[0].label === 'Казино · Блекджек', 'settling a solo Blackjack hand logs a real "Казино · Блекджек" activity entry');
  assert(['Виграш', 'Нічия', 'Перебір', 'Програш'].some((word) => activity[0].detail.indexOf(word) === 0), "the entry's detail starts with a real outcome word matching whatever actually happened");
})();

console.log('\n=== ' + passed + '/' + (passed + failed) + ' cabinet assertions passed ===');
if (failed > 0) process.exit(1);
