// Server-side admin session verification. This is the actual security
// boundary -- admin-only Socket.IO events and REST routes check tokens
// issued here, so a player cannot reach privileged actions even by calling
// the raw socket events/REST API directly (not just "hidden" in the UI).

const crypto = require('crypto');
const config = require('../config');

// token -> { createdAt }
const activeTokens = new Map();

function login(password) {
  if (typeof password !== 'string' || password.length === 0) return null;
  if (password !== config.ADMIN_PASSWORD) return null;
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.set(token, { createdAt: Date.now() });
  return token;
}

function isValid(token) {
  if (!token || !activeTokens.has(token)) return false;
  const entry = activeTokens.get(token);
  if (Date.now() - entry.createdAt > config.ADMIN_TOKEN_TTL_MS) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

function revoke(token) {
  activeTokens.delete(token);
}

function expressMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.body && req.body.token);
  if (!isValid(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.adminToken = token;
  next();
}

module.exports = { login, isValid, revoke, expressMiddleware };
