// Bearer-token sessions for the new player-facing accounts system (see
// accountsStore.js). Deliberately simple and in-memory only -- same spirit
// and the exact same token shape as the existing admin-panel auth
// (adminAuth.js's crypto.randomBytes(24).toString('hex')): if the server
// restarts, everyone just logs in again, the same tradeoff adminAuth.js
// already makes. Not cookies -- this app has no server-rendered pages or
// cookie infra, so the client holds the token itself (localStorage) and
// sends it back as `Authorization: Bearer <token>`, mirroring admin.js's
// existing localStorage-token pattern exactly.
const crypto = require('crypto');

// token -> { loginKey, login, role }
const sessions = new Map();

function createSession(account) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    loginKey: String(account.login || '').trim().toLowerCase(),
    login: account.login,
    role: account.role
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  return sessions.get(token) || null;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

/**
 * req.headers.authorization ("Bearer <token>") first, falling back to
 * req.body.token -- identical fallback order to adminAuth.js's own
 * expressMiddleware, for the same reason (lets a plain HTML form post
 * without needing to set a header).
 */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return (req.body && req.body.token) || null;
}

/**
 * Express middleware for routes any logged-in account may call. Attaches
 * req.authSession = { loginKey, login, role }.
 */
function requireSession(req, res, next) {
  const session = getSession(extractToken(req));
  if (!session) return res.status(401).json({ error: 'Не авторизовано' });
  req.authSession = session;
  next();
}

/**
 * Express middleware for admin-only routes (task: "щоб адмін у своєму
 * кабінеті міг видавати любому зареєстрованому гравцю Ккоїни"). This is the
 * real security boundary for that action -- the client hiding/showing a
 * button is cosmetic only, this check is what actually stops a non-admin
 * from calling the endpoint directly.
 */
function requireAdmin(req, res, next) {
  const session = getSession(extractToken(req));
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Доступно лише адміністратору' });
  req.authSession = session;
  next();
}

module.exports = { createSession, getSession, destroySession, extractToken, requireSession, requireAdmin };
