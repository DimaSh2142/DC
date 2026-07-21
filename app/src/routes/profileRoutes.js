// "Особистий кабінет" (personal cabinet) REST API -- deliberately plain
// HTTP, not sockets: this page is reachable from the homepage with no room
// context at all (you're not "in" anything when you open your profile), so
// there's no natural socket room to scope these calls to. Identity is the
// same nickname-is-the-key model as everywhere else in this app (see
// playersStore.js header) -- no password, just "type the nickname you play
// under". That's a deliberate continuation of the existing no-login design,
// not an oversight: adding real auth here would be a much bigger change than
// dima asked for, and nothing here is sensitive (no money leaves the site).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const playersStore = require('../state/playersStore');
const { normalizeAvatar } = require('../state/roomManager');

// Where "Закинь українізовану SiGame" uploads land -- dima reviews/imports
// these into themesBank.json by hand later (there's no automated .siq ->
// bank pipeline; building one is a much bigger project than this button).
// A tiny manifest tracks content hashes so re-submitting the exact same file
// can't farm KKoin twice; it is NOT trying to stop someone editing their own
// client to lie about the request body, matching the honor-system trust
// level of the rest of this friend-group app (see playersStore.advanceBubbleLevel).
const SUBMITTED_PACKS_DIR = path.join(__dirname, '..', '..', 'data', 'submittedPacks');
const MANIFEST_FILE = path.join(SUBMITTED_PACKS_DIR, 'manifest.json');
const MAX_PACK_BYTES = 20 * 1024 * 1024; // 20MB -- real .siq packs can embed images/audio

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveManifest(list) {
  fs.mkdirSync(SUBMITTED_PACKS_DIR, { recursive: true });
  const tmp = MANIFEST_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, MANIFEST_FILE);
}

function buildProfileRouter(roomManager) {
  const router = express.Router();

  router.get('/:nickname', (req, res) => {
    const nickname = String(req.params.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'Введіть нікнейм' });
    const profile = playersStore.getProfile(nickname);
    res.json({
      profile,
      locked: roomManager.isNicknameInActiveGame(nickname)
    });
  });

  // Rename and/or change avatar in one call -- both are blocked together by
  // the same "mid-game" guard, since both are "who am I" identity changes.
  router.patch('/:nickname', (req, res) => {
    const nickname = String(req.params.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'Введіть нікнейм' });
    if (roomManager.isNicknameInActiveGame(nickname)) {
      return res.status(409).json({ error: 'Не можна змінювати профіль під час активної гри' });
    }

    const body = req.body || {};
    let profile = playersStore.getProfile(nickname);
    let effectiveNickname = nickname;

    if (typeof body.nickname === 'string' && body.nickname.trim() && body.nickname.trim() !== nickname) {
      const renameRes = playersStore.renameNickname(nickname, body.nickname);
      if (renameRes.error) return res.status(409).json({ error: renameRes.error });
      profile = renameRes.profile;
      effectiveNickname = profile.nickname;
    }

    if ('avatar' in body) {
      const normalized = body.avatar ? normalizeAvatar(body.avatar) : null;
      if (body.avatar && !normalized) {
        return res.status(400).json({ error: 'Некоректне зображення (PNG/JPEG/WebP, невеликий розмір)' });
      }
      profile = playersStore.setAvatar(effectiveNickname, normalized);
    }

    res.json({ ok: true, profile });
  });

  // "Пройти міні-гру" -- Бульбашки (Bubble Spinner) reward: +BUBBLE_LEVEL_KKOIN_REWARD
  // KKoin and the player's persistent level advances by one, but only if the
  // level they say they just cleared matches what the server has on file
  // (see playersStore.advanceBubbleLevel's header comment for why).
  router.post('/:nickname/bubble-clear', (req, res) => {
    const nickname = String(req.params.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'Введіть нікнейм' });
    const level = (req.body || {}).level;
    const result = playersStore.advanceBubbleLevel(nickname, level, config.BUBBLE_LEVEL_KKOIN_REWARD);
    if (result.error) return res.status(409).json({ error: result.error, profile: result.profile });
    res.json({ ok: true, profile: result.profile, awarded: result.awarded });
  });

  // "Закинь українізовану SiGame - отримай 20 Крампус коїнів" -- client sends
  // the raw file as base64 (readFileAsBase64 in profile.js), we just store it
  // for dima to look at later and credit the coins immediately (see file
  // header comment for why this is trust-based, not admin-approval-gated).
  router.post('/:nickname/submit-pack', (req, res) => {
    const nickname = String(req.params.nickname || '').trim();
    if (!nickname) return res.status(400).json({ error: 'Введіть нікнейм' });

    const { filename, dataBase64 } = req.body || {};
    const trimmedFilename = String(filename || '').trim();
    if (!trimmedFilename || !dataBase64) return res.status(400).json({ error: 'Оберіть .siq файл' });
    if (!/\.siq$/i.test(trimmedFilename)) return res.status(400).json({ error: 'Очікується файл з розширенням .siq' });

    let buffer;
    try {
      buffer = Buffer.from(String(dataBase64), 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Не вдалося прочитати файл' });
    }
    if (!buffer.length) return res.status(400).json({ error: 'Файл порожній' });
    if (buffer.length > MAX_PACK_BYTES) return res.status(400).json({ error: 'Файл занадто великий (максимум 20 МБ)' });

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const manifest = loadManifest();
    if (manifest.some((m) => m.hash === hash)) {
      return res.status(409).json({ error: 'Цей файл вже надсилали раніше — коіни за нього вже нараховано' });
    }

    const safeName = trimmedFilename.replace(/[^a-zA-Zа-яА-ЯіїєІЇЄ0-9_.\-]/g, '_').slice(0, 80);
    const storedFilename = new Date().toISOString().replace(/[:.]/g, '-') + '__' + playersStore.keyOf(nickname) + '__' + safeName;
    fs.mkdirSync(SUBMITTED_PACKS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SUBMITTED_PACKS_DIR, storedFilename), buffer);

    manifest.push({ hash, nickname, filename: safeName, storedFilename, submittedAt: new Date().toISOString() });
    saveManifest(manifest);

    const profile = playersStore.addKkoin(nickname, config.SIQ_SUBMIT_KKOIN_REWARD);
    res.json({ ok: true, profile, awarded: config.SIQ_SUBMIT_KKOIN_REWARD });
  });

  return router;
}

module.exports = { buildProfileRouter };
