const fs = require('fs');
const path = require('path');

// Hermetic re-runs: playersStore genuinely persists to data/players.json on
// disk (by design -- accuracy stats/kkoin/avatar need to survive a server
// restart), which means running this file twice in a row used to make
// nickname-uniqueness assertions below (renameNickname's "already taken"
// check) fail on the SECOND run against leftover profiles from the first.
// Reset it before requiring playersStore so its lazy-loaded cache starts
// from a clean file every single run, same as the manual reset this repo's
// workflow already does after a real play session -- just automatic now.
const PLAYERS_FILE = path.join(__dirname, '..', 'data', 'players.json');
fs.writeFileSync(PLAYERS_FILE, '{}\n');

// CRITICAL data-safety guard (added 2026-07 alongside dima's "delete themes
// from the bank once a quiz finishes" feature): several scenarios below
// play a real quiz through to genuine completion, which now PERMANENTLY
// deletes the themes it used from data/themesBank.json -- dima's real,
// hand-curated 597-theme content bank, not disposable test fixtures. Without
// this guard, every test run would silently and irreversibly eat into that
// real content. Snapshot both files byte-for-byte up front and restore them
// on the 'exit' event (fires on normal completion, on the explicit
// process.exit(1) below, AND after an uncaught exception -- Node still
// raises 'exit' once the process is actually terminating), so the real bank
// is bit-for-bit exactly as it was before this run no matter how it ends.
const BANK_FILE = path.join(__dirname, '..', 'data', 'themesBank.json');
const USED_THEMES_FILE = path.join(__dirname, '..', 'data', 'usedThemes.json');
const bankSnapshot = fs.readFileSync(BANK_FILE, 'utf8');
const usedThemesSnapshot = fs.readFileSync(USED_THEMES_FILE, 'utf8');
process.on('exit', () => {
  fs.writeFileSync(BANK_FILE, bankSnapshot);
  fs.writeFileSync(USED_THEMES_FILE, usedThemesSnapshot);
});

const { makeFakeIo } = require('./fakeSocketHarness');
const { registerSocketHandlers } = require('../src/socket/socketHandlers');
const { RoomManager } = require('../src/state/roomManager');
const adminAuth = require('../src/state/adminAuth');
const config = require('../src/config');
const playersStore = require('../src/state/playersStore');
const themeState = require('../src/state/themeState');

async function main() {
  const { io, newConnection } = makeFakeIo();
  const roomManager = new RoomManager();
  registerSocketHandlers(io, { roomManager, adminAuth });

  const assertions = [];
  function assert(cond, msg) {
    assertions.push({ cond: !!cond, msg });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  }

  // 2026-07-21: admin:start_game now only opens the ready_check phase (see
  // roomManager.startGame doc comment) -- every test scenario that needs the
  // game ACTUALLY in_progress has to also ready up each teamed player via
  // player:set_ready. `sockets` is a plain array of every player socket in
  // the room (order doesn't matter, unteamed ones are just no-ops server-side).
  async function readyUpAll(sockets) {
    for (const s of sockets) {
      await s.trigger('player:set_ready', {});
    }
  }

  // ---- admin flow ----
  const adminSock = newConnection('admin');
  const badAuth = await adminSock.trigger('admin:authenticate', { token: 'garbage' });
  assert(badAuth.error, 'bad admin token rejected');

  const token = adminAuth.login(config.ADMIN_PASSWORD);
  assert(!!token, 'adminAuth.login works with real configured password');
  const okAuth = await adminSock.trigger('admin:authenticate', { token });
  assert(okAuth.ok, 'admin authenticate succeeds with valid token');

  // a player socket trying to call an admin event directly should be rejected
  const rogueSock = newConnection('rogue-player');
  const rogueTry = await rogueSock.trigger('admin:create_room', {});
  assert(rogueTry.error, 'non-admin socket cannot call admin:create_room directly (security boundary)');

  const created = await adminSock.trigger('admin:create_room', {});
  assert(created.room && created.room.code, 'admin created a room: ' + (created.room && created.room.code));
  const roomCode = created.room.code;

  // ---- players join ----
  const names = ['Ann', 'Bob', 'Cyra', 'Dan', 'Eve', 'Finn'];
  const playerSocks = {};
  for (const n of names) {
    const s = newConnection('player-' + n);
    const res = await s.trigger('player:join', { nickname: n, roomCode });
    assert(res.ok, 'player ' + n + ' joined room ' + roomCode);
    playerSocks[n] = s;
  }

  // wrong room code
  const strayJoin = await newConnection('stray').trigger('player:join', { nickname: 'Ghost', roomCode: 'ZZZZ' });
  assert(strayJoin.error, 'join with invalid room code is rejected');

  // ---- admin assigns teams + generates board + starts ----
  const teamsRes = await adminSock.trigger('admin:assign_teams', { roomCode, numTeams: 3 });
  assert(teamsRes.ok && teamsRes.teams.length === 3, '3 teams formed via snake draft');

  const boardRes = await adminSock.trigger('admin:generate_board', { roomCode, numRounds: 1, themesPerRound: 2 });
  assert(boardRes.ok, 'board generated (1 round x 2 themes)');

  const startRes = await adminSock.trigger('admin:start_game', { roomCode });
  assert(startRes.ok, 'game started');

  const room = roomManager.getRoom(roomCode);
  assert(room.status === 'ready_check', 'room status is ready_check right after admin:start_game (not in_progress yet)');
  await readyUpAll(Object.values(playerSocks));
  assert(room.status === 'in_progress', 'room status is in_progress once every teamed player has pressed ready');

  // ---- play through every question via the socket layer ----
  let rounds = 0;
  while (room.status === 'in_progress' && rounds < 20) {
    const activeTeamId = roomManager.getActiveTeamId(room);
    const activePlayerName = names.find(n => playerSocks[n] && room.players.get(n.toLowerCase()).teamId === activeTeamId);
    const round = roomManager.getCurrentRound(room);
    let target = null;
    for (const theme of round.themes) {
      for (const q of theme.questions) { if (!q.used) { target = { themeId: theme.id, price: q.price, question: q }; break; } }
      if (target) break;
    }
    if (!target) break;

    const activeSock = playerSocks[activePlayerName];
    const pickRes = await activeSock.trigger('player:pick_question', { themeId: target.themeId, price: target.price });
    assert(pickRes.ok, 'pick_question ok for ' + activePlayerName + ' on ' + target.themeId + '/' + target.price);

    const opened = activeSock.lastReceived('question:opened');
    assert(opened && opened.themeId === target.themeId, 'question:opened broadcast received with correct themeId');

    let payload;
    if (opened.type === 'select') payload = { optionId: opened.clue.options[0].optionId };
    else payload = { text: target.question.accepted ? target.question.accepted[0] : 'x' };

    const ansRes = await activeSock.trigger('player:submit_answer', payload);
    assert(ansRes.ok, 'submit_answer ok');

    // a teammate trying to answer AFTER lock should fail gracefully (simulate double-submit race)
    rounds++;
  }

  assert(room.status === 'finished', 'game reached finished status after all questions answered');

  // ---- non-active-team player cannot pick ----
  // (re-create a fresh room to test this in isolation since previous room finished)
  const created2 = await adminSock.trigger('admin:create_room', {});
  const roomCode2 = created2.room.code;
  const s1 = newConnection('p1'); await s1.trigger('player:join', { nickname: 'Solo1', roomCode: roomCode2 });
  const s2 = newConnection('p2'); await s2.trigger('player:join', { nickname: 'Solo2', roomCode: roomCode2 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode2, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode2, numRounds: 1, themesPerRound: 1 });
  await adminSock.trigger('admin:start_game', { roomCode: roomCode2 });
  await readyUpAll([s1, s2]);
  const room2 = roomManager.getRoom(roomCode2);
  const activeTeam2 = roomManager.getActiveTeamId(room2);
  const inactiveSock = room2.players.get('solo1').teamId === activeTeam2 ? s2 : s1;
  const round2 = roomManager.getCurrentRound(room2);
  const t = round2.themes[0];
  const wrongTurnPick = await inactiveSock.trigger('player:pick_question', { themeId: t.id, price: t.questions[0].price });
  assert(wrongTurnPick.error, 'player on inactive team cannot pick a question');

  // ---- disconnect + reconnect handling ----
  s1.disconnectNow();
  assert(room2.players.get('solo1').connected === false, 'disconnect marks player as not connected (roster entry retained for reconnect)');
  const teamBeforeReconnect = room2.players.get('solo1').teamId;
  const s1b = newConnection('p1-reconnect');
  const rejoin = await s1b.trigger('player:join', { nickname: 'Solo1', roomCode: roomCode2 });
  assert(rejoin.ok && rejoin.room, 'Solo1 can rejoin after disconnect');
  assert(room2.players.get('solo1').connected === true, 'rejoin marks player connected again');
  assert(room2.players.get('solo1').teamId === teamBeforeReconnect, 'rejoin preserves original team assignment');

  // ---- admin override_answer + force_resolve_stuck + rename_team + kick_player ----
  const created3 = await adminSock.trigger('admin:create_room', {});
  const roomCode3 = created3.room.code;
  const a1 = newConnection('a1'); await a1.trigger('player:join', { nickname: 'Zoe', roomCode: roomCode3 });
  const a2 = newConnection('a2'); await a2.trigger('player:join', { nickname: 'Wex', roomCode: roomCode3 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode3, numTeams: 2 });

  const renameRes = await adminSock.trigger('admin:rename_team', { roomCode: roomCode3, teamId: 'team0', name: 'Тестова команда' });
  assert(renameRes.ok, 'admin:rename_team succeeds');
  const room3 = roomManager.getRoom(roomCode3);
  assert(room3.teams.find(t => t.id === 'team0').name === 'Тестова команда', 'team name actually changed');

  await adminSock.trigger('admin:generate_board', { roomCode: roomCode3, numRounds: 1, themesPerRound: 1 });
  await adminSock.trigger('admin:start_game', { roomCode: roomCode3 });
  await readyUpAll([a1, a2]);
  const activeTeam3 = roomManager.getActiveTeamId(room3);
  const activeSock3 = room3.players.get('zoe').teamId === activeTeam3 ? a1 : a2;
  const round3 = roomManager.getCurrentRound(room3);
  const theme3 = round3.themes[0];

  await activeSock3.trigger('player:pick_question', { themeId: theme3.id, price: theme3.questions[0].price });
  assert(!!room3.activeQuestion, 'question is open and pending (simulating a stuck/slow team)');
  const forceRes = await adminSock.trigger('admin:force_resolve_stuck', { roomCode: roomCode3 });
  assert(forceRes.ok, 'admin can force-resolve a stuck question');
  assert(!room3.activeQuestion, 'question closed after force-resolve');
  assert(room3.lastResolvedAnswer.timedOut === true, 'force-resolved answer is recorded as a timeout');

  const scoreBeforeOverride = room3.teams.find(t => t.id === activeTeam3).score;
  const overrideRes = await adminSock.trigger('admin:override_answer', { roomCode: roomCode3, correct: true });
  assert(overrideRes.ok, 'admin:override_answer succeeds (flips a wrongly-graded timeout to correct)');
  const scoreAfterOverride = room3.teams.find(t => t.id === activeTeam3).score;
  assert(scoreAfterOverride > scoreBeforeOverride, 'overriding to correct increases team score (' + scoreBeforeOverride + ' -> ' + scoreAfterOverride + ')');

  const kickRes = await adminSock.trigger('admin:kick_player', { roomCode: roomCode3, nicknameKey: 'wex' });
  assert(kickRes.ok, 'admin:kick_player succeeds');
  assert(!room3.players.has('wex'), 'kicked player removed from roster');

  // ---- regression tests for issues found in independent code review ----

  // 1) mid-game guardrails: assign_teams / generate_board must be rejected
  //    once a game is in_progress (previously silently wiped scores / broke turnOrder)
  const midGameAssign = await adminSock.trigger('admin:assign_teams', { roomCode: roomCode3, numTeams: 2 });
  assert(midGameAssign.error, 'admin:assign_teams is rejected mid-game (' + midGameAssign.error + ')');
  const midGameBoard = await adminSock.trigger('admin:generate_board', { roomCode: roomCode3, numRounds: 1, themesPerRound: 1 });
  assert(midGameBoard.error, 'admin:generate_board is rejected mid-game (' + midGameBoard.error + ')');

  // 2) emptying the ACTIVE team mid-game must not deadlock the turn order --
  //    getActiveTeamId() should self-heal by skipping to the next non-empty team
  const created4 = await adminSock.trigger('admin:create_room', {});
  const roomCode4 = created4.room.code;
  const q1 = newConnection('q1'); await q1.trigger('player:join', { nickname: 'Kim', roomCode: roomCode4 });
  const q2 = newConnection('q2'); await q2.trigger('player:join', { nickname: 'Lee', roomCode: roomCode4 });
  const q3 = newConnection('q3'); await q3.trigger('player:join', { nickname: 'Moe', roomCode: roomCode4 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode4, numTeams: 3 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode4, numRounds: 1, themesPerRound: 1 });
  await adminSock.trigger('admin:start_game', { roomCode: roomCode4 });
  await readyUpAll([q1, q2, q3]);
  const room4 = roomManager.getRoom(roomCode4);
  const activeTeamBefore = roomManager.getActiveTeamId(room4);
  const activeTeamMembers = room4.teams.find(t => t.id === activeTeamBefore).memberKeys.slice();
  assert(activeTeamMembers.length === 1, 'sanity: each of the 3 teams has exactly 1 of the 3 players');
  const kickActiveRes = await adminSock.trigger('admin:kick_player', { roomCode: roomCode4, nicknameKey: activeTeamMembers[0] });
  assert(kickActiveRes.ok, 'kicked the sole member of the currently-active team');
  const activeTeamAfter = roomManager.getActiveTeamId(room4);
  assert(activeTeamAfter !== activeTeamBefore, 'active team auto-advanced away from the now-empty team (no deadlock): ' + activeTeamBefore + ' -> ' + activeTeamAfter);
  assert(room4.teams.find(t => t.id === activeTeamAfter).memberKeys.length > 0, 'newly active team actually has a member who can act');
  // prove the game is genuinely unstuck: someone on the new active team can pick a question
  const survivorNickname = ['Kim', 'Lee', 'Moe'].find(n => room4.players.has(n.toLowerCase()) && room4.players.get(n.toLowerCase()).teamId === activeTeamAfter);
  const survivorSock = { Kim: q1, Lee: q2, Moe: q3 }[survivorNickname];
  const round4 = roomManager.getCurrentRound(room4);
  const unstuckPick = await survivorSock.trigger('player:pick_question', { themeId: round4.themes[0].id, price: round4.themes[0].questions[0].price });
  assert(unstuckPick.ok, 'a player on the surviving team can pick a question after the deadlock-prone kick (game is not stuck)');

  // 3) reconnect mid-question should receive the open clue in room state, not just a bare board
  const opened4 = survivorSock.lastReceived('question:opened');
  const freshSock = newConnection('reconnect-mid-question');
  const rejoinDuringQuestion = await freshSock.trigger('player:join', { nickname: survivorNickname, roomCode: roomCode4 });
  assert(rejoinDuringQuestion.ok, 'survivor can "reconnect" (re-join) while a question is open');
  assert(rejoinDuringQuestion.room.activeQuestion && rejoinDuringQuestion.room.activeQuestion.openedPayload, 'room state on reconnect includes the open question\'s clue payload, not just themeId/price');
  assert(rejoinDuringQuestion.room.activeQuestion.openedPayload.themeId === opened4.themeId, 'reconnect clue payload matches the actually-open question');
  assert(typeof rejoinDuringQuestion.room.activeQuestion.msRemaining === 'number' && rejoinDuringQuestion.room.activeQuestion.msRemaining > 0, 'reconnect payload includes remaining answer time');

  // ---- host ("ведучий") free-form scoring tools (added 2026-07-20 run) ----
  const created5 = await adminSock.trigger('admin:create_room', {});
  const roomCode5 = created5.room.code;
  const h1 = newConnection('h1'); await h1.trigger('player:join', { nickname: 'Nadia', roomCode: roomCode5 });
  const h2 = newConnection('h2'); await h2.trigger('player:join', { nickname: 'Oleh', roomCode: roomCode5 });
  const h3 = newConnection('h3'); await h3.trigger('player:join', { nickname: 'Petro', roomCode: roomCode5 });
  const h4 = newConnection('h4'); await h4.trigger('player:join', { nickname: 'Roksana', roomCode: roomCode5 });

  // non-admin cannot call either new host tool directly (same security boundary as every other admin:* event)
  const rogueTeamAdjust = await h1.trigger('admin:adjust_team_score', { roomCode: roomCode5, teamId: 'team0', delta: 100 });
  assert(rogueTeamAdjust.error, 'non-admin socket cannot call admin:adjust_team_score directly');
  const roguePlayerAdjust = await h1.trigger('admin:adjust_player_score', { roomCode: roomCode5, nicknameKey: 'nadia', delta: 100 });
  assert(roguePlayerAdjust.error, 'non-admin socket cannot call admin:adjust_player_score directly');

  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode5, numTeams: 4 });
  const room5 = roomManager.getRoom(roomCode5);
  assert(room5.teams.length === 4, '4 teams formed (up to 4-5 supported for the 6-14 player case)');
  assert(room5.teams[3].color === room5.teams[0].color + '-dark', '4th team reuses the 1st team\'s hue as a dark shade instead of colliding on an identical color (' + room5.teams[0].color + ' -> ' + room5.teams[3].color + ')');

  // team score: arbitrary +/- at any time, independent of the last-answer override
  const targetTeam = room5.teams[0];
  const scoreBefore = targetTeam.score;
  const teamBonus = await adminSock.trigger('admin:adjust_team_score', { roomCode: roomCode5, teamId: targetTeam.id, delta: 37 });
  assert(teamBonus.ok, 'admin:adjust_team_score succeeds for a host bonus');
  assert(targetTeam.score === scoreBefore + 37, 'team score actually increased by the exact delta (' + scoreBefore + ' -> ' + targetTeam.score + ')');
  const teamPenalty = await adminSock.trigger('admin:adjust_team_score', { roomCode: roomCode5, teamId: targetTeam.id, delta: -12 });
  assert(teamPenalty.ok && targetTeam.score === scoreBefore + 37 - 12, 'team score adjustment also works negative (penalty)');
  const teamAdjustNoTeam = await adminSock.trigger('admin:adjust_team_score', { roomCode: roomCode5, teamId: 'not-a-real-team', delta: 5 });
  assert(teamAdjustNoTeam.error, 'admin:adjust_team_score rejects an unknown teamId');
  const teamAdjustZero = await adminSock.trigger('admin:adjust_team_score', { roomCode: roomCode5, teamId: targetTeam.id, delta: 0 });
  assert(teamAdjustZero.error, 'admin:adjust_team_score rejects a zero delta (nothing to apply)');

  // personal bonus score: separate counter, does not touch team.score
  const nadia = room5.players.get('nadia');
  const teamScoreBeforePersonal = targetTeam.score;
  const personalBonus = await adminSock.trigger('admin:adjust_player_score', { roomCode: roomCode5, nicknameKey: 'nadia', delta: 15 });
  assert(personalBonus.ok, 'admin:adjust_player_score succeeds');
  assert(nadia.personalScore === 15, 'personal bonus score actually recorded on the player (' + nadia.personalScore + ')');
  assert(targetTeam.score === teamScoreBeforePersonal, 'adjusting a personal bonus score does NOT change any team score (kept fully separate, as documented)');
  const publicAfterBonus = roomManager.publicState(room5);
  assert(publicAfterBonus.players.find(p => p.nickname === 'Nadia').personalScore === 15, 'personalScore is exposed on publicState() for the client to render');

  // ---- voice chat signaling: team-scoped mesh relay (added 2026-07-20 run) ----
  // This exercises the real server-side relay/isolation logic. It cannot
  // exercise actual WebRTC media (no browser here) -- see PROGRESS.md for
  // what real-browser testing covered instead.
  const created6 = await adminSock.trigger('admin:create_room', {});
  const roomCode6 = created6.room.code;
  const vAnn = newConnection('v-ann'); const vAnnJoin = await vAnn.trigger('player:join', { nickname: 'VAnn', roomCode: roomCode6 });
  const vBob = newConnection('v-bob'); const vBobJoin = await vBob.trigger('player:join', { nickname: 'VBob', roomCode: roomCode6 });
  const vCyra = newConnection('v-cyra'); const vCyraJoin = await vCyra.trigger('player:join', { nickname: 'VCyra', roomCode: roomCode6 });
  const vDan = newConnection('v-dan'); const vDanJoin = await vDan.trigger('player:join', { nickname: 'VDan', roomCode: roomCode6 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode6, numTeams: 2 });
  const room6 = roomManager.getRoom(roomCode6);
  const teamOfAnn = room6.players.get('vann').teamId;
  // figure out who's actually on Ann's team vs. the other team after the snake draft
  const sameTeamAsAnn = ['VBob', 'VCyra', 'VDan'].filter(n => room6.players.get(n.toLowerCase()).teamId === teamOfAnn);
  const sockByName = { VAnn: vAnn, VBob: vBob, VCyra: vCyra, VDan: vDan };
  const teammateSock = sockByName[sameTeamAsAnn[0]];
  const otherTeamName = ['VBob', 'VCyra', 'VDan'].find(n => room6.players.get(n.toLowerCase()).teamId !== teamOfAnn);
  const otherTeamSock = sockByName[otherTeamName];

  const voiceJoinNoTeam = await newConnection('v-noteam').trigger('voice:join', {});
  assert(voiceJoinNoTeam.error, 'voice:join is rejected for a socket that never even joined a room');

  const annVoice = await vAnn.trigger('voice:join', {});
  assert(annVoice.ok && annVoice.peers.length === 0, 'first team member to join voice sees an empty peer list');

  const teammateVoice = await teammateSock.trigger('voice:join', {});
  assert(teammateVoice.ok && teammateVoice.peers.length === 1 && teammateVoice.peers[0].socketId === vAnn.id, 'second member of the SAME team sees the first member as an existing peer');
  const annPeerJoinedEvent = vAnn.lastReceived('voice:peer-joined');
  assert(annPeerJoinedEvent && annPeerJoinedEvent.socketId === teammateSock.id, 'existing member is notified when a teammate joins voice chat');

  const otherVoice = await otherTeamSock.trigger('voice:join', {});
  assert(otherVoice.ok && otherVoice.peers.length === 0, 'a player on the OTHER team joining voice does not see team A\'s members at all (structural isolation)');

  // isolation: offering to someone on the other team must be rejected server-side
  const crossTeamOffer = await teammateSock.trigger('voice:offer', { to: otherTeamSock.id, sdp: { type: 'offer', sdp: 'fake' } });
  assert(crossTeamOffer.error, 'voice:offer targeting a socket on a DIFFERENT team is rejected by the server (real isolation, not just client-side)');

  // legitimate same-team signaling relay works end-to-end
  const legitOffer = await teammateSock.trigger('voice:offer', { to: vAnn.id, sdp: { type: 'offer', sdp: 'real-offer' } });
  assert(legitOffer.ok, 'voice:offer to an actual teammate is accepted');
  const annReceivedOffer = vAnn.lastReceived('voice:offer');
  assert(annReceivedOffer && annReceivedOffer.from === teammateSock.id && annReceivedOffer.sdp.sdp === 'real-offer', 'the offer SDP is relayed to the correct teammate with the correct sender id');

  const legitAnswer = await vAnn.trigger('voice:answer', { to: teammateSock.id, sdp: { type: 'answer', sdp: 'real-answer' } });
  assert(legitAnswer.ok, 'voice:answer relay works back to the offerer');
  const teammateReceivedAnswer = teammateSock.lastReceived('voice:answer');
  assert(teammateReceivedAnswer && teammateReceivedAnswer.sdp.sdp === 'real-answer', 'answer SDP relayed correctly');

  const legitIce = await vAnn.trigger('voice:ice', { to: teammateSock.id, candidate: { candidate: 'fake-candidate' } });
  assert(legitIce.ok, 'voice:ice candidate relay works');
  assert((teammateSock.lastReceived('voice:ice') || {}).candidate.candidate === 'fake-candidate', 'ICE candidate payload relayed intact');

  // leaving notifies the remaining teammate so they can tear down that RTCPeerConnection
  await teammateSock.trigger('voice:leave', {});
  const annPeerLeftEvent = vAnn.lastReceived('voice:peer-left');
  assert(annPeerLeftEvent && annPeerLeftEvent.socketId === teammateSock.id, 'remaining teammate is notified when someone explicitly leaves voice chat');

  // a hard disconnect (not just clean voice:leave) also cleans up the group and notifies peers
  const secondJoinBack = await teammateSock.trigger('voice:join', {});
  assert(secondJoinBack.ok, 'sanity: teammate can rejoin voice after leaving');
  vAnn.disconnectNow();
  const teammateNotifiedOfDisconnect = teammateSock.lastReceived('voice:peer-left');
  assert(teammateNotifiedOfDisconnect && teammateNotifiedOfDisconnect.socketId === vAnn.id, 'a raw disconnect (not just voice:leave) still notifies teammates to tear down their peer connection');

  // ---- player avatars (added interactive follow-up session, 2026-07-20) ----
  const created7 = await adminSock.trigger('admin:create_room', {});
  const roomCode7 = created7.room.code;
  const FAKE_AVATAR = 'data:image/jpeg;base64,' + 'A'.repeat(200); // shape-valid; validation is format+length only, doesn't decode real image bytes

  const av1 = newConnection('av1');
  const av1Join = await av1.trigger('player:join', { nickname: 'Avi', roomCode: roomCode7, avatar: FAKE_AVATAR });
  assert(av1Join.ok && !av1Join.avatarRejected, 'join with a valid small avatar is accepted, not flagged as rejected');
  const room7 = roomManager.getRoom(roomCode7);
  assert(room7.players.get('avi').avatar === FAKE_AVATAR, 'avatar actually stored on the player record');
  assert(roomManager.publicState(room7).players.find(p => p.nickname === 'Avi').avatar === FAKE_AVATAR, 'avatar exposed via publicState() for the client to render');

  const av2 = newConnection('av2');
  const av2Join = await av2.trigger('player:join', { nickname: 'Bo', roomCode: roomCode7, avatar: 'not-a-real-image' });
  assert(av2Join.ok && av2Join.avatarRejected, 'join with a malformed avatar still succeeds (never blocks joining) but flags avatarRejected');
  assert(room7.players.get('bo').avatar === null, 'malformed avatar is never stored -- silently normalized to null');

  const oversized = 'data:image/png;base64,' + 'B'.repeat(70000);
  const av3Join = await newConnection('av3').trigger('player:join', { nickname: 'Cy', roomCode: roomCode7, avatar: oversized });
  assert(av3Join.avatarRejected, 'oversized avatar payload (over the size cap) is rejected');

  // change avatar later from the lobby (player:set_avatar)
  const NEW_AVATAR = 'data:image/png;base64,' + 'C'.repeat(150);
  const changeRes = await av2.trigger('player:set_avatar', { avatar: NEW_AVATAR });
  assert(changeRes.ok, 'player:set_avatar lets a player set an avatar after already joining');
  assert(room7.players.get('bo').avatar === NEW_AVATAR, 'avatar actually updated on the player record');

  const clearRes = await av2.trigger('player:set_avatar', { avatar: null });
  assert(clearRes.ok, 'player:set_avatar accepts null/none to explicitly clear the avatar');
  assert(room7.players.get('bo').avatar === null, 'avatar actually cleared');

  const noRoomAvatar = await newConnection('av-noroom').trigger('player:set_avatar', { avatar: FAKE_AVATAR });
  assert(noRoomAvatar.error, 'player:set_avatar is rejected for a socket that never joined a room');

  // reconnect must NOT silently wipe a previously-set avatar
  av1.disconnectNow();
  const av1b = newConnection('av1-reconnect');
  const rejoinAvi = await av1b.trigger('player:join', { nickname: 'Avi', roomCode: roomCode7 }); // no avatar field -- same shape as a real page-refresh rejoin
  assert(rejoinAvi.ok, 'Avi can reconnect');
  assert(room7.players.get('avi').avatar === FAKE_AVATAR, 'reconnecting WITHOUT resending an avatar does not wipe the previously-set one');

  // ---- manual player-to-team move (added 2026-07-20 run, item 5) ----
  const created8 = await adminSock.trigger('admin:create_room', {});
  const roomCode8 = created8.room.code;
  const m1 = newConnection('m1'); await m1.trigger('player:join', { nickname: 'Moveme', roomCode: roomCode8 });
  const m2 = newConnection('m2'); await m2.trigger('player:join', { nickname: 'Stayer', roomCode: roomCode8 });
  const m3 = newConnection('m3'); await m3.trigger('player:join', { nickname: 'Filler', roomCode: roomCode8 });
  const m4 = newConnection('m4'); await m4.trigger('player:join', { nickname: 'Buddy', roomCode: roomCode8 });

  const rogueMove = await m1.trigger('admin:move_player_to_team', { roomCode: roomCode8, nicknameKey: 'moveme', teamId: 'team0' });
  assert(rogueMove.error, 'non-admin socket cannot call admin:move_player_to_team directly (security boundary)');

  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode8, numTeams: 2 });
  const room8 = roomManager.getRoom(roomCode8);
  const moveTargetTeam = room8.teams.find(t => t.id !== room8.players.get('moveme').teamId);
  const originalTeamId = room8.players.get('moveme').teamId;
  const moveRes = await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode8, nicknameKey: 'moveme', teamId: moveTargetTeam.id });
  assert(moveRes.ok, 'admin:move_player_to_team succeeds in the lobby');
  assert(room8.players.get('moveme').teamId === moveTargetTeam.id, 'moved player\'s teamId actually updated');
  assert(moveTargetTeam.memberKeys.includes('moveme'), 'moved player added to the target team\'s memberKeys');
  const oldTeam = room8.teams.find(t => t.id === originalTeamId);
  assert(!oldTeam.memberKeys.includes('moveme'), 'moved player removed from their previous team\'s memberKeys (no duplicate membership)');

  const moveUnknownTeam = await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode8, nicknameKey: 'moveme', teamId: 'not-a-team' });
  assert(moveUnknownTeam.error, 'admin:move_player_to_team rejects an unknown teamId');
  const moveUnknownPlayer = await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode8, nicknameKey: 'ghost', teamId: moveTargetTeam.id });
  assert(moveUnknownPlayer.error, 'admin:move_player_to_team rejects an unknown player');

  await adminSock.trigger('admin:generate_board', { roomCode: roomCode8, numRounds: 1, themesPerRound: 1 });
  await adminSock.trigger('admin:start_game', { roomCode: roomCode8 });
  const moveMidGame = await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode8, nicknameKey: 'stayer', teamId: originalTeamId });
  assert(moveMidGame.error, 'admin:move_player_to_team is rejected once past lobby (ready_check counts too) (' + moveMidGame.error + ')');

  // ---- publicState() vs adminState() answer-leak boundary (added 2026-07-20 run, item 8) ----
  const created9 = await adminSock.trigger('admin:create_room', {});
  const roomCode9 = created9.room.code;
  const n1 = newConnection('n1'); const n1Join = await n1.trigger('player:join', { nickname: 'Nosy', roomCode: roomCode9 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode9, numTeams: 2 });
  const genRes9 = await adminSock.trigger('admin:generate_board', { roomCode: roomCode9, numRounds: 1, themesPerRound: 2 });
  assert(genRes9.ok, 'sanity: board generated for the answer-leak boundary test room');

  const room9 = roomManager.getRoom(roomCode9);
  const pub9 = roomManager.publicState(room9);
  const pubQuestion = pub9.rounds[0].themes[0].questions[0];
  assert(!('display' in pubQuestion) && !('accepted' in pubQuestion) && !('correctOptionId' in pubQuestion),
    'publicState() never exposes display/accepted/correctOptionId for ANY question, even ones nobody has opened yet');
  assert('price' in pubQuestion && 'used' in pubQuestion, 'publicState() question entries still have price/used (players need those to render the board)');

  const admin9 = roomManager.adminState(room9);
  const adminQuestion = admin9.rounds[0].themes[0].questions[0];
  assert(!!adminQuestion.display, 'adminState() exposes the correct-answer display text for a question that has NOT been opened yet ("зарання", ahead of time)');
  assert(adminQuestion.type === 'text' || adminQuestion.type === 'select', 'adminState() question entries also carry the question type');

  // the actual socket-level delivery: admin gets the rich event, a normal player never does
  const watchRes9 = await adminSock.trigger('admin:watch_room', { roomCode: roomCode9 });
  assert(watchRes9.room && !!watchRes9.room.rounds[0].themes[0].questions[0].display, 'admin:watch_room callback returns the answer-including adminState, not publicState');
  const n1RoomStateAfterBoard = n1.lastReceived('room:state'); // broadcast by admin:generate_board above, which n1 (already in the room) receives too
  assert(n1RoomStateAfterBoard && n1RoomStateAfterBoard.rounds[0].themes[0].questions[0].display === undefined,
    'the player-facing room:state broadcast for the same room/board never carries the answer (n1 never sees admin:room_state at all -- checked below)');

  const secondGen9 = await adminSock.trigger('admin:generate_board', { roomCode: roomCode9, numRounds: 1, themesPerRound: 2 });
  assert(secondGen9.ok, 'sanity: regenerate board to trigger a fresh admin:room_state broadcast');
  assert(!n1.lastReceived('admin:room_state'), 'a normal player socket never receives admin:room_state, even after actions that broadcast it to the admin channel');
  const lastAdminRoomState = adminSock.lastReceived('admin:room_state');
  assert(!!lastAdminRoomState && lastAdminRoomState.code === roomCode9, 'the admin socket receives the admin:room_state broadcast for the room it just acted on, with the answer key attached');

  // ---- "buy a hint" (added 2026-07-21 run, feedback item 5) ----
  const created10 = await adminSock.trigger('admin:create_room', {});
  const roomCode10 = created10.room.code;
  const hn1 = newConnection('hn1'); await hn1.trigger('player:join', { nickname: 'Hinty', roomCode: roomCode10 });
  const hn2 = newConnection('hn2'); await hn2.trigger('player:join', { nickname: 'Rival', roomCode: roomCode10 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode10, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode10, numRounds: 1, themesPerRound: 2 });
  await adminSock.trigger('admin:start_game', { roomCode: roomCode10 });
  await readyUpAll([hn1, hn2]);

  const room10 = roomManager.getRoom(roomCode10);
  const activeTeam10 = roomManager.getActiveTeamId(room10);
  const activeSockH = room10.players.get('hinty').teamId === activeTeam10 ? hn1 : hn2;
  const idleSockH = activeSockH === hn1 ? hn2 : hn1;
  const round10 = roomManager.getCurrentRound(room10);
  const target10 = round10.themes[0].questions[0];

  const noHintYet = await idleSockH.trigger('player:use_hint', { themeId: round10.themes[0].id, price: target10.price });
  assert(noHintYet.error, 'player:use_hint rejected before any question is even open');

  await activeSockH.trigger('player:pick_question', { themeId: round10.themes[0].id, price: target10.price });
  const scoreBeforeHint = room10.teams.find(t => t.id === activeTeam10).score;

  const wrongTeamHint = await idleSockH.trigger('player:use_hint', { themeId: round10.themes[0].id, price: target10.price });
  assert(wrongTeamHint.error, 'a player on the team NOT currently answering cannot buy a hint');

  const hintRes = await activeSockH.trigger('player:use_hint', { themeId: round10.themes[0].id, price: target10.price });
  assert(hintRes.ok && hintRes.cost === Math.round(target10.price * config.HINT_COST_RATIO), 'player:use_hint succeeds and returns the correct 50% cost (' + (hintRes && hintRes.cost) + ')');
  const scoreAfterHint = room10.teams.find(t => t.id === activeTeam10).score;
  assert(scoreAfterHint === scoreBeforeHint - hintRes.cost, 'hint cost was actually deducted from the answering team\'s own score (' + scoreBeforeHint + ' -> ' + scoreAfterHint + ')');
  assert(room10.activeQuestion.totalMs === config.ANSWER_TIMEOUT_MS + config.HINT_EXTRA_MS, 'answer clock total extended by exactly HINT_EXTRA_MS');
  assert(room10.activeQuestion.hintUsed === true, 'activeQuestion flagged as hint-used');

  const hintBroadcast = activeSockH.lastReceived('hint:used');
  assert(hintBroadcast && hintBroadcast.teamId === activeTeam10 && hintBroadcast.cost === hintRes.cost, 'hint:used broadcast delivered with matching teamId/cost');

  const secondHintSameQuestion = await activeSockH.trigger('player:use_hint', { themeId: round10.themes[0].id, price: target10.price });
  assert(secondHintSameQuestion.error, 'a second hint on the SAME question is rejected (capped at once per question)');

  // ---- networked team music sync (added 2026-07-21 run, feedback item 7) ----
  const created11 = await adminSock.trigger('admin:create_room', {});
  const roomCode11 = created11.room.code;
  const noTeamYet = newConnection('nt1');
  const noTeamJoin = await noTeamYet.trigger('player:join', { nickname: 'Loner', roomCode: roomCode11 });
  assert(noTeamJoin.ok, 'sanity: Loner joined the team-music test room before any teams exist');
  const noTeamMusic = await noTeamYet.trigger('player:team_music_play', { videoId: 'abc123', positionSec: 0 });
  assert(noTeamMusic.error, 'player:team_music_play rejected for a player not yet on any team');

  const tm1 = newConnection('tm1'); await tm1.trigger('player:join', { nickname: 'Mila', roomCode: roomCode11 });
  const tm2 = newConnection('tm2'); await tm2.trigger('player:join', { nickname: 'Nino', roomCode: roomCode11 });
  const tm3 = newConnection('tm3'); await tm3.trigger('player:join', { nickname: 'Oleh', roomCode: roomCode11 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode11, numTeams: 2 });
  const room11 = roomManager.getRoom(roomCode11);
  const milaTeam = room11.players.get('mila').teamId;
  // force Nino onto Mila's team and Oleh onto the other, regardless of how the snake draft split them, so the isolation check below is deterministic
  const otherTeam11 = room11.teams.find(t => t.id !== milaTeam).id;
  await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode11, nicknameKey: 'nino', teamId: milaTeam });
  await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode11, nicknameKey: 'oleh', teamId: otherTeam11 });

  const playRes = await tm1.trigger('player:team_music_play', { videoId: 'dQw4w9WgXcQ', positionSec: 0 });
  assert(playRes.ok, 'player:team_music_play succeeds for a player on a real team');
  assert(room11.teamMusic[milaTeam].videoId === 'dQw4w9WgXcQ' && room11.teamMusic[milaTeam].isPlaying === true, 'server-side teamMusic state actually recorded as playing');

  const teammateBroadcast = tm2.lastReceived('team_music:state');
  assert(teammateBroadcast && teammateBroadcast.state && teammateBroadcast.state.videoId === 'dQw4w9WgXcQ', 'the TEAMMATE (different socket) received the team_music:state broadcast -- proves cross-device sync, not just local playback');
  const selfBroadcast = tm1.lastReceived('team_music:state');
  assert(selfBroadcast && selfBroadcast.state.isPlaying === true, 'the actor\'s own socket also receives the broadcast (single code path for everyone)');
  const rivalTeamBroadcast = tm3.lastReceived('team_music:state');
  assert(!rivalTeamBroadcast, 'a player on the OTHER team never receives this team\'s music broadcast (same isolation guarantee as voice chat)');

  const pauseRes = await tm2.trigger('player:team_music_pause', { positionSec: 12.5 });
  assert(pauseRes.ok, 'a DIFFERENT teammate (not the one who started it) can pause the shared track');
  assert(room11.teamMusic[milaTeam].isPlaying === false && room11.teamMusic[milaTeam].positionSec === 12.5, 'pause recorded the correct paused position server-side');

  const stopRes = await tm1.trigger('player:team_music_stop', {});
  assert(stopRes.ok && room11.teamMusic[milaTeam] === null, 'player:team_music_stop clears the shared state entirely');

  const pub11 = roomManager.publicState(room11);
  assert(pub11.teamMusic && Object.prototype.hasOwnProperty.call(pub11.teamMusic, milaTeam), 'publicState() exposes teamMusic so a reconnecting player can catch up mid-song');

  // ---- ready-check phase (added 2026-07-21 "глобальний проект" run) ----
  const created12 = await adminSock.trigger('admin:create_room', {});
  const roomCode12 = created12.room.code;
  const rc1 = newConnection('rc1'); await rc1.trigger('player:join', { nickname: 'Ready1', roomCode: roomCode12 });
  const rc2 = newConnection('rc2'); await rc2.trigger('player:join', { nickname: 'Ready2', roomCode: roomCode12 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode12, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode12, numRounds: 1, themesPerRound: 1 });
  const room12 = roomManager.getRoom(roomCode12);

  const rc3 = newConnection('rc3'); // joins AFTER teams formed -- deliberately left without a teamId
  await rc3.trigger('player:join', { nickname: 'Latecomer', roomCode: roomCode12 });
  const lateReady = await rc3.trigger('player:set_ready', {});
  assert(lateReady.error, 'player:set_ready rejected before any ready_check has even begun');

  const startRc = await adminSock.trigger('admin:start_game', { roomCode: roomCode12 });
  assert(startRc.ok, 'admin:start_game opens the ready_check phase');
  assert(room12.status === 'ready_check', 'room actually sitting in ready_check, board already generated/visible');

  const noTeamReady = await rc3.trigger('player:set_ready', {});
  assert(noTeamReady.error, 'a player with no team cannot press ready (nothing to hold up)');

  const firstReady = await rc1.trigger('player:set_ready', {});
  assert(firstReady.ok && !firstReady.started, 'first player readying up does NOT start the game yet (2nd player still pending)');
  assert(room12.status === 'ready_check', 'still in ready_check with one player left');
  assert(room12.readyPlayers.size === 1, 'exactly one nicknameKey recorded as ready so far');

  const secondReady = await rc2.trigger('player:set_ready', {});
  assert(secondReady.ok && secondReady.started === true, 'the LAST player readying up flips started=true in the response');
  assert(room12.status === 'in_progress', 'room actually transitioned to in_progress once everyone was ready');
  assert(room12.turnOrder.length === 2, 'turn order was actually built as part of the real start');

  // ---- admin force-start (someone AFK during ready_check) ----
  const created13 = await adminSock.trigger('admin:create_room', {});
  const roomCode13 = created13.room.code;
  const fs1 = newConnection('fs1'); await fs1.trigger('player:join', { nickname: 'Afk1', roomCode: roomCode13 });
  const fs2 = newConnection('fs2'); await fs2.trigger('player:join', { nickname: 'Afk2', roomCode: roomCode13 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode13, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode13, numRounds: 1, themesPerRound: 1 });
  await adminSock.trigger('admin:start_game', { roomCode: roomCode13 });
  const room13 = roomManager.getRoom(roomCode13);
  const rogueForceStart = await fs1.trigger('admin:force_start_game', { roomCode: roomCode13 });
  assert(rogueForceStart.error, 'non-admin socket cannot call admin:force_start_game directly (security boundary)');
  const forceStartRes = await adminSock.trigger('admin:force_start_game', { roomCode: roomCode13 });
  assert(forceStartRes.ok, 'admin:force_start_game succeeds with nobody having pressed ready at all');
  assert(room13.status === 'in_progress', 'force-start actually moved the room to in_progress');

  // ---- admin cancels a ready check (wrong teams, wants to redo) ----
  const created14 = await adminSock.trigger('admin:create_room', {});
  const roomCode14 = created14.room.code;
  const cc1 = newConnection('cc1'); await cc1.trigger('player:join', { nickname: 'Cancel1', roomCode: roomCode14 });
  const cc2 = newConnection('cc2'); await cc2.trigger('player:join', { nickname: 'Cancel2', roomCode: roomCode14 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode14, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode14, numRounds: 1, themesPerRound: 1 });
  const startRes14 = await adminSock.trigger('admin:start_game', { roomCode: roomCode14 });
  assert(startRes14.ok, 'sanity: room14 actually reached ready_check before attempting to cancel it');
  const room14 = roomManager.getRoom(roomCode14);
  const cancelRes = await adminSock.trigger('admin:cancel_ready_check', { roomCode: roomCode14 });
  assert(cancelRes.ok && room14.status === 'lobby', 'admin:cancel_ready_check reverts a ready_check back to lobby (not finished)');
  const boardStillThere = await adminSock.trigger('admin:generate_board', { roomCode: roomCode14, numRounds: 1, themesPerRound: 1 });
  assert(boardStillThere.ok, 'sanity: room is genuinely back in lobby -- can regenerate the board again');

  // ---- MVP + KKoin award at game end (dima's currency ask) ----
  const created15 = await adminSock.trigger('admin:create_room', {});
  const roomCode15 = created15.room.code;
  const rex = newConnection('rex'); await rex.trigger('player:join', { nickname: 'Rex', roomCode: roomCode15 });
  const sam = newConnection('sam'); await sam.trigger('player:join', { nickname: 'Sam', roomCode: roomCode15 });
  const tia = newConnection('tia'); await tia.trigger('player:join', { nickname: 'Tia', roomCode: roomCode15 });
  const uma = newConnection('uma'); await uma.trigger('player:join', { nickname: 'Uma', roomCode: roomCode15 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode15, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode15, numRounds: 1, themesPerRound: 2 });
  const room15 = roomManager.getRoom(roomCode15);
  const teamRexId = room15.players.get('rex').teamId;
  // force a deterministic 2v2 split regardless of how the snake draft landed, so "Rex's team" below is unambiguous
  const teamSamOtherId = room15.teams.find(t => t.id !== teamRexId).id;
  await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode15, nicknameKey: 'sam', teamId: teamRexId });
  await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode15, nicknameKey: 'tia', teamId: teamSamOtherId });
  await adminSock.trigger('admin:move_player_to_team', { roomCode: roomCode15, nicknameKey: 'uma', teamId: teamSamOtherId });
  await adminSock.trigger('admin:start_game', { roomCode: roomCode15 });
  await readyUpAll([rex, sam, tia, uma]);
  assert(room15.status === 'in_progress', 'sanity: MVP/KKoin test room actually reached in_progress');

  const rexKkoinBefore = playersStore.getProfile('Rex').kkoin;
  const samKkoinBefore = playersStore.getProfile('Sam').kkoin;
  const tiaKkoinBefore = playersStore.getProfile('Tia').kkoin;

  let safety15 = 0;
  while (room15.status === 'in_progress' && safety15 < 20) {
    safety15++;
    const activeTeamId15 = roomManager.getActiveTeamId(room15);
    const round15 = roomManager.getCurrentRound(room15);
    let target15 = null;
    for (const theme of round15.themes) {
      for (const q of theme.questions) { if (!q.used) { target15 = { themeId: theme.id, price: q.price, question: q }; break; } }
      if (target15) break;
    }
    if (!target15) break;
    if (activeTeamId15 === teamRexId) {
      // Rex's team -- ALWAYS Rex himself answers, and always correctly, so
      // he's unambiguously both the MVP and on the winning team.
      await rex.trigger('player:pick_question', { themeId: target15.themeId, price: target15.price });
      await rex.trigger('player:submit_answer', { text: target15.question.accepted[0] });
    } else {
      // The other team always answers WRONG, so their score only ever drops.
      await tia.trigger('player:pick_question', { themeId: target15.themeId, price: target15.price });
      await tia.trigger('player:submit_answer', { text: 'zzz_definitely_not_the_answer_zzz' });
    }
  }

  assert(room15.status === 'finished', 'sanity: MVP/KKoin test game actually ran to completion');
  const teamRex15 = room15.teams.find(t => t.id === teamRexId);
  const teamOther15 = room15.teams.find(t => t.id === teamSamOtherId);
  assert(teamRex15.score > teamOther15.score, 'sanity: Rex\'s always-correct team actually ended with the higher score');

  assert(room15.mvp && room15.mvp.nicknames.includes('Rex') && !room15.mvp.nicknames.includes('Sam'),
    'MVP is Rex specifically (he answered every one of his team\'s questions) -- teammate Sam who never answered is NOT credited');
  assert(room15.mvp.correctCount > 0, 'MVP correctCount actually reflects real correct answers, not a zero default');

  assert(room15.kkoinAward && room15.kkoinAward.teamNames.includes(teamRex15.name), 'kkoinAward names the actual winning team');
  const expectedPerPlayer = Math.floor(config.KKOIN_WIN_POOL / 2); // teamRex has exactly 2 members (Rex + Sam)
  assert(room15.kkoinAward.perPlayer === expectedPerPlayer, 'KKoin pool split evenly across the winning team\'s 2 members (' + room15.kkoinAward.perPlayer + ' each)');

  const rexKkoinAfter = playersStore.getProfile('Rex').kkoin;
  const samKkoinAfter = playersStore.getProfile('Sam').kkoin;
  const tiaKkoinAfter = playersStore.getProfile('Tia').kkoin;
  assert(rexKkoinAfter === rexKkoinBefore + expectedPerPlayer, 'Rex\'s persistent kkoin balance actually increased by his share');
  assert(samKkoinAfter === samKkoinBefore + expectedPerPlayer, 'Sam ALSO got a full share -- "ділитись між учасниками команди" -- even though he never personally answered a question');
  assert(tiaKkoinAfter === tiaKkoinBefore, 'the LOSING team gets zero KKoin');

  // ---- personal cabinet: playersStore avatar/rename/kkoin + roomManager's "locked mid-game" guard ----
  const renameOk = playersStore.renameNickname('Rex', 'RexRenamed');
  assert(!renameOk.error && renameOk.profile.nickname === 'RexRenamed', 'playersStore.renameNickname migrates the profile to the new display name');
  assert(playersStore.getProfile('rexrenamed').kkoin === rexKkoinAfter, 'renamed profile keeps its prior kkoin balance (migration, not a fresh record)');
  const renameClash = playersStore.renameNickname('Sam', 'RexRenamed');
  assert(renameClash.error, 'renameNickname rejects a name already taken by someone else');

  const avatarSet = playersStore.setAvatar('Uma', 'data:image/png;base64,' + 'D'.repeat(200));
  assert(!!avatarSet.avatar, 'playersStore.setAvatar persists an avatar on the profile');

  // Uma is still connected+teamed in room15, but that room already finished --
  // isNicknameInActiveGame must key off status (ready_check/in_progress),
  // not mere presence in the players map, so a profile edit after the game
  // ends should NOT be locked.
  assert(roomManager.isNicknameInActiveGame('Uma') === false, 'isNicknameInActiveGame is false once the room has finished (not locked forever just for having played)');
  assert(roomManager.isNicknameInActiveGame('Ready1') === true, 'isNicknameInActiveGame is true for a player still connected in an in_progress room (room12, left mid-game on purpose)');

  // ---- dima 2026-07: themes used in a quiz disappear from the bank once it
  // actually ends -- both the natural full-completion path AND the admin's
  // early "Завершити гру" path. Real deletion from data/themesBank.json,
  // not just the existing soft usedThemes.json rotation tracking -- see
  // themeState.deleteThemesFromBank's header comment. The whole run's real
  // bank file is snapshotted/restored around this file's 'exit' handler
  // (see the top of this file) specifically because of scenarios like this.
  const created16 = await adminSock.trigger('admin:create_room', {});
  const roomCode16 = created16.room.code;
  const d1 = newConnection('d1'); await d1.trigger('player:join', { nickname: 'Delta1', roomCode: roomCode16 });
  const d2 = newConnection('d2'); await d2.trigger('player:join', { nickname: 'Delta2', roomCode: roomCode16 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode16, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode16, numRounds: 1, themesPerRound: 1 });
  const room16 = roomManager.getRoom(roomCode16);
  const themeId16 = room16.rounds[0].themes[0].id;
  const bankBefore16 = themeState.loadBank();
  assert(bankBefore16.some(t => t.id === themeId16), 'sanity: the freshly generated theme is still present in the bank before the game finishes');

  await adminSock.trigger('admin:start_game', { roomCode: roomCode16 });
  await readyUpAll([d1, d2]);
  let rounds16 = 0;
  while (room16.status === 'in_progress' && rounds16 < 20) {
    const activeTeamId16 = roomManager.getActiveTeamId(room16);
    const activeSock16 = room16.players.get('delta1').teamId === activeTeamId16 ? d1 : d2;
    const round16 = roomManager.getCurrentRound(room16);
    let target16 = null;
    for (const theme of round16.themes) {
      for (const q of theme.questions) { if (!q.used) { target16 = { themeId: theme.id, price: q.price, question: q }; break; } }
      if (target16) break;
    }
    if (!target16) break;
    await activeSock16.trigger('player:pick_question', { themeId: target16.themeId, price: target16.price });
    const opened16 = activeSock16.lastReceived('question:opened');
    const payload16 = opened16.type === 'select' ? { optionId: opened16.clue.options[0].optionId } : { text: target16.question.accepted ? target16.question.accepted[0] : 'x' };
    await activeSock16.trigger('player:submit_answer', payload16);
    rounds16++;
  }
  assert(room16.status === 'finished', 'sanity: the natural-completion theme-deletion test game actually ran to completion');
  const bankAfter16 = themeState.loadBank();
  assert(!bankAfter16.some(t => t.id === themeId16), 'the theme used in a NATURALLY completed quiz is permanently deleted from the bank');
  assert(bankAfter16.length === bankBefore16.length - 1, 'the bank shrank by exactly the 1 theme this game used (not more, not less)');

  const created17 = await adminSock.trigger('admin:create_room', {});
  const roomCode17 = created17.room.code;
  const e1 = newConnection('e1'); await e1.trigger('player:join', { nickname: 'Echo1', roomCode: roomCode17 });
  const e2 = newConnection('e2'); await e2.trigger('player:join', { nickname: 'Echo2', roomCode: roomCode17 });
  await adminSock.trigger('admin:assign_teams', { roomCode: roomCode17, numTeams: 2 });
  await adminSock.trigger('admin:generate_board', { roomCode: roomCode17, numRounds: 1, themesPerRound: 1 });
  const room17 = roomManager.getRoom(roomCode17);
  const themeId17 = room17.rounds[0].themes[0].id;
  assert(themeState.loadBank().some(t => t.id === themeId17), 'sanity: this second theme is also present in the bank before its room is ended early');

  const endRes17 = await adminSock.trigger('admin:end_game', { roomCode: roomCode17 });
  assert(endRes17.ok, 'admin:end_game succeeds on a room that never even started playing');
  assert(room17.status === 'finished', 'admin:end_game moves the room straight to finished');
  assert(!themeState.loadBank().some(t => t.id === themeId17), 'the theme from an EARLY-ENDED quiz (admin "Завершити гру") is ALSO permanently deleted from the bank');

  const endAgain17 = await adminSock.trigger('admin:end_game', { roomCode: roomCode17 });
  assert(endAgain17.error, 'admin:end_game rejects being called twice on an already-finished room');

  console.log('');
  const failed = assertions.filter(a => !a.cond);
  console.log('=== ' + (assertions.length - failed.length) + '/' + assertions.length + ' assertions passed ===');
  // The last scenario intentionally leaves one question open (proving the
  // room is unstuck) without answering it, which leaves a real 45s
  // setTimeout pending (config.ANSWER_TIMEOUT_MS) -- that's correct product
  // behavior (a real game would just be waiting on that team), but it keeps
  // this one-off test process alive. Exit explicitly rather than waiting it out.
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('INTEGRATION TEST CRASHED:', err); process.exit(1); });
