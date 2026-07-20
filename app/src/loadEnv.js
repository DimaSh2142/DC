// Tiny zero-dependency .env loader (avoids needing the `dotenv` package at
// all, which also sidesteps npm-install flakiness for such a small need).
// Parses simple KEY=VALUE lines, ignores comments/blank lines, does not
// overwrite variables already set in the real process environment.

const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  const file = envPath || path.join(__dirname, '..', '.env');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return; // no .env file -- fine, rely on real env vars / defaults
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

module.exports = { loadEnv };
