const { makeFakeIo } = require('./fakeSocketHarness');
const { registerSocketHandlers } = require('../src/socket/socketHandlers');
const { RoomManager } = require('../src/state/roomManager');
const adminAuth = require('../src/state/adminAuth');
const config = require('../src/config');

async function main() {
  const { io, newConnection } = makeFakeIo();
  const roomManager = new RoomManager();
  registerSocketHandlers(io, { roomManager, adminAuth });

  const assertions = [];
  function assert(cond, msg) {
    assertions.push({ cond: !!cond, msg });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
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
  assert(room.status === 'in_progress', 'room status is in_progress');

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
  assert(moveMidGame.error, 'admin:move_player_to_team is rejected once the game is in_progress (' + moveMidGame.error + ')');

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
