// Shared tiny helpers used by both player.js and admin.js.

function toast(message, isError) {
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
  if (activeModalLayer) { activeModalLayer.remove(); activeModalLayer = null; }
}

function openModal(title, bodyNodes) {
  closeModal();
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
