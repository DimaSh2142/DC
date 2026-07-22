// Lightweight sprite-sheet effect player for the "Super Pixel Effects
// Gigapack (Free Version) v2.7.0" pack dima uploaded 2026-07-22 (Will Tice /
// unTied Games -- credited in README.md's asset-attribution note per the
// pack's license). Sprite sheets + manifest.json are pre-packed by
// scripts/buildEffectSprites.py (one horizontal strip PNG per effect, frame
// count/size baked into manifest.json) -- this file fetches that manifest
// once, builds a matching @keyframes rule per effect (steps() timing so the
// browser's compositor drives the animation instead of a JS setInterval
// nudging inline styles every frame), and exposes one function:
//
//   playEffect('coin-burst', anchorElement)
//
// Spawns the animation position:fixed, centered over anchorElement's
// CURRENT on-screen position (getBoundingClientRect -- works regardless of
// whatever positioning scheme the calling page uses), then removes itself
// once the animation finishes. See each game's own client file for where
// these are actually wired in (win/loss/capture moments only -- same
// "don't wear out the novelty" restraint common.js's playSfx already
// applies to sound effects, this is not fired on every minor action).
//
// Loaded on every page alongside common.js (harmless/no-op on pages that
// never call playEffect -- the manifest fetch is the only page-load cost,
// and it's a ~350-byte JSON file).
(function () {
  const NATIVE_FPS = 15; // pack's guide.txt: "every animation is intended to be played at 15 FPS"
  const DISPLAY_SCALE = 2.5; // native frames are 64-128px pixel art -- scaled up (pixelated) to read clearly on a real screen, same treatment as the chess/checkers/ttt sprites in style.css
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let manifestPromise = null;
  let stylesInjected = false;

  function injectStyles(manifest) {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    let css = '.fx-sprite { position: fixed; z-index: 9999; pointer-events: none; background-repeat: no-repeat; image-rendering: pixelated; image-rendering: -moz-crisp-edges; image-rendering: crisp-edges; }\n';
    Object.keys(manifest).forEach((key) => {
      const m = manifest[key];
      const dw = m.w * DISPLAY_SCALE, dh = m.h * DISPLAY_SCALE;
      const totalW = dw * m.frames;
      const duration = (m.frames / NATIVE_FPS).toFixed(3);
      css += '@keyframes fx-anim-' + key + ' { from { background-position: 0 0; } to { background-position: -' + (totalW - dw) + 'px 0; } }\n';
      // steps(N) for an N-frame strip: visits exactly N discrete positions
      // (frame 0 through frame N-1), landing on the final frame exactly at
      // 100% of the duration -- steps(N-1) would be one frame short.
      css += '.fx-sprite.fx-' + key + ' { width:' + dw + 'px; height:' + dh + 'px; background-image:url(/img/effects/' + key + '.png); background-size:' + totalW + 'px ' + dh + 'px; animation: fx-anim-' + key + ' ' + duration + 's steps(' + m.frames + ') forwards; }\n';
    });
    style.textContent = css;
    document.head.appendChild(style);
  }

  function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = fetch('/img/effects/manifest.json').then((r) => r.json()).then((manifest) => {
        injectStyles(manifest);
        return manifest;
      }).catch(() => ({}));
    }
    return manifestPromise;
  }
  loadManifest(); // kick off the fetch+style-injection immediately so the first real effect isn't delayed by it

  function playEffect(key, anchor) {
    if (reduceMotion || !anchor) return;
    loadManifest().then((manifest) => {
      const meta = manifest[key];
      if (!meta) return;
      const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
      const dw = meta.w * DISPLAY_SCALE, dh = meta.h * DISPLAY_SCALE;
      const el = document.createElement('div');
      el.className = 'fx-sprite fx-' + key;
      el.style.left = (rect.left + rect.width / 2 - dw / 2) + 'px';
      el.style.top = (rect.top + rect.height / 2 - dh / 2) + 'px';
      document.body.appendChild(el);
      el.addEventListener('animationend', () => el.remove());
      // belt-and-suspenders in case animationend never fires for some reason (hidden tab throttling, etc.)
      setTimeout(() => { if (el.parentNode) el.remove(); }, (meta.frames / NATIVE_FPS) * 1000 + 500);
    });
  }

  window.playEffect = playEffect;
})();
