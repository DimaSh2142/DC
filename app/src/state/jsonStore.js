// Minimal dependency-free JSON file persistence with atomic writes
// (write to a temp file, then rename over the target) so a crash mid-write
// can't corrupt data/*.json.
//
// 2026-07-22: every write also fires an async, best-effort backup to Upstash
// Redis via remoteBackup.schedulePush (see that file's header for the full
// "why" -- short version: Render's free plan wipes local disk on
// restart/redeploy, this is the fix). remoteBackup.js filters to only the 4
// files that actually need it and is a total no-op if unconfigured, so this
// one extra line is safe for every caller of writeJsonAtomic, not just the
// tracked ones.

const fs = require('fs');
const path = require('path');
const remoteBackup = require('./remoteBackup');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    console.error('[jsonStore] Failed to read/parse', filePath, '-', e.message, '- using fallback.');
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(filePath);
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  remoteBackup.schedulePush(filePath, data); // fire-and-forget, no-op unless Upstash is configured
}

module.exports = { readJson, writeJsonAtomic, ensureDir };
