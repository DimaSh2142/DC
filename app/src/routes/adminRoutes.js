const express = require('express');
const adminAuth = require('../state/adminAuth');
const themeState = require('../state/themeState');

function buildAdminRouter() {
  const router = express.Router();

  router.post('/login', (req, res) => {
    const password = (req.body && req.body.password) || '';
    const token = adminAuth.login(password);
    if (!token) return res.status(401).json({ error: 'Невірний пароль' });
    res.json({ token });
  });

  router.post('/logout', adminAuth.expressMiddleware, (req, res) => {
    adminAuth.revoke(req.adminToken);
    res.json({ ok: true });
  });

  router.get('/bank-stats', adminAuth.expressMiddleware, (req, res) => {
    res.json(themeState.getBankStats());
  });

  return router;
}

module.exports = { buildAdminRouter };
