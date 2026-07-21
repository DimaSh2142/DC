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
