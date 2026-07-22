// Optional durability backup for the handful of "runtime state" JSON files
// that .gitignore explicitly calls out as "recreated automatically on first
// run, not source": players.json, accounts.json, activity.json,
// usedThemes.json. 2026-07-22, dima: "коіни скидаються? ... зроби щоб
// акаунти не зникали" -- the ROOT CAUSE isn't a bug in how kkoin is tied to
// an account (that part was already correct -- see playersStore.js/
// accountsStore.js, both keyed by the same lowercased nickname). It's
// Render's free plan: no persistent disk is available on that tier, so the
// whole filesystem resets on every redeploy/restart/inactivity spin-down,
// and since the 4 files above are deliberately gitignored (they're PLAYER
// data, not source code -- committing them would mean every dima code push
// overwrites everyone's kkoin), a reset wipes them back to empty, leaving
// only accountsStore's hardcoded DimaSh admin reseed.
//
// This module mirrors those 4 files to a free Upstash Redis database over
// its plain-HTTPS REST API (https://upstash.com/docs/redis/features/restapi
// -- chosen specifically because it needs zero new npm dependency, just
// Node's built-in fetch, consistent with this project's "avoid adding
// dependencies where possible" habit elsewhere, e.g. accountsStore.js using
// crypto.scrypt instead of bcrypt). Two moves:
//   1. schedulePush(filePath, data) -- fired from jsonStore.writeJsonAtomic
//      right after every local (synchronous, unchanged) write. Fire-and-
//      forget: never awaited, never throws, worst case a failed push just
//      logs a warning and gets superseded by the NEXT write's push.
//   2. hydrateFromRemote() -- awaited ONCE at server startup, before
//      server.js requires any store/route module (see server.js). Pulls the
//      latest copy of all 4 keys back down to disk, undoing whatever the
//      ephemeral filesystem just wiped, BEFORE any store's lazy load() can
//      run and cache an empty/reseeded-only version.
//
// Deliberately safe to leave unconfigured: with UPSTASH_REDIS_REST_URL/
// UPSTASH_REDIS_REST_TOKEN both blank (the default -- same "blank = off"
// convention as every other optional secret in config.js), ENABLED is
// false and every function below is a same-tick no-op. Nothing about local
// dev, the LAN/tunnel setup in README.md, or a Render deploy that hasn't
// configured Upstash yet changes at all -- this is purely additive.

const path = require('path');
const config = require('../config');

const TRACKED_KEYS = {
  'players.json': 'dsland:players',
  'accounts.json': 'dsland:accounts',
  'activity.json': 'dsland:activity',
  'usedThemes.json': 'dsland:usedThemes',
  // 2026-07-22 "система репортів" (player ideas/complaints, admin-reviewed)
  // -- same reasoning as the other 4: a real player-submitted report lost to
  // a Render redeploy would be genuinely gone, not just regeneratable state.
  'reports.json': 'dsland:reports'
};

const REST_URL = (config.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REST_TOKEN = config.UPSTASH_REDIS_REST_TOKEN || '';
const ENABLED = !!(REST_URL && REST_TOKEN);
const TIMEOUT_MS = 8000;

function keyFor(filePath) {
  return TRACKED_KEYS[path.basename(filePath)] || null;
}

// Bare-bones fetch wrapper: Upstash's REST responses are always
// { result: ... } on success or { error: "..." } on failure (see docs) --
// never throws for a valid-but-unsuccessful command, only for network/
// timeout/JSON-parse problems, which callers here treat identically to
// "the remote is unavailable right now".
async function restRequest(urlPath, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(REST_URL + urlPath, Object.assign({
      headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
      signal: controller.signal
    }, opts));
    const json = await res.json();
    if (json && json.error) throw new Error(json.error);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function schedulePush(filePath, data) {
  if (!ENABLED) return;
  const key = keyFor(filePath);
  if (!key) return; // not one of the 4 tracked files (e.g. themesBank.json, which already lives in git and doesn't need this)
  const body = JSON.stringify(data);
  restRequest('/set/' + key, { method: 'POST', body })
    .catch((err) => console.warn('[remoteBackup] push to ' + key + ' failed, will retry on the next write to this file: ' + err.message));
}

async function hydrateFromRemote() {
  if (!ENABLED) {
    console.log('[remoteBackup] UPSTASH_REDIS_REST_URL/TOKEN not set -- running local-files-only, same as before this feature existed.');
    return;
  }
  const fs = require('fs');
  const entries = Object.entries(TRACKED_KEYS); // [ [filename, redisKey], ... ]
  let results;
  try {
    const pipeline = entries.map(([, redisKey]) => ['GET', redisKey]);
    const json = await restRequest('/pipeline', { method: 'POST', body: JSON.stringify(pipeline) });
    results = Array.isArray(json) ? json : [];
  } catch (err) {
    console.warn('[remoteBackup] hydrate request failed, continuing with whatever is on local disk: ' + err.message);
    return;
  }
  entries.forEach(([filename, redisKey], i) => {
    const item = results[i];
    if (!item || item.error || typeof item.result !== 'string') return; // key never set yet (fresh DB) -- leave local file/fallback as-is
    try {
      JSON.parse(item.result); // validate it's real JSON before trusting it over local data
    } catch (e) {
      console.warn('[remoteBackup] Upstash copy of ' + filename + ' (key ' + redisKey + ') was not valid JSON -- ignoring, keeping local');
      return;
    }
    const filePath = path.join(__dirname, '..', '..', 'data', filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, item.result, 'utf8');
    console.log('[remoteBackup] restored ' + filename + ' from Upstash (' + item.result.length + ' bytes)');
  });
}

module.exports = { hydrateFromRemote, schedulePush, ENABLED, TRACKED_KEYS };
