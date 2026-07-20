const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./src/config');
const { buildAdminRouter } = require('./src/routes/adminRoutes');
const { registerSocketHandlers } = require('./src/socket/socketHandlers');
const { RoomManager } = require('./src/state/roomManager');
const adminAuth = require('./src/state/adminAuth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/admin', buildAdminRouter());

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const roomManager = new RoomManager();
registerSocketHandlers(io, { roomManager, adminAuth });

// periodic cleanup of long-abandoned rooms so the process doesn't leak
// memory over a multi-day run
setInterval(() => roomManager.cleanupStale(), 30 * 60 * 1000);

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
  console.log('  DSGame запущено!');
  console.log('  На цьому комп’ютері: http://localhost:' + config.PORT);
  const lan = localLanAddresses();
  if (lan.length) {
    console.log('  Для друзів у тій самій wifi-мережі:');
    lan.forEach(ip => console.log('    http://' + ip + ':' + config.PORT));
  }
  console.log('  Адмін-панель:          /admin.html');
  console.log('  Дефолтний пароль адміна встановлюється в app/.env (ADMIN_PASSWORD)');
  console.log('=======================================================');
  console.log('');
});
