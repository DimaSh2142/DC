// Player-facing account system ("Робимо систему реєстрації на сайті... щоб
// звичайні гравці могли створити акаунт", 2026-07-21). Deliberately layered
// ON TOP of the existing nickname-is-identity model (see playersStore.js
// header) rather than replacing it: an account's login IS the nickname
// (same lowercased-key convention as playersStore), so a registered
// player's stats/kkoin/avatar keep living in players.json exactly as
// before -- this file only adds an optional password + role on top of an
// identity that already exists. Having a password is entirely optional
// site-wide: the gate screen in profile.html still works with just a
// nickname, same as it always has (see profile.js).
//
// Passwords are hashed with Node's built-in crypto.scrypt (no new npm
// dependency, consistent with the rest of this project) with a random
// per-account salt -- never stored or logged in plaintext. This is a casual
// friend-group app (same trust model as everywhere else here), not a bank,
// so there is intentionally no password-reset flow yet; dima can fix a
// forgotten password by deleting that entry from data/accounts.json and
// re-registering.

const crypto = require('crypto');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const FILE = path.join(__dirname, '..', '..', 'data', 'accounts.json');
const SCRYPT_KEYLEN = 64;
const MIN_PASSWORD_LEN = 4;

// Seeded once, on first server start after this feature shipped (dima:
// "Щоб у адміна був зарання створений акаунт з логіном DimaSh і паролем
// 0987488844g!G") -- the ONLY account that gets role:'admin' out of the box;
// everyone who registers themselves afterwards gets role:'player'.
const SEED_ADMIN_LOGIN = 'DimaSh';
const SEED_ADMIN_PASSWORD = '0987488844g!G';

let cache = null;

function load() {
  if (cache === null) {
    cache = readJson(FILE, {});
    seedAdminIfMissing();
  }
  return cache;
}

function save() {
  writeJsonAtomic(FILE, cache);
}

function keyOf(login) {
  return String(login || '').trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
}

function seedAdminIfMissing() {
  const key = keyOf(SEED_ADMIN_LOGIN);
  if (cache[key]) return;
  const salt = crypto.randomBytes(16).toString('hex');
  cache[key] = {
    login: SEED_ADMIN_LOGIN,
    salt,
    hash: hashPassword(SEED_ADMIN_PASSWORD, salt),
    role: 'admin',
    createdAt: new Date().toISOString()
  };
  writeJsonAtomic(FILE, cache);
}

function accountExists(login) {
  const data = load();
  return !!data[keyOf(login)];
}

function getAccount(login) {
  const data = load();
  return data[keyOf(login)] || null;
}

/**
 * All registered accounts, salt/hash stripped (dima 2026-07-22: "адмін має
 * бачити всіх зареєстрованих на сайті, а не вводити нікнейм вручну" -- lets
 * the admin KKoin-grant panel render a real, clickable list instead of a
 * blind text field). Sorted by login so the list is stable/scannable.
 */
function listAccounts() {
  const data = load();
  return Object.values(data)
    .map((a) => ({ login: a.login, role: a.role, createdAt: a.createdAt }))
    .sort((x, y) => x.login.localeCompare(y.login, 'uk'));
}

/**
 * Registers a brand-new account. Rejects if the login is already taken
 * (case-insensitively, same as a nickname clash elsewhere in this app) --
 * callers should present that as "log in instead".
 */
function createAccount(login, password) {
  const trimmed = String(login || '').trim().slice(0, 24);
  if (!trimmed) return { error: 'Введіть нікнейм' };
  if (!password || String(password).length < MIN_PASSWORD_LEN) {
    return { error: 'Пароль має бути не коротшим за ' + MIN_PASSWORD_LEN + ' символи' };
  }
  const data = load();
  const key = keyOf(trimmed);
  if (data[key]) return { error: 'Цей нікнейм вже має акаунт — спробуй увійти паролем' };
  const salt = crypto.randomBytes(16).toString('hex');
  data[key] = {
    login: trimmed,
    salt,
    hash: hashPassword(password, salt),
    role: 'player',
    createdAt: new Date().toISOString()
  };
  save();
  return { account: data[key] };
}

/**
 * Verifies login+password. Returns the account record on success, or null if
 * the password is wrong. Callers that need to distinguish "no such account"
 * from "wrong password" should check accountExists() first -- unlike a
 * typical login form, that distinction isn't sensitive here (nicknames are
 * already public knowledge, visible to everyone in every lobby), and
 * profile.js's combined login/register flow relies on it to decide whether
 * to auto-register.
 */
function verifyLogin(login, password) {
  const account = getAccount(login);
  if (!account) return null;
  const candidateHash = hashPassword(password, account.salt);
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(account.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return account;
}

module.exports = { accountExists, getAccount, listAccounts, createAccount, verifyLogin, keyOf };
