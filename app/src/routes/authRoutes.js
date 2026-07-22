// Player-facing account REST API (2026-07-21 "система реєстрації/логін"
// expansion) -- mounted at /api/auth, separate from /api/admin (adminRoutes,
// the pre-existing single-shared-password gate for the room-running
// dashboard, which this does NOT touch or replace) and /api/profile
// (nickname-only stats/avatar, still fully usable without ever creating an
// account -- see that file's own header comment for why password-less
// identity is a deliberate, unchanged feature, not an oversight).
//
// See accountsStore.js and authSessions.js for the storage/session pieces
// this just wires up over HTTP.

const express = require('express');
const accountsStore = require('../state/accountsStore');
const authSessions = require('../state/authSessions');
const playersStore = require('../state/playersStore');

function buildAuthRouter() {
  const router = express.Router();

  router.post('/register', (req, res) => {
    const { login, password } = req.body || {};
    const result = accountsStore.createAccount(login, password);
    if (result.error) return res.status(400).json({ error: result.error });
    const token = authSessions.createSession(result.account);
    res.json({ token, login: result.account.login, role: result.account.role });
  });

  // Split into two failure modes on purpose (see accountsStore.verifyLogin's
  // header comment) -- profile.js's gate form uses ACCOUNT_NOT_FOUND to
  // decide "this nickname has no account yet, create one with the password
  // just typed" instead of showing a dead-end error.
  router.post('/login', (req, res) => {
    const { login, password } = req.body || {};
    if (!accountsStore.accountExists(login)) {
      return res.status(404).json({ error: 'Акаунту з таким нікнеймом ще немає', code: 'ACCOUNT_NOT_FOUND' });
    }
    const account = accountsStore.verifyLogin(login, password);
    if (!account) return res.status(401).json({ error: 'Невірний пароль', code: 'BAD_PASSWORD' });
    const token = authSessions.createSession(account);
    res.json({ token, login: account.login, role: account.role });
  });

  router.post('/logout', (req, res) => {
    authSessions.destroySession(authSessions.extractToken(req));
    res.json({ ok: true });
  });

  router.get('/me', authSessions.requireSession, (req, res) => {
    res.json({ login: req.authSession.login, role: req.authSession.role });
  });

  // "Щоб адмін у своєму кабінеті міг видавати любому зареєстрованому гравцю
  // Ккоїни" -- reuses the same addKkoin() primitive the quiz win-payout and
  // the KKoin earn-menu already use, just gated to admin-role accounts
  // instead of "the player themselves, about themselves".
  // "Адмін має бачити всіх зареєстрованих гравців списком і просто тиснути
  // на когось, а не вводити нікнейм вручну" (dima 2026-07-22) -- feeds the
  // grant-kkoin panel's searchable player list in profile.js. Admin-only,
  // same guard as grant-kkoin itself; joins the account list with each
  // player's live kkoin/avatar so the list is actually useful to scan.
  router.get('/admin/players', authSessions.requireAdmin, (req, res) => {
    const players = accountsStore.listAccounts().map((account) => {
      const profile = playersStore.getOrCreatePlayer(account.login);
      return {
        login: account.login,
        role: account.role,
        avatar: profile.avatar || null,
        kkoin: profile.kkoin || 0,
        gamesPlayed: profile.gamesPlayed || 0
      };
    });
    res.json({ players });
  });

  router.post('/grant-kkoin', authSessions.requireAdmin, (req, res) => {
    const { nickname, amount } = req.body || {};
    const trimmed = String(nickname || '').trim();
    const n = Number(amount);
    if (!trimmed) return res.status(400).json({ error: 'Вкажіть нікнейм гравця' });
    if (!Number.isFinite(n) || n === 0) return res.status(400).json({ error: 'Вкажіть ненульову кількість KKrampus coin' });
    const profile = playersStore.addKkoin(trimmed, n);
    res.json({ ok: true, profile });
  });

  return router;
}

module.exports = { buildAuthRouter };
