// Real end-to-end smoke test: connects to an ACTUALLY RUNNING server
// process (not the fake harness) with real socket.io-client sockets, so it
// catches anything the fake-harness tests structurally can't -- real
// Socket.IO room semantics, Express static file serving of the new HTML/JS
// pages, and the real HTTP handshake. Usage: start the server, then run
// `node scripts/miniGameLiveSmokeTest.js` against it (see how the shell
// commands that invoke this script combine both steps in one call, since
// this sandbox can't see a server backgrounded in a previous call).
const { io: ioClient } = require('socket.io-client');
const http = require('http');

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function connect() {
  return ioClient(BASE, { transports: ['websocket'], reconnection: false, forceNew: true });
}
function emitAsync(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
function waitFor(socket, event, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

async function run() {
  // ---- static pages actually served ----
  for (const path of ['/minigames.html', '/battleship.html', '/checkers.html', '/chess.html', '/js/battleship.js', '/js/checkers.js', '/js/chess.js', '/js/minigame-common.js']) {
    const res = await httpGet(path);
    assert(res.status === 200, 'GET ' + path + ' returns 200 (was ' + res.status + ')');
  }

  // ---- Battleship: real sockets, full game to a win ----
  const a = connect(), b = connect();
  await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);

  const createRes = await emitAsync(a, 'mg:create_room', { gameType: 'battleship', nickname: 'LiveAna' });
  assert(createRes.ok, 'live server: create battleship room succeeds');
  const code = createRes.room.code;
  const bStatePromise = waitFor(b, 'mg:room_state');
  const joinRes = await emitAsync(b, 'mg:join_room', { gameType: 'battleship', roomCode: code, nickname: 'LiveBob' });
  assert(joinRes.ok && joinRes.room.status === 'playing', 'live server: second player joins and room starts playing');
  await bStatePromise;

  const P0 = [{ x: 0, y: 0, dir: 'H', size: 5 }, { x: 0, y: 2, dir: 'H', size: 4 }, { x: 0, y: 4, dir: 'H', size: 3 }, { x: 0, y: 6, dir: 'H', size: 3 }, { x: 0, y: 8, dir: 'H', size: 2 }];
  const P1 = [{ x: 5, y: 0, dir: 'H', size: 5 }, { x: 5, y: 2, dir: 'H', size: 4 }, { x: 5, y: 4, dir: 'H', size: 3 }, { x: 5, y: 6, dir: 'H', size: 3 }, { x: 5, y: 8, dir: 'H', size: 2 }];
  await emitAsync(a, 'mg:battleship_submit_layout', { placements: P0 });
  const battleStartPromise = waitFor(a, 'mg:room_state');
  await emitAsync(b, 'mg:battleship_submit_layout', { placements: P1 });
  const battleStartState = await battleStartPromise;
  assert(battleStartState.gameState.phase === 'battle', 'live server: both layouts submitted -> phase flips to battle, broadcast to A');

  const missRes = await emitAsync(a, 'mg:battleship_fire', { x: 9, y: 9 });
  assert(missRes.ok && missRes.hit === false, 'live server: a real shot resolves correctly (miss)');

  // ---- Chess: real sockets, one real move, verify FEN over the wire ----
  const x1 = connect(), x2 = connect();
  await Promise.all([waitFor(x1, 'connect'), waitFor(x2, 'connect')]);
  const xCreate = await emitAsync(x1, 'mg:create_room', { gameType: 'chess', nickname: 'LiveXena' });
  const x2StatePromise = waitFor(x2, 'mg:room_state');
  await emitAsync(x2, 'mg:join_room', { gameType: 'chess', roomCode: xCreate.room.code, nickname: 'LiveXerxes' });
  await x2StatePromise;
  const x2MovePromise = waitFor(x2, 'mg:room_state');
  const moveRes = await emitAsync(x1, 'mg:chess_move', { from: 'e2', to: 'e4' });
  assert(moveRes.ok, 'live server: a real chess move over an actual socket connection is accepted');
  const x2AfterMove = await x2MovePromise;
  assert(x2AfterMove.gameState.fen.split(' ')[0].includes('4P3'), "live server: Black's browser receives White's e4 move via a real broadcast");

  a.close(); b.close(); x1.close(); x2.close();

  console.log('\n=== ' + passed + '/' + (passed + failed) + ' LIVE server smoke assertions passed ===');
  if (failed > 0) process.exit(1);
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
