// 2026-07-22: server startup is split into two stages so that
// remoteBackup.hydrateFromRemote() can finish restoring players.json/
// accounts.json/activity.json/usedThemes.json from Upstash BEFORE anything
// else runs. Every other require() below (routes, socket handlers, the
// various *Manager classes) is deliberately deferred into boot() rather
// than sitting at the top of the file, because several of them transitively
// touch playersStore/accountsStore, and those cache their file's contents
// in memory the FIRST time any exported function is called -- if that
// happened before hydration finished, it would cache the freshly-wiped-empty
// local file instead of the restored one, and no amount of hydrating after
// the fact would fix it (the in-memory cache would already have "won").
// require() is fine to call late like this -- Node caches modules by path
// regardless of when they're first required, so this is otherwise identical
// to the old top-of-file requires, just sequenced to run after hydration.
require('./src/state/remoteBackup').hydrateFromRemote().catch((err) => {
  console.warn('[server] unexpected error during hydrateFromRemote, continuing with local files:', err.message);
}).then(boot);

function boot() {
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./src/config');
const { buildAdminRouter } = require('./src/routes/adminRoutes');
const { buildProfileRouter } = require('./src/routes/profileRoutes');
const { buildAuthRouter } = require('./src/routes/authRoutes');
const { registerSocketHandlers } = require('./src/socket/socketHandlers');
const { registerMiniGameHandlers } = require('./src/socket/miniGameHandlers');
const { registerCasinoHandlers } = require('./src/socket/casinoHandlers');
const { RoomManager } = require('./src/state/roomManager');
const { MiniGameManager } = require('./src/state/miniGameManager');
const { BlackjackManager } = require('./src/state/blackjackManager');
const { BlackjackTableManager } = require('./src/state/blackjackTableManager');
const { RouletteTableManager } = require('./src/state/rouletteTableManager');
const { PlinkoManager } = require('./src/state/plinkoManager');
const adminAuth = require('./src/state/adminAuth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const roomManager = new RoomManager();
const miniGameManager = new MiniGameManager(); // Казино/Міні-ігри "глобальний проект" expansion -- separate from the quiz's RoomManager, see that file's header comment
const blackjackManager = new BlackjackManager(); // 1-гравець-проти-дилера казино-ігри -- окремо від miniGameManager's 2-людських-гравців кімнат, див. коментар у тому файлі
const blackjackTableManager = new BlackjackTableManager(); // 2026-07-22: спільний стіл на 2-6 гравців -- окремо і від blackjackManager (соло), і від miniGameManager (той хардкодить рівно 2 гравці), див. коментар у файлі
const rouletteTableManager = new RouletteTableManager(); // 2026-07-22: спільна рулетка на 2-6 гравців, той самий стіл-шаблон що й Блекджек-стіл, без черги ходів
const plinkoManager = new PlinkoManager(); // 2026-07-22: соло, без кімнати -- просто ставка/симуляція/виплата за один запит

app.use(express.json({ limit: '25mb' })); // raised from express' 100kb default -- profile avatar uploads are data: URLs, and "Закинь українізовану SiGame" pack uploads are base64-encoded .siq files (can embed images/audio)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/admin', buildAdminRouter());
app.use('/api/profile', buildProfileRouter(roomManager));
app.use('/api/auth', buildAuthRouter());

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

registerSocketHandlers(io, { roomManager, adminAuth });
registerMiniGameHandlers(io, { miniGameManager });
registerCasinoHandlers(io, { blackjackManager, blackjackTableManager, rouletteTableManager, plinkoManager });

// periodic cleanup of long-abandoned rooms so the process doesn't leak
// memory over a multi-day run
setInterval(() => roomManager.cleanupStale(), 30 * 60 * 1000);
setInterval(() => miniGameManager.cleanupStale(), 30 * 60 * 1000);
setInterval(() => blackjackTableManager.cleanupStale(), 30 * 60 * 1000);
setInterval(() => rouletteTableManager.cleanupStale(), 30 * 60 * 1000);

function localLanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

server.listen(config.PORT, '0.0.0.0', () => {
  console.log('');
  console.log('=======================================================');
  console.log('  DSLand запущено!');
  console.log('  На цьому комп’ютері: http://localhost:' + config.PORT);
  const lan = localLanAddresses();
  if (lan.length) {
    console.log('  Для друзів у тій самій wifi-мережі:');
    lan.forEach(ip => console.log('    http://' + ip + ':' + config.PORT));
  }
  console.log('  Адмін-панель:          /admin.html');
  console.log('  Дефолтний пароль адміна встановлюється в app/.env (ADMIN_PASSWORD)');
  console.log('  Бекап гравців/акаунтів у Upstash: ' + (require('./src/state/remoteBackup').ENABLED ? 'увімкнено' : 'вимкнено (див. README "Чому зникають акаунти на Render")'));
  console.log('=======================================================');
  console.log('');
});

} // end boot()
