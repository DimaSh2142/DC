// Minimal dependency-free JSON file persistence with atomic writes
// (write to a temp file, then rename over the target) so a crash mid-write
// can't corrupt data/*.json.

const fs = require('fs');
const path = require('path');

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
}

module.exports = { readJson, writeJsonAtomic, ensureDir };
