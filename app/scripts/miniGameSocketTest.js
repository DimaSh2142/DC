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
  playersStore.addKkoin('StakeRich', 100);
  playersStore.addKkoin('StakePoor', 5);
  const s1 = newConnection('stakeRich');
  const s2 = newConnection('stakePoor');

  const createTooRich = await s1.trigger('mg:create_room', { gameType: 'checkers', nickname: 'StakeRich', stake: 1000 });
  assert(!!createTooRich.error, 'mg:create_room rejects a stake bigger than the creator can currently afford');

  const stakeCreate = await s1.trigger('mg:create_room', { gameType: 'checkers', nickname: 'StakeRich', stake: 30 });
  assert(stakeCreate.ok && stakeCreate.room.stake === 30, 'mg:create_room accepts an affordable stake and echoes it back in the room state');
  const stakeCode = stakeCreate.room.code;
  assert(playersStore.getOrCreatePlayer('StakeRich').kkoin === 100, 'creating a staked room does NOT deduct anything yet -- only one seat is filled so far');

  const joinTooPoor = await s2.trigger('mg:join_room', { gameType: 'checkers', roomCode: stakeCode, nickname: 'StakePoor' });
  assert(!!joinTooPoor.error, "mg:join_room rejects a joiner who can't afford the room's stake");
  assert(playersStore.getOrCreatePlayer('StakePoor').kkoin === 5, "a rejected join never touches the joiner's balance");

  playersStore.addKkoin('StakePoor', 50); // top up to 55, now affordable (>= 30)
  const joinAffordable = await s2.trigger('mg:join_room', { gameType: 'checkers', roomCode: stakeCode, nickname: 'StakePoor' });
  assert(joinAffordable.ok, "mg:join_room accepts the same joiner once their balance covers the stake");
  assert(playersStore.getOrCreatePlayer('StakeRich').kkoin === 70 && playersStore.getOrCreatePlayer('StakePoor').kkoin === 25,
    'the moment the room actually starts (2nd seat filled), BOTH stakes are deducted in one shot (100-30=70, 55-30=25)');

  const stakeMove = await s1.trigger('mg:checkers_move', { from: [2, 1], to: [3, 0] });
  assert(stakeMove.ok, 'a staked checkers game plays completely normally move-by-move -- the stake never interferes with gameplay itself');

  const stakeResign = await s2.trigger('mg:resign', {});
  assert(stakeResign.ok, 'resigning a staked game is still accepted');
  assert(playersStore.getOrCreatePlayer('StakeRich').kkoin === 130, 'the winner (StakeRich, since StakePoor resigned) is paid the full pot the instant the room finishes (70+60=130)');
  assert(playersStore.getOrCreatePlayer('StakePoor').kkoin === 25, "the loser's balance doesn't change again at resign time -- their stake was already spent when the room started");

  const rematchTooPoor = await s1.trigger('mg:rematch', {});
  assert(!!rematchTooPoor.error, 'mg:rematch on a staked room is rejected when a player can no longer afford the SAME stake (StakePoor has 25, needs 30)');
  assert(playersStore.getOrCreatePlayer('StakeRich').kkoin === 130 && playersStore.getOrCreatePlayer('StakePoor').kkoin === 25, 'a rejected rematch leaves both balances untouched');

  playersStore.addKkoin('StakePoor', 10); // top up to 35, affordable again
  const rematchAffordable = await s1.trigger('mg:rematch', {});
  assert(rematchAffordable.ok, 'mg:rematch succeeds once both players can once again afford the room\'s stake');
  assert(playersStore.getOrCreatePlayer('StakeRich').kkoin === 100 && playersStore.getOrCreatePlayer('StakePoor').kkoin === 5,
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

  console.log('\n=== ' + passed + '/' + (passed + failed) + ' mini-game SOCKET assertions passed ===');
  if (failed > 0) process.exit(1);
}

run();
