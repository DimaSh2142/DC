// Shared tiny helpers used by both player.js and admin.js.

// ---- site-wide personal settings ("Особистий кабінет" -> Налаштування, added
// 2026-07-21) -- pure client-side presentation prefs, deliberately NOT sent
// to the server (unlike nickname/avatar/kkoin in playersStore, these aren't
// "who you are", just "how loud/which theme on THIS device"). Read by every
// page via common.js (loaded before player.js/admin.js/profile.js on all of
// them) so a setting changed once in the profile page applies everywhere.
const SETTINGS_KEYS = {
  theme: 'sigame_theme',              // 'light' | 'dark'
  musicVolume: 'sigame_music_volume', // 0-100, applied to admin/team YouTube players
  micVolume: 'sigame_mic_volume'      // 0-100, applied to OTHER participants' voice-chat audio playback
};

function getTheme() { return localStorage.getItem(SETTINGS_KEYS.theme) === 'dark' ? 'dark' : 'light'; }
function setTheme(theme) {
  localStorage.setItem(SETTINGS_KEYS.theme, theme === 'dark' ? 'dark' : 'light');
  applyTheme();
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', getTheme());
}
// Runs the instant this script is parsed (common.js is loaded before the
// page's own content/scripts on every page) -- avoids a flash of the light
// theme before a later DOMContentLoaded handler would otherwise fix it.
applyTheme();

function clampPercent(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
}
function getMusicVolume() { return clampPercent(localStorage.getItem(SETTINGS_KEYS.musicVolume), 80); }
function setMusicVolume(v) { localStorage.setItem(SETTINGS_KEYS.musicVolume, String(clampPercent(v, 80))); }
function getMicVolume() { return clampPercent(localStorage.getItem(SETTINGS_KEYS.micVolume), 100); }
function setMicVolume(v) { localStorage.setItem(SETTINGS_KEYS.micVolume, String(clampPercent(v, 100))); }

// ---- site accounts (2026-07-21 "система реєстрації/логін" expansion) ----
// Layered on top of the existing nickname-is-identity model (see
// playersStore.js) -- an account's login IS the nickname, and this is just
// an optional token+role remembered client-side after a successful
// login/registration in Особистий кабінет (see profile.js). Read by quiz.js
// (to decide whether to show the "Адмін-панель" button) and profile.js (to
// decide whether to show the admin-only "видати ККоїни" panel). NOT itself a
// security boundary -- the server independently re-checks the token/role on
// every protected request (see authSessions.js's requireAdmin), so worst
// case a stale/tampered value here just shows or hides a button wrongly for
// a moment; it can never grant real access on its own.
const AUTH_KEY = 'sigame_auth';
function getAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function setAuth(auth) { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); }
function clearAuth() { localStorage.removeItem(AUTH_KEY); }

// ---- sound effects (2026-07-21, dima: "Можеш і звукові ефекти добавити" +
// uploaded JDSherbert Sci-Fi UI / Tabletop Games SFX packs -- both marked
// "FREE" by the author, see README.md's asset-attribution note for why there
// is no more precise license string than that). A handful of short,
// purposeful cues wired into shared functions here (toast/openModal/
// closeModal) so every page that already calls those gets sound for free,
// plus a few explicit calls in player.js/checkers.js/chess.js/battleship.js/
// bubbles.js for moments those shared helpers don't cover (correct/wrong
// answer, piece capture, round transitions). Deliberately NOT wired to every
// single click/hover -- that gets old fast in an app people reopen daily.
const SFX_FILES = {
  select: '/audio/sfx/select.mp3',       // correct answer, level clear, success toasts
  wrong: '/audio/sfx/wrong.mp3',         // wrong answer, error toasts
  popupOpen: '/audio/sfx/popup-open.mp3',
  popupClose: '/audio/sfx/popup-close.mp3',
  swipe: '/audio/sfx/swipe.mp3',         // round-transition banner
  move: '/audio/sfx/move.mp3',           // checkers/chess move, battleship miss
  impact: '/audio/sfx/impact.mp3'        // checkers/chess capture, battleship hit, bubble pop
};
// A fresh Audio() per play (rather than one shared, reused element) so two
// sounds fired in quick succession (e.g. a toast right as a modal opens)
// don't cut each other off. Scaled off the existing music-volume setting --
// someone who already turned background music down low clearly prefers a
// quieter app, so SFX should follow that same preference rather than adding
// yet another volume slider for a handful of short blips.
function playSfx(name) {
  const src = SFX_FILES[name];
  if (!src) return;
  try {
    const audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(1, getMusicVolume() / 100)) * 0.6;
    audio.play().catch(() => {}); // browser autoplay policy may reject before any user gesture -- fine, just skip
  } catch (e) { /* SFX are a nice-to-have, never worth breaking the app over */ }
}

function toast(message, isError) {
  playSfx(isError ? 'wrong' : 'select');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function el(tag, opts, children) {
  const node = document.createElement(tag);
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      // Skip null/undefined entirely -- e.g. `disabled: cond ? 'disabled' : null`
      // must NOT set the attribute at all when falsy, because HTML treats the
      // mere *presence* of `disabled="null"` as disabled=true.
      if (v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
  }
  (children || []).forEach(c => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// Shared avatar renderer: a small circular photo if the player has one, or a
// colored circle with their first initial as a fallback. Used by both the
// player roster (lobby) and the admin roster panel so people can tell
// players apart at a glance instead of reading nickname text one by one.
function avatarEl(player, size) {
  size = size || 32;
  const base = 'width:' + size + 'px; height:' + size + 'px; border-radius:50%; flex:none; vertical-align:middle;';
  if (player && player.avatar) {
    return el('img', { src: player.avatar, alt: '', class: 'avatar-circle', style: base + ' object-fit:cover;' });
  }
  const nickname = (player && player.nickname) || '';
  const initial = nickname.trim().charAt(0).toUpperCase() || '?';
  return el('div', {
    class: 'avatar-circle avatar-fallback',
    style: base + ' display:flex; align-items:center; justify-content:center; font-weight:800; font-size:' + Math.max(10, Math.round(size * 0.42)) + 'px;'
  }, [initial]);
}

// ---- generic modal (used by the "how does this work" theme popover in
// player.js and the "random fact" button) ----
// Appended directly to document.body (like toast()/confettiBurst()) rather
// than threaded through the app's render() tree, so it survives independent
// of whatever render() cycle happens to be active. Only one instance can be
// open at a time -- opening a new one closes any previous one first, so
// rapid double-clicks can never stack two backdrops (which would otherwise
// leave a leftover invisible click-blocking layer, the exact class of bug
// dima asked us to guard against).
let activeModalLayer = null;

function closeModal() {
  if (activeModalLayer) { activeModalLayer.remove(); activeModalLayer = null; playSfx('popupClose'); }
}

function openModal(title, bodyNodes) {
  closeModal();
  playSfx('popupOpen');
  const card = el('div', { class: 'modal-card', onclick: (e) => e.stopPropagation() }, [
    el('div', { class: 'row between', style: 'align-items:flex-start;' }, [
      el('h3', { style: 'margin:0;' }, [title]),
      el('button', { type: 'button', class: 'btn-small btn-outline modal-close', onclick: closeModal }, ['✕'])
    ]),
    el('div', { class: 'modal-body' }, bodyNodes)
  ]);
  const backdrop = el('div', { class: 'modal-backdrop', onclick: closeModal }, [card]);
  document.body.appendChild(backdrop);
  activeModalLayer = backdrop;
}

// ---- round-transition banner (player + admin both call this) ----
// A brief, unmissable "Round N done, starting Round N+1" overlay. Deliberately
// pointer-events:none on the whole layer so it can NEVER intercept a click
// even while animating out -- it self-removes on a timer, not on click.
let roundBannerHandle = null;
function showRoundBanner(title, subtitle) {
  playSfx('swipe');
  if (roundBannerHandle) { clearTimeout(roundBannerHandle.timeout); roundBannerHandle.layer.remove(); }
  const layer = el('div', { class: 'round-banner-layer' }, [
    el('div', { class: 'round-banner-card' }, [
      el('div', { class: 'title' }, [title]),
      subtitle ? el('div', { class: 'subtitle' }, [subtitle]) : null
    ])
  ]);
  document.body.appendChild(layer);
  const timeout = setTimeout(() => { layer.remove(); if (roundBannerHandle && roundBannerHandle.layer === layer) roundBannerHandle = null; }, 4000);
  roundBannerHandle = { layer, timeout };
}

// ---- shared YouTube background-music helpers (admin panel + team panel) ----
// Both admin.js (host music) and player.js (per-team music) run their own
// completely independent YT.Player instance in their own browser tab/device
// -- by design there is no cross-device sync (see admin.js's own caption:
// music plays from whichever device opened it, never streamed over the
// socket). Only this parsing/bootstrap/formatting logic is actually shared.

function extractYouTubeId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

function ensureYouTubeApi(cb) {
  if (window.YT && window.YT.Player) return cb();
  if (!document.getElementById('yt-iframe-api-script')) {
    const tag = document.createElement('script');
    tag.id = 'yt-iframe-api-script';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }
  const prevReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => { if (prevReady) { try { prevReady(); } catch (e) {} } cb(); };
}

function formatPlayTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// Polls a YT.Player (via getPlayer(), so the caller can swap the underlying
// instance freely) and keeps a progress bar fill + "m:ss / m:ss" label
// updated -- looked up fresh by id every tick (same resilience pattern as
// admin.js's startAdminTimer/player.js's startTimer) so it survives the
// frequent full re-renders triggered by room:state broadcasts. One ticker
// runs per caller (admin has its own, each player tab has its own).
function startMusicProgressTicker(getPlayer, fillId, labelId) {
  return setInterval(() => {
    const player = getPlayer();
    const fill = document.getElementById(fillId);
    const label = document.getElementById(labelId);
    if (!fill || !label) return;
    if (!player || typeof player.getDuration !== 'function') { label.textContent = '0:00 / 0:00'; fill.style.width = '0%'; return; }
    let dur = 0, cur = 0;
    try { dur = player.getDuration() || 0; cur = player.getCurrentTime() || 0; } catch (e) { return; } // not ready yet
    fill.style.width = (dur > 0 ? Math.min(100, Math.round((cur / dur) * 100)) : 0) + '%';
    label.textContent = formatPlayTime(cur) + ' / ' + formatPlayTime(dur);
  }, 500);
}

// Lightweight dependency-free confetti burst, palette colors only.
// Used on correct answers and at game end (see player.js).
function confettiBurst(count) {
  const colors = ['#17B8A6', '#D7263D', '#F2994A', '#FFFFFF'];
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  document.body.appendChild(layer);
  const n = count || 60;
  for (let i = 0; i < n; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = (Math.random() * 100) + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (1.8 + Math.random() * 1.6) + 's';
    piece.style.animationDelay = (Math.random() * 0.35) + 's';
    piece.style.setProperty('--rot', (Math.random() * 480 - 240) + 'deg');
    piece.style.setProperty('--drift', (Math.random() * 140 - 70) + 'px');
    if (Math.random() > 0.5) piece.style.borderRadius = '50%';
    layer.appendChild(piece);
  }
  setTimeout(() => layer.remove(), 4200);
}
