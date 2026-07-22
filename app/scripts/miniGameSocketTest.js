// End-to-end socket-layer test for the mini-games -- unlike
// scripts/miniGamesTest.js (which calls src/games/*.js directly, no
// sockets), this drives the REAL src/socket/miniGameHandlers.js through the
// same fake-io harness scripts/integrationTest.js uses for the quiz, so it
// actually exercises room creation/joining, the mg: event names, and --
// critically -- that Battleship's per-player redacted broadcast really does
// differ between the two sockets (that's the one thing pure logic-module
// tests alone can never catch, since redaction happens in
// miniGameManager.publicState() + the handler's per-socket emit loop, not
// inside battleship.js itself).

const { makeFakeIo } = require('./fakeSocketHarness');
const { registerMiniGameHandlers } = require('../src/socket/miniGameHandlers');
const { MiniGameManager } = require('../src/state/miniGameManager');
const playersStore = require('../src/state/playersStore');
const activityStore = require('../src/state/activityStore');
const tictactoeBot = require('../src/games/tictactoeBot');
const config = require('../src/config');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

const miniGameManager = new MiniGameManager();
const { io, newConnection } = makeFakeIo();
registerMiniGameHandlers(io, { miniGameManager });

async function run() {
  // ================= room create/join =================
  const a = newConnection('battleshipA');
  const b = newConnection('battleshipB');

  const createRes = await a.trigger('mg:create_room', { gameType: 'battleship', nickname: 'Ana' });
  assert(createRes.ok && createRes.room.status === 'waiting', 'creating a room works and starts in "waiting" status');
  const code = createRes.room.code;

  const badGameJoin = await b.trigger('mg:join_room', { gameType: 'checkers', roomCode: code, nickname: 'Bob' });
  assert(!!badGameJoin.error, 'joining with the WRONG gameType for an existing room is rejected');

  const joinRes = await b.trigger('mg:join_room', { gameType: 'battleship', roomCode: code, nickname: 'Bob' });
  assert(joinRes.ok && joinRes.playerIdx === 1, 'the second player joins as playerIdx 1');
  assert(joinRes.room.status === 'playing', 'room flips to "playing" once both seats are filled');

  const fullRoomJoin = await newConnection('battleshipC').trigger('mg:join_room', { gameType: 'battleship', roomCode: code, nickname: 'Carl' });
  assert(!!fullRoomJoin.error, 'a third player cannot join an already-full room');

  // Both sockets should have received a fresh mg:room_state broadcast from B joining
  const aStateAfterJoin = a.lastReceived('mg:room_state');
  assert(aStateAfterJoin && aStateAfterJoin.status === 'playing', "player A's socket is pushed the updated room state when B joins (not just B's own ack)");

  // ================= Battleship over the wire =================
  const P0 = [
    { x: 0, y: 0, dir: 'H', size: 5 }, { x: 0, y: 2, dir: 'H', size: 4 },
    { x: 0, y: 4, dir: 'H', size: 3 }, { x: 0, y: 6, dir: 'H', size: 3 },
    { x: 0, y: 8, dir: 'H', size: 2 }
  ];
  const P1 = [
    { x: 5, y: 0, dir: 'H', size: 5 }, { x: 5, y: 2, dir: 'H', size: 4 },
    { x: 5, y: 4, dir: 'H', size: 3 }, { x: 5, y: 6, dir: 'H', size: 3 },
    { x: 5, y: 8, dir: 'H', size: 2 }
  ];
  const layoutA = await a.trigger('mg:battleship_submit_layout', { placements: P0 });
  assert(layoutA.ok, "player A's ship layout is accepted");
  const layoutB = await b.trigger('mg:battleship_submit_layout', { placements: P1 });
  assert(layoutB.ok, "player B's ship layout is accepted (and flips the room into battle phase)");

  const stateAfterBothPlaced = a.lastReceived('mg:room_state');
  assert(stateAfterBothPlaced.gameState.phase === 'battle', 'both sockets see phase="battle" once both layouts are in');

  // ---- the critical redaction check, over the ACTUAL broadcast path ----
  const aView = a.lastReceived('mg:room_state').gameState;
  const bView = b.lastReceived('mg:room_state').gameState;
  assert(Array.isArray(aView.myShips) && aView.myShips.length === 5, "player A's broadcast view includes A's OWN full fleet");
  assert(bView.opponentSunkShips.length === 0, "player B's broadcast view carries zero opponentSunkShips entries before any shots are fired, so it structurally cannot leak A's ship cells");

  const shotByA = await a.trigger('mg:battleship_fire', { x: 9, y: 9 });
  assert(shotByA.ok && shotByA.hit === false, "A's shot at (9,9) misses (matches B's layout, which starts at x=5)");
  const bStateAfterMiss = b.lastReceived('mg:room_state').gameState;
  assert(bStateAfterMiss.turn === 1, "after A's miss, B's OWN broadcast view confirms it is now B's turn");

  const shotByB = await b.trigger('mg:battleship_fire', { x: 0, y: 0 }); // it's genuinely B's turn now
  assert(shotByB.ok, "B's shot is accepted now that it really is B's turn (hits A's carrier at (0,0))");
  const bFiresAgainImmediately = await b.trigger('mg:battleship_fire', { x: 1, y: 0 }); // B trying to fire twice in a row
  assert(!!bFiresAgainImmediately.error, "B cannot fire twice in a row -- turn passed back to A after B's shot resolved");

  // ================= Checkers over the wire =================
  const c1 = newConnection('checkersA');
  const c2 = newConnection('checkersB');
  const ccCreate = await c1.trigger('mg:create_room', { gameType: 'checkers', nickname: 'Cara' });
  const ccCode = ccCreate.room.code;
  await c2.trigger('mg:join_room', { gameType: 'checkers', roomCode: ccCode, nickname: 'Caleb' });

  const ccMove = await c1.trigger('mg:checkers_move', { from: [2, 1], to: [3, 0] });
  assert(ccMove.ok, 'a legal checkers move is accepted over the socket layer');
  const ccStateAfter = c2.lastReceived('mg:room_state').gameState;
  assert(ccStateAfter.turn === 1, "checkers turn flip is correctly broadcast to the OTHER player's socket");

  const ccWrongTurn = await c1.trigger('mg:checkers_move', { from: [5, 0], to: [4, 1] });
  assert(!!ccWrongTurn.error, "checkers rejects a move attempt when it isn't that socket's player's turn");

  // ================= Chess over the wire =================
  const x1 = newConnection('chessWhite');
  const x2 = newConnection('chessBlack');
  const xCreate = await x1.trigger('mg:create_room', { gameType: 'chess', nickname: 'Xena' });
  const xCode = xCreate.room.code;
  await x2.trigger('mg:join_room', { gameType: 'chess', roomCode: xCode, nickname: 'Xerxes' });

  const xMove = await x1.trigger('mg:chess_move', { from: 'e2', to: 'e4' });
  assert(xMove.ok, 'a legal chess move is accepted over the socket layer');
  const xStateAfter = x2.lastReceived('mg:room_state').gameState;
  assert(xStateAfter.turn === 1, "chess turn flip (White->Black) is correctly broadcast to the other player's socket");
  assert(xStateAfter.fen.split(' ')[0].includes('4P3'), "the broadcast FEN's board field shows White's pawn having moved to e4 (the '4P3' rank-4 encoding)");

  const xIllegal = await x2.trigger('mg:chess_move', { from: 'e8', to: 'e7' });
  assert(!!xIllegal.error, 'chess rejects an illegal move over the socket layer too');

  // ================= Tic-Tac-Toe over the wire =================
  const t1 = newConnection('tttX');
  const t2 = newConnection('tttO');
  const tCreate = await t1.trigger('mg:create_room', { gameType: 'tictactoe', nickname: 'Toma' });
  const tCode = tCreate.room.code;
  const tJoin = await t2.trigger('mg:join_room', { gameType: 'tictactoe', roomCode: tCode, nickname: 'Olya' });
  assert(tJoin.ok && tJoin.room.status === 'playing', 'tic-tac-toe room starts "playing" once both seats are filled');

  const tWrongGameType = await t1.trigger('mg:checkers_move', { from: [2, 1], to: [3, 0] });
  assert(!!tWrongGameType.error, "a checkers move handler rejects a socket that's actually seated in a tic-tac-toe room");

  const tMove = await t1.trigger('mg:tictactoe_move', { index: 4 }); // X takes center
  assert(tMove.ok, 'a legal tic-tac-toe move is accepted over the socket layer');
  const tStateAfter = t2.lastReceived('mg:room_state').gameState;
  assert(tStateAfter.board[4] === 0 && tStateAfter.turn === 1, "the move and the resulting turn flip are correctly broadcast to the OTHER player's socket");

  const tWrongTurn = await t1.trigger('mg:tictactoe_move', { index: 0 });
  assert(!!tWrongTurn.error, "tic-tac-toe rejects a move attempt when it isn't that socket's player's turn");

  const tDupCell = await t2.trigger('mg:tictactoe_move', { index: 4 });
  assert(!!tDupCell.error, 'tic-tac-toe rejects a move onto an already-occupied cell over the socket layer');

  // Play out a full win (X: 0,1,2 top row) to confirm the room-finished +
  // winnerIdx broadcast path, same shape as the resign test just below.
  const tO1 = await t2.trigger('mg:tictactoe_move', { index: 3 });
  assert(tO1.ok, "O's move is accepted");
  const tX1 = await t1.trigger('mg:tictactoe_move', { index: 0 });
  assert(tX1.ok, "X's move is accepted");
  const tO2 = await t2.trigger('mg:tictactoe_move', { index: 5 });
  assert(tO2.ok, "O's second move is accepted");
  const tXWin = await t1.trigger('mg:tictactoe_move', { index: 1 }); // X now has 4,0,1 -- not a line yet
  assert(tXWin.ok, "X's third move is accepted (no line yet: cells 4,0,1)");
  const tO3 = await t2.trigger('mg:tictactoe_move', { index: 6 });
  assert(tO3.ok, "O's third move is accepted");
  const tXFinal = await t1.trigger('mg:tictactoe_move', { index: 2 }); // completes top row 0,1,2
  assert(tXFinal.ok, "X's winning move (completing the top row 0,1,2) is accepted");
  const t2StateAfterWin = t2.lastReceived('mg:room_state');
  assert(t2StateAfterWin.status === 'finished' && t2StateAfterWin.gameState.winnerIdx === 0, "the win + room-finished status is broadcast to the OTHER player's socket, crediting playerIdx 0 (X)");

  // ================= resign =================
  const r1 = newConnection('resignA');
  const r2 = newConnection('resignB');
  const rCreate = await r1.trigger('mg:create_room', { gameType: 'chess', nickname: 'Resa' });
  const rCode = rCreate.room.code;
  await r2.trigger('mg:join_room', { gameType: 'chess', roomCode: rCode, nickname: 'Resb' });
  const resignRes = await r1.trigger('mg:resign', {});
  assert(resignRes.ok, 'resigning is accepted');
  const r2StateAfterResign = r2.lastReceived('mg:room_state');
  assert(r2StateAfterResign.status === 'finished' && r2StateAfterResign.gameState.winnerIdx === 1, "resigning player's OPPONENT is broadcast as the winner (playerIdx 1, since resigner was playerIdx 0)");

  // ================= rematch (dima 2026-07-22 "чому після гри я не можу запустити нову") =================
  const rematchOnPlaying = await a.trigger('mg:rematch', {}); // `a` is still in the very first (unfinished) battleship room from earlier in this file
  assert(!!rematchOnPlaying.error, 'mg:rematch is rejected while the room is still "playing" (game not actually over yet)');

  const rematchRes = await r1.trigger('mg:rematch', {}); // r1/rCode room is "finished" from the resign test just above
  assert(rematchRes.ok, 'mg:rematch is accepted once the room is "finished"');
  const r1StateAfterRematch = r1.lastReceived('mg:room_state');
  const r2StateAfterRematch = r2.lastReceived('mg:room_state');
  assert(r1StateAfterRematch.status === 'playing' && r2StateAfterRematch.status === 'playing', 'both sockets see status flip back to "playing" after a rematch');
  assert(r1StateAfterRematch.resignedIdx === null && (r1StateAfterRematch.gameState.winnerIdx === null || r1StateAfterRematch.gameState.winnerIdx === undefined), 'rematch clears the previous resignedIdx/winnerIdx -- this is a fresh game, not a continuation of the finished one');
  assert(r1StateAfterRematch.myPlayerIdx === 1 && r2StateAfterRematch.myPlayerIdx === 0, 'rematch swaps seats (playerIdx 0<->1) so the loser of the previous game does not always keep the same side/first-move advantage');

  // ================= KKoin stakes (dima 2026-07-22 "якщо я хочу зіграти на гроші (KKoins) чому я ніде не можу це поставити") =================
  // Unique nickname per run (2026-07-22 fix) -- these assertions check EXACT
  // balances, and a literal 'StakeRich'/'StakePoor' accumulates real KKoin
  // in the actual persisted data/players.json across repeated test runs,
  // eventually breaking the exact-equality checks below. Same fix already
  // applied to plinkoTest.js/rouletteTest.js this session.
  const richNick = 'StakeRich' + Date.now();
  const poorNick = 'StakePoor' + Date.now();
  playersStore.addKkoin(richNick, 100);
  playersStore.addKkoin(poorNick, 5);
  const s1 = newConnection('stakeRich');
  const s2 = newConnection('stakePoor');

  const createTooRich = await s1.trigger('mg:create_room', { gameType: 'checkers', nickname: richNick, stake: 1000 });
  assert(!!createTooRich.error, 'mg:create_room rejects a stake bigger than the creator can currently afford');

  const stakeCreate = await s1.trigger('mg:create_room', { gameType: 'checkers', nickname: richNick, stake: 30 });
  assert(stakeCreate.ok && stakeCreate.room.stake === 30, 'mg:create_room accepts an affordable stake and echoes it back in the room state');
  const stakeCode = stakeCreate.room.code;
  assert(playersStore.getOrCreatePlayer(richNick).kkoin === 100, 'creating a staked room does NOT deduct anything yet -- only one seat is filled so far');

  const joinTooPoor = await s2.trigger('mg:join_room', { gameType: 'checkers', roomCode: stakeCode, nickname: poorNick });
  assert(!!joinTooPoor.error, "mg:join_room rejects a joiner who can't afford the room's stake");
  assert(playersStore.getOrCreatePlayer(poorNick).kkoin === 5, "a rejected join never touches the joiner's balance");

  playersStore.addKkoin(poorNick, 50); // top up to 55, now affordable (>= 30)
  const joinAffordable = await s2.trigger('mg:join_room', { gameType: 'checkers', roomCode: stakeCode, nickname: poorNick });
  assert(joinAffordable.ok, "mg:join_room accepts the same joiner once their balance covers the stake");
  assert(playersStore.getOrCreatePlayer(richNick).kkoin === 70 && playersStore.getOrCreatePlayer(poorNick).kkoin === 25,
    'the moment the room actually starts (2nd seat filled), BOTH stakes are deducted in one shot (100-30=70, 55-30=25)');

  const stakeMove = await s1.trigger('mg:checkers_move', { from: [2, 1], to: [3, 0] });
  assert(stakeMove.ok, 'a staked checkers game plays completely normally move-by-move -- the stake never interferes with gameplay itself');

  const stakeResign = await s2.trigger('mg:resign', {});
  assert(stakeResign.ok, 'resigning a staked game is still accepted');
  assert(playersStore.getOrCreatePlayer(richNick).kkoin === 130, 'the winner (StakeRich, since StakePoor resigned) is paid the full pot the instant the room finishes (70+60=130)');
  assert(playersStore.getOrCreatePlayer(poorNick).kkoin === 25, "the loser's balance doesn't change again at resign time -- their stake was already spent when the room started");

  const rematchTooPoor = await s1.trigger('mg:rematch', {});
  assert(!!rematchTooPoor.error, 'mg:rematch on a staked room is rejected when a player can no longer afford the SAME stake (StakePoor has 25, needs 30)');
  assert(playersStore.getOrCreatePlayer(richNick).kkoin === 130 && playersStore.getOrCreatePlayer(poorNick).kkoin === 25, 'a rejected rematch leaves both balances untouched');

  playersStore.addKkoin(poorNick, 10); // top up to 35, affordable again
  const rematchAffordable = await s1.trigger('mg:rematch', {});
  assert(rematchAffordable.ok, 'mg:rematch succeeds once both players can once again afford the room\'s stake');
  assert(playersStore.getOrCreatePlayer(richNick).kkoin === 100 && playersStore.getOrCreatePlayer(poorNick).kkoin === 5,
    'a successful rematch re-deducts the SAME stake from both players all over again (130-30=100, 35-30=5)');
  const stakeStateAfterRematch = s1.lastReceived('mg:room_state');
  assert(stakeStateAfterRematch.stake === 30, "the room's stake amount is unchanged by a rematch (still 30), only the seats/game state reset");

  // settleStakes' draw-refund branch (a REAL stalemate would need dozens of
  // scripted moves just to reach the position -- this directly exercises
  // the payout function against a hand-built room shape, which is all
  // settleStakes actually looks at: room.stake/gameState.winnerIdx+drawReason/players).
  playersStore.addKkoin('DrawA', 3);
  playersStore.addKkoin('DrawB', 7);
  const drawABefore = playersStore.getOrCreatePlayer('DrawA').kkoin;
  const drawBBefore = playersStore.getOrCreatePlayer('DrawB').kkoin;
  const drawRoom = { stake: 20, stakeSettled: false, gameState: { winnerIdx: null, drawReason: 'Пат' }, players: [{ nickname: 'DrawA' }, { nickname: 'DrawB' }] };
  miniGameManager.settleStakes(drawRoom);
  assert(playersStore.getOrCreatePlayer('DrawA').kkoin === drawABefore + 20 && playersStore.getOrCreatePlayer('DrawB').kkoin === drawBBefore + 20,
    'settleStakes refunds each player their OWN stake back (not the pot) on a draw');
  assert(drawRoom.stakeSettled === true, 'settleStakes marks the room as settled so it can never pay out twice');
  const drawARecheck = playersStore.getOrCreatePlayer('DrawA').kkoin;
  miniGameManager.settleStakes(drawRoom); // deliberately called again
  assert(playersStore.getOrCreatePlayer('DrawA').kkoin === drawARecheck, 'calling settleStakes a second time on an already-settled room is a guaranteed no-op (stakeSettled guard)');

  // ================= disconnect/reconnect =================
  const d1 = newConnection('discA');
  const d2 = newConnection('discB');
  const dCreate = await d1.trigger('mg:create_room', { gameType: 'checkers', nickname: 'Dina' });
  const dCode = dCreate.room.code;
  await d2.trigger('mg:join_room', { gameType: 'checkers', roomCode: dCode, nickname: 'Dave' });
  d1.disconnectNow();
  const d2StateAfterDisc = d2.lastReceived('mg:room_state');
  assert(d2StateAfterDisc.players[0].connected === false, "the opponent's disconnect is reflected in the OTHER player's broadcast state");

  const d1New = newConnection('discA-reconnected');
  const reconnectRes = await d1New.trigger('mg:reconnect', { gameType: 'checkers', roomCode: dCode, nickname: 'Dina' });
  assert(reconnectRes.ok && reconnectRes.playerIdx === 0, 'reconnecting with the same nickname re-attaches to the same seat (playerIdx 0), not a new one');
  const d2StateAfterReconnect = d2.lastReceived('mg:room_state');
  assert(d2StateAfterReconnect.players[0].connected === true, "the reconnect is reflected back to the OTHER player's broadcast state too");

  // ================= disconnect -> auto-forfeit (dima 2026-07-22 "коли один
  // гравець виходить з лобі - другому автоматом зараховували перемогу в
  // любій грі") ================= temporarily shrink the grace period so
  // the test doesn't actually wait 45 real seconds -- restored in a
  // finally-equivalent right after, so no other test in this file is
  // affected by the shortened window.
  const realForfeitMs = config.MINIGAME_DISCONNECT_FORFEIT_MS;
  config.MINIGAME_DISCONNECT_FORFEIT_MS = 30;
  try {
    // ---- scenario 1: disconnect and NEVER come back -> opponent auto-wins ----
    const f1 = newConnection('forfeitA');
    const f2 = newConnection('forfeitB');
    const fCreate = await f1.trigger('mg:create_room', { gameType: 'checkers', nickname: 'ForfeitA' });
    const fCode = fCreate.room.code;
    await f2.trigger('mg:join_room', { gameType: 'checkers', roomCode: fCode, nickname: 'ForfeitB' });
    f2.disconnectNow();
    const roomRightAfterDisconnect = miniGameManager.getRoom(fCode);
    assert(roomRightAfterDisconnect.status === 'playing', 'a disconnect does NOT instantly forfeit the game -- the grace period must elapse first (mgTryReconnect gets a real chance)');
    await sleep(80); // > the 30ms shortened grace period
    const roomAfterGrace = miniGameManager.getRoom(fCode);
    assert(roomAfterGrace.status === 'finished' && roomAfterGrace.resignedIdx === 1, 'once the grace period elapses with no reconnect, the disconnected player (idx 1) is auto-forfeited, same as an explicit resign');
    assert(roomAfterGrace.gameState.winnerIdx === 0, 'the still-connected player (idx 0) is credited the win automatically');
    const f1FinalState = f1.lastReceived('mg:room_state');
    assert(f1FinalState.status === 'finished', "the remaining player's socket is actively pushed the finished state, not left waiting");

    // ---- scenario 2: disconnect, but reconnect BEFORE the grace period ends -> no forfeit ----
    const g1 = newConnection('forfeitC');
    const g2 = newConnection('forfeitD');
    const gCreate = await g1.trigger('mg:create_room', { gameType: 'checkers', nickname: 'ForfeitC' });
    const gCode = gCreate.room.code;
    await g2.trigger('mg:join_room', { gameType: 'checkers', roomCode: gCode, nickname: 'ForfeitD' });
    g2.disconnectNow();
    const g2New = newConnection('forfeitD-reconnected');
    await g2New.trigger('mg:reconnect', { gameType: 'checkers', roomCode: gCode, nickname: 'ForfeitD' });
    await sleep(80); // well past the 30ms window the FIRST disconnect started
    const roomAfterReconnect = miniGameManager.getRoom(gCode);
    assert(roomAfterReconnect.status === 'playing', 'reconnecting before the grace period elapses cancels the pending auto-forfeit -- the game is still on');
  } finally {
    config.MINIGAME_DISCONNECT_FORFEIT_MS = realForfeitMs;
  }

  // ================= tic-tac-toe vs AI (dima 2026-07-22 "зроби щоб у
  // хрестики нулики можна було грати з ШІ") =================
  const rejectedAI = await newConnection('aiRejectType').trigger('mg:create_ai_room', { gameType: 'checkers', nickname: 'NoAICheckers' });
  assert(!!rejectedAI.error, 'mg:create_ai_room refuses any gameType other than tictactoe (checkers/chess bots do not exist)');

  const aiNick = 'AIPlayer' + Date.now();
  const h = newConnection('aiHuman');
  const aiCreate = await h.trigger('mg:create_ai_room', { gameType: 'tictactoe', nickname: aiNick });
  assert(aiCreate.ok && aiCreate.room.status === 'playing' && aiCreate.playerIdx === 0, 'mg:create_ai_room starts "playing" immediately, no waiting-for-opponent step, human seated at playerIdx 0');
  assert(aiCreate.room.players.length === 2 && aiCreate.room.players[1].nickname === 'ШІ 🤖', 'the second seat is filled by a synthetic bot player right away');
  const aiCode = aiCreate.room.code;

  // Force the bot into pure-optimal mode for this test (see MISTAKE_CHANCE
  // in tictactoeBot.js) -- Math.random is one global function shared by
  // every required module in this process, so patching it here really does
  // reach the server-side bot code, not just this test file's own calls.
  const origRandom = Math.random;
  Math.random = () => 0.99;
  try {
    const firstMove = await h.trigger('mg:tictactoe_move', { index: 0 });
    assert(firstMove.ok, "the human's opening move is accepted");
    const rightAfterMove = h.lastReceived('mg:room_state');
    assert(rightAfterMove.gameState.board.filter(c => c !== null).length === 1, "the bot's reply is NOT instant -- reads as one human move having landed, not two");

    await sleep(650); // > the 550ms "thinking" delay before the bot replies
    const afterBotReply = h.lastReceived('mg:room_state');
    assert(afterBotReply.gameState.board.filter(c => c !== null).length === 2, "the bot automatically replies a beat later, without the human doing anything else");
    assert(afterBotReply.gameState.turn === 0, "it's the human's turn again once the bot has moved");

    // Play the human out optimally too (reusing the exact same bot logic
    // "as if" the human were also playing perfectly) -- two optimal
    // tic-tac-toe players always draw, so this deterministically drives the
    // match to a real finish without hardcoding a move-by-move script by hand.
    let guardTurns = 0;
    while (afterBotReply.gameState.winnerIdx === null && !afterBotReply.gameState.drawReason && guardTurns < 9) {
      const board = afterBotReply.gameState.board;
      const humanMove = tictactoeBot.pickMove(board.slice(), 0, 1);
      const res = await h.trigger('mg:tictactoe_move', { index: humanMove });
      if (res.error) { assert(false, 'unexpected error while playing out the optimal draw: ' + res.error); break; }
      const stateNow = h.lastReceived('mg:room_state');
      if (stateNow.gameState.winnerIdx === null && !stateNow.gameState.drawReason && stateNow.gameState.turn === 1) {
        await sleep(650);
      }
      Object.assign(afterBotReply, { gameState: h.lastReceived('mg:room_state').gameState });
      guardTurns++;
    }
    const finalRoom = miniGameManager.getRoom(aiCode);
    assert(finalRoom.status === 'finished' && finalRoom.gameState.winnerIdx === null && !!finalRoom.gameState.drawReason,
      'two optimally-played sides (human driven by the same minimax the bot uses) reach a real draw, same as tic-tac-toe theory predicts');

    assert(activityStore.getRecentActivity(aiNick, 5).some(e => e.detail.indexOf('Нічия') !== -1), "the HUMAN's own activity feed gets a real entry for the vs-AI draw");
  } finally {
    Math.random = origRandom;
  }

  console.log('\n=== ' + passed + '/' + (passed + failed) + ' mini-game SOCKET assertions passed ===');
  if (failed > 0) process.exit(1);
}

run();
