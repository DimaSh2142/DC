// Tests for src/state/remoteBackup.js -- the Upstash-backed durability
// layer added 2026-07-22 (see that file's header for the full "why").
// Same PASS/FAIL/assert style as scripts/plinkoTest.js.
//
// IMPORTANT: this test sets fake UPSTASH_REDIS_REST_URL/TOKEN env vars
// BEFORE requiring config/remoteBackup (both read process.env once, at
// require time), and monkey-patches global.fetch so no real network call
// or real Upstash account is ever touched. It also backs up and restores
// the 4 real app/data/*.json files around the hydrate test (which, by
// design, overwrites them) so running this script never corrupts your
// actual local dev data -- more caution than some of the other test
// scripts here take, but this one specifically simulates clobbering all 4
// files at once, so it's worth the extra care.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('PASS -', msg); }
  else { failed++; console.log('FAIL -', msg); }
}

// ================= disabled-by-default behaviour (the real config today) =================
(function testDisabledByDefault() {
  console.log('\n--- disabled when unconfigured (today\'s actual deployment state) ---');
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/state/remoteBackup')];
  const rb = require('../src/state/remoteBackup');
  assert(rb.ENABLED === false, 'ENABLED is false with no env vars set (matches the current real render.yaml -- Upstash not configured yet)');

  let fetchCalled = false;
  const realFetch = global.fetch;
  global.fetch = () => { fetchCalled = true; return Promise.reject(new Error('should never be called')); };
  try {
    rb.schedulePush('/some/path/players.json', { a: 1 });
    assert(!fetchCalled, 'schedulePush() never touches the network when disabled');
  } finally { global.fetch = realFetch; }
})();

// ================= enabled: schedulePush =================
(function testSchedulePush() {
  console.log('\n--- schedulePush (mocked fetch, no real Upstash account involved) ---');
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-test-db.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token-for-tests';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/state/remoteBackup')];
  const rb = require('../src/state/remoteBackup');
  assert(rb.ENABLED === true, 'ENABLED becomes true once both env vars are set');

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({ json: () => Promise.resolve({ result: 'OK' }) });
  };
  try {
    rb.schedulePush(path.join('some', 'dir', 'players.json'), { nick: { kkoin: 5 } });
    return new Promise((resolve) => setTimeout(resolve, 30)).then(() => {
      assert(calls.length === 1, 'a tracked file (players.json) triggers exactly one fetch call');
      assert(calls[0] && calls[0].url === 'https://fake-test-db.upstash.io/set/dsland:players', 'the request goes to /set/dsland:players -- the mapped Upstash key for players.json');
      assert(calls[0] && calls[0].opts.method === 'POST', 'the push uses POST (so the JSON body is not URL-length-limited, per Upstash REST API docs)');
      assert(calls[0] && JSON.parse(calls[0].opts.body).nick.kkoin === 5, 'the exact data object passed in is what gets serialized into the request body');

      calls.length = 0;
      rb.schedulePush(path.join('app', 'data', 'themesBank.json'), { huge: 'bank' });
      return new Promise((resolve) => setTimeout(resolve, 30)).then(() => {
        assert(calls.length === 0, 'an UNtracked file (themesBank.json -- already lives in git, not runtime state) triggers no fetch at all');
      });
    });
  } finally {
    global.fetch = realFetch;
  }
})()
// ================= enabled: hydrateFromRemote =================
.then(() => {
  console.log('\n--- hydrateFromRemote (mocked /pipeline response, real data/*.json backed up + restored) ---');
  const DATA_DIR = path.join(__dirname, '..', 'data');
  const TRACKED_FILES = ['players.json', 'accounts.json', 'activity.json', 'usedThemes.json'];
  const backups = {};
  TRACKED_FILES.forEach((f) => {
    const p = path.join(DATA_DIR, f);
    try { backups[f] = fs.readFileSync(p, 'utf8'); } catch (e) { backups[f] = null; } // null = file didn't exist before this test
  });

  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-test-db.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token-for-tests';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/state/remoteBackup')];
  const rb = require('../src/state/remoteBackup');

  const fakeRemotePlayers = JSON.stringify({ restoredplayer: { nickname: 'restoredplayer', kkoin: 777 } });
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    assert(url === 'https://fake-test-db.upstash.io/pipeline', 'hydrateFromRemote hits the /pipeline endpoint (one round trip for all 4 keys, not 4 separate GETs)');
    const cmds = JSON.parse(opts.body);
    assert(cmds.length === 4 && cmds.every((c) => c[0] === 'GET'), 'the pipeline body is exactly 4 GET commands, one per tracked key');
    // Simulate: players has real data, accounts/activity/usedThemes were
    // never written to Upstash yet (fresh DB) -- realistic "some keys
    // populated, some not" mixed response.
    return Promise.resolve({
      json: () => Promise.resolve([
        { result: fakeRemotePlayers },
        { result: null },
        { result: null },
        { result: null }
      ])
    });
  };

  return rb.hydrateFromRemote().then(() => {
    global.fetch = realFetch;
    const restored = fs.readFileSync(path.join(DATA_DIR, 'players.json'), 'utf8');
    assert(restored === fakeRemotePlayers, 'players.json on disk now contains exactly the "remote" content from the mocked pipeline response');
    assert(JSON.parse(restored).restoredplayer.kkoin === 777, 'and it parses back to the expected object -- this is the actual anti-data-loss mechanism working end to end');

    const accountsStillThere = fs.existsSync(path.join(DATA_DIR, 'accounts.json'));
    assert(accountsStillThere === (backups['accounts.json'] !== null), 'accounts.json (whose mocked remote result was null, i.e. "never backed up yet") is left untouched rather than being deleted or blanked');
  }).finally(() => {
    // restore whatever was really on disk before this test touched anything
    TRACKED_FILES.forEach((f) => {
      const p = path.join(DATA_DIR, f);
      if (backups[f] === null) { try { fs.unlinkSync(p); } catch (e) {} }
      else fs.writeFileSync(p, backups[f], 'utf8');
    });
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
})
// ================= enabled but Upstash unreachable: never throws =================
.then(() => {
  console.log('\n--- graceful failure when Upstash is unreachable ---');
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-test-db.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token-for-tests';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/state/remoteBackup')];
  const rb = require('../src/state/remoteBackup');

  const realFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error('simulated network failure'));
  return rb.hydrateFromRemote().then(() => {
    assert(true, 'hydrateFromRemote() resolves (does not throw/reject) even when the network call fails -- a flaky Upstash can never crash server startup');
  }).catch(() => {
    assert(false, 'hydrateFromRemote() resolves (does not throw/reject) even when the network call fails -- a flaky Upstash can never crash server startup');
  }).then(() => {
    let pushThrew = false;
    try { rb.schedulePush(path.join('x', 'players.json'), {}); } catch (e) { pushThrew = true; }
    assert(!pushThrew, 'schedulePush() never throws synchronously even when the eventual network call will fail (it is fire-and-forget)');
  }).finally(() => {
    global.fetch = realFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
})
.then(() => {
  console.log('\n=== ' + passed + '/' + (passed + failed) + ' remoteBackup assertions passed ===');
  if (failed > 0) process.exit(1);
})
.catch((err) => {
  console.error('remoteBackupTest crashed:', err);
  process.exit(1);
});
