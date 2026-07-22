// "Бульбашки" (Bubble Spinner-style single-player arcade game, 2026-07-21
// "Як отримати більше Крампус коїнів" expansion, 2026-07-22 visual
// overhaul). Plain REST against /api/profile/:nickname (+bubble-clear), no
// socket.io -- same "no room context" reasoning as profile.js. Each
// nickname has its own persistent level (server-side, in playersStore.js's
// profile.bubbleLevel) so "кожен учасник мав власні рівні" holds across
// devices/sessions, and clearing a level awards +BUBBLE_LEVEL_KKOIN_REWARD
// KKoin (see config.js) via the same addKkoin economy the quiz uses.
//
// Mechanics: classic hex-grid bubble shooter. A shooter at the bottom aims
// (mouse or touch) and fires a colored bubble upward; it snaps into the grid
// on collision, and same-color groups of 3+ pop (flood fill), dropping any
// now-disconnected "floating" clusters too. Clearing the whole board wins the
// level. Every few shots a new row descends from the ceiling -- if any
// bubble crosses the danger line near the shooter, the level is lost (no
// KKoin penalty, just retry the same level). Difficulty (rows, colors, how
// often the ceiling descends, ball speed) scales up with the level number.
// NONE of this changed in the 2026-07-22 pass -- dima uploaded a base44
// reference (BubbleShooter.jsx/Bubble.jsx) purely for its LOOK; that
// reference's own game is a much simpler fixed-board demo with no real
// persistence, so it was used as a style guide, not ported wholesale (see
// style.css's ".bub-*" header comment for the full reasoning). What DID
// change: bubbles now render as the hand-painted "Shiny Balls" sprites
// (public/img/bubbles/*.png, see README.md's attribution note) instead of
// flat PALETTE fill colors, plus the whole page chrome moved from the old
// plain .card/.center-screen layout to the same .ds-page dark-casino
// language blackjack/roulette/plinko already use, with a glassmorphic board
// frame, gradient title, aim-dot trail, and playEffect() bursts on win/loss
// (see public/js/effects.js).
(function () {
  const app = document.getElementById('app');

  // ---- ball sprites ----
  // "Shiny Balls Hand-Painted Style" by Feti Sumaryanti (fsy.itch.io) --
  // free for commercial/non-commercial use bundled with a game, raw files
  // not to be resold/reuploaded separately (see README.md attribution note).
  // Same role PALETTE used to play (an array of "color key" strings the
  // game logic below shuffles/matches/persists) -- only now each key looks
  // up a preloaded Image instead of a hex string.
  const BALL_COLOR_KEYS = ['blue', 'brown', 'green', 'purple', 'red', 'yellow'];
  const BALL_GLOW = {
    blue: 'rgba(46,134,193,0.55)',
    brown: 'rgba(200,120,50,0.5)',
    green: 'rgba(46,160,67,0.5)',
    purple: 'rgba(157,78,221,0.55)',
    red: 'rgba(220,53,69,0.55)',
    yellow: 'rgba(255,193,7,0.55)'
  };
  const BALL_FALLBACK_FILL = { blue: '#2E86C1', brown: '#A0522D', green: '#2FA043', purple: '#9D4EDD', red: '#DC3545', yellow: '#FFC107' };
  const BALL_IMAGES = {};
  BALL_COLOR_KEYS.forEach((key) => {
    const img = new Image();
    img.src = '/img/bubbles/' + key + '.png';
    BALL_IMAGES[key] = img;
  });

  // ---- layout constants (unchanged from the pre-overhaul version -- pure
  // visual pass, none of this game math needed to change) ----
  const BUBBLE_R = 16, BUBBLE_D = 32, COLS = 8;
  const ROW_H = BUBBLE_R * Math.sqrt(3);
  const MARGIN_X = 32, MARGIN_Y = 20;
  const CANVAS_W = 320, CANVAS_H = 440;
  const SHOOTER_X = 160, SHOOTER_Y = 410;
  const DANGER_ROW_INDEX = 10; // bubble reaching this row (or deeper) ends the level
  const MAX_ANGLE = 75 * Math.PI / 180;

  let nickname = null;
  let canvas, ctx, overlay, overlayIcon, overlayTitle, overlaySub, overlayBtn, levelValueEl, kkoinValueEl;

  let grid = [];              // array of { offset: 0|1, cells: [{color}|null, ...] }, index 0 = top row
  let activeColors = [];
  let currentColor = null;
  let nextColor = null;
  let flying = null;          // { x, y, vx, vy, color } while a shot is in flight
  let aimAngle = 0;
  let aimDots = [];
  let shotsFired = 0;
  let currentLevel = 1;
  let currentKkoin = 0;
  let gameActive = false;
  let lastTs = null;

  function api(path, options) {
    return fetch(path, options).then((r) => r.json().then((data) => ({ status: r.status, data })));
  }

  // ---- grid geometry ----
  function colsInRow(rowObj) { return rowObj.offset === 0 ? COLS : COLS - 1; }
  function pixelX(rowObj, col) { return MARGIN_X + BUBBLE_R + col * BUBBLE_D + (rowObj.offset === 1 ? BUBBLE_R : 0); }
  function pixelY(rowIndex) { return MARGIN_Y + BUBBLE_R + rowIndex * ROW_H; }

  // ---- difficulty curve ----
  // 2026-07-21 rework: dima wanted the STARTING level roughly 3x harder than
  // before, scaling to a full MAX_LEVEL of 200. A single "difficulty" number
  // doesn't really exist for a game like this, so "3x harder" is spread
  // across every lever at once (more starting rows, more starting colors,
  // a much tighter shots-before-the-ceiling-drops cadence, a faster ball) --
  // together these make level 1 feel dramatically harder than the old
  // 4-row/3-color/13-shot start. Board size and color count are necessarily
  // capped by the fixed 8-column board and the 6-color ball set (see
  // BALL_COLOR_KEYS above), so from roughly level 20 onward, continued
  // difficulty comes from pace (shots-per-descent, ball speed) rather than
  // board size -- that's deliberate, not a missing feature.
  const MAX_LEVEL = 200;
  function numRowsForLevel(level) { return Math.min(6 + Math.floor((level - 1) / 4), 9); }
  function numColorsForLevel(level) { return Math.min(5 + Math.floor((level - 1) / 5), BALL_COLOR_KEYS.length); }
  function shotsPerDescentForLevel(level) { return Math.max(5 - Math.floor((level - 1) / 15), 2); }
  function ballSpeedForLevel(level) { return Math.min(480 + level * 3, 820); }

  function randomActiveColor() { return activeColors[Math.floor(Math.random() * activeColors.length)]; }

  function buildInitialGrid(level) {
    activeColors = BALL_COLOR_KEYS.slice(0, numColorsForLevel(level));
    const rows = numRowsForLevel(level);
    const g = [];
    for (let i = 0; i < rows; i++) {
      const offset = i % 2;
      const cols = offset === 0 ? COLS : COLS - 1;
      const cells = new Array(cols).fill(null).map(() => ({ color: randomActiveColor() }));
      g.push({ offset, cells });
    }
    return g;
  }

  function makeDescendRow() {
    const offset = grid.length ? (1 - grid[0].offset) : 0;
    const cols = offset === 0 ? COLS : COLS - 1;
    const cells = new Array(cols).fill(null).map(() => ({ color: randomActiveColor() }));
    return { offset, cells };
  }

  // CRITICAL FIX (2026-07-21, "гра чомусь не працює"): grid only ever held
  // however many rows had explicitly been created (initial rows + any that
  // descended from the ceiling). A fired ball colliding with the bottom-most
  // existing row had nowhere to attach BELOW that row -- neighborsOf() only
  // looks at rows that already exist in the array, and the old fallback
  // search in snapNear() capped its range at `grid.length - 1`, so it could
  // never consider a not-yet-existing row either. At the start of a level
  // every row is fully packed (no gaps), so literally the very first shot
  // had no empty neighbor ANYWHERE it could find -- it just vanished with no
  // effect, forever, making the game completely unplayable from shot one.
  // Fix: always keep one fully-empty row available past whatever is
  // currently the lowest occupied row, so there's always somewhere for a
  // ball to attach "below". Called after building a level and after every
  // resolved shot.
  function ensureBottomBuffer() {
    let lastOccupied = -1;
    for (let r = 0; r < grid.length; r++) {
      if (grid[r].cells.some((c) => c)) lastOccupied = r;
    }
    while (grid.length <= lastOccupied + 1) {
      const offset = grid.length ? (1 - grid[grid.length - 1].offset) : 0;
      const cols = offset === 0 ? COLS : COLS - 1;
      grid.push({ offset, cells: new Array(cols).fill(null) });
    }
  }

  function cellAt(r, c) {
    return (grid[r] && grid[r].cells[c]) ? grid[r].cells[c] : null;
  }

  // Neighbor cells in a hex-offset grid where each row alternates being
  // shifted right by half a bubble width (see buildInitialGrid/makeDescendRow
  // -- offset is tracked per-row, not derived from array index, specifically
  // so unshifting a new row on "descend" can never flip existing rows'
  // apparent horizontal position).
  function neighborsOf(ri, ci) {
    const row = grid[ri];
    if (!row) return [];
    const result = [[ri, ci - 1], [ri, ci + 1]];
    if (row.offset === 0) {
      result.push([ri - 1, ci - 1], [ri - 1, ci], [ri + 1, ci - 1], [ri + 1, ci]);
    } else {
      result.push([ri - 1, ci], [ri - 1, ci + 1], [ri + 1, ci], [ri + 1, ci + 1]);
    }
    return result.filter(([r, c]) => r >= 0 && grid[r] && c >= 0 && c < colsInRow(grid[r]));
  }

  function floodSameColor(ri, ci) {
    const color = cellAt(ri, ci).color;
    const seen = new Set([ri + ',' + ci]);
    const stack = [[ri, ci]];
    const group = [[ri, ci]];
    while (stack.length) {
      const [r, c] = stack.pop();
      neighborsOf(r, c).forEach(([nr, nc]) => {
        const key = nr + ',' + nc;
        if (seen.has(key)) return;
        const cell = cellAt(nr, nc);
        if (cell && cell.color === color) {
          seen.add(key);
          group.push([nr, nc]);
          stack.push([nr, nc]);
        }
      });
    }
    return group;
  }

  // Anything not connected (through any color) back to the top row is
  // "floating" in a real bubble shooter and falls away -- standard mechanic,
  // and the main way big chunks disappear at once.
  function removeFloating() {
    const reachable = new Set();
    const queue = [];
    if (grid[0]) {
      grid[0].cells.forEach((cell, c) => {
        if (cell) { reachable.add('0,' + c); queue.push([0, c]); }
      });
    }
    while (queue.length) {
      const [r, c] = queue.shift();
      neighborsOf(r, c).forEach(([nr, nc]) => {
        const key = nr + ',' + nc;
        if (reachable.has(key)) return;
        const cell = cellAt(nr, nc);
        if (cell) { reachable.add(key); queue.push([nr, nc]); }
      });
    }
    for (let r = 0; r < grid.length; r++) {
      grid[r].cells.forEach((cell, c) => {
        if (cell && !reachable.has(r + ',' + c)) grid[r].cells[c] = null;
      });
    }
  }

  function isBoardClear() {
    return grid.every((row) => row.cells.every((cell) => !cell));
  }

  function isDanger() {
    for (let r = DANGER_ROW_INDEX; r < grid.length; r++) {
      if (grid[r].cells.some((c) => c)) return true;
    }
    return false;
  }

  function colorsPresentInGrid() {
    const set = new Set();
    grid.forEach((row) => row.cells.forEach((cell) => { if (cell) set.add(cell.color); }));
    return Array.from(set);
  }

  // Only ever loads the shooter with a color that still exists somewhere on
  // the board (classic bubble-shooter fairness trick) -- avoids the
  // frustration of holding a color that has nothing left to match.
  function pickRandomColor() {
    const present = colorsPresentInGrid();
    const pool = present.length ? present : activeColors;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---- level lifecycle ----
  function startLevel(level) {
    hideOverlay();
    currentLevel = level;
    grid = buildInitialGrid(level);
    ensureBottomBuffer();
    shotsFired = 0;
    flying = null;
    currentColor = pickRandomColor();
    nextColor = pickRandomColor();
    gameActive = true;
    if (levelValueEl) levelValueEl.textContent = String(level) + (level >= MAX_LEVEL ? ' (максимум)' : '');
  }

  function performDescend() {
    grid.unshift(makeDescendRow());
    ensureBottomBuffer();
    if (isDanger()) loseLevel();
  }

  function resolveHit(row, col, color) {
    grid[row].cells[col] = { color };
    const group = floodSameColor(row, col);
    if (group.length >= 3) {
      group.forEach(([r, c]) => { grid[r].cells[c] = null; });
      playSfx('impact');
      removeFloating();
    }
    if (isBoardClear()) { winLevel(); return; }
    ensureBottomBuffer();
    shotsFired += 1;
    if (shotsFired % shotsPerDescentForLevel(currentLevel) === 0) performDescend();
    if (!gameActive) return; // performDescend may have just ended the level (danger reached)
    currentColor = nextColor;
    nextColor = pickRandomColor();
    flying = null;
  }

  function winLevel() {
    gameActive = false;
    flying = null;
    playEffect('firework', canvas || document.body);
    api('/api/profile/' + encodeURIComponent(nickname) + '/bubble-clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: currentLevel })
    }).then(({ status, data }) => {
      if (status !== 200 || data.error) {
        if (data && data.profile) { currentKkoin = data.profile.kkoin || currentKkoin; if (kkoinValueEl) kkoinValueEl.textContent = currentKkoin; }
        showOverlay('Ой!', (data && data.error) || 'Не вдалося зберегти прогрес', 'Спробувати ще раз', () => startLevel(currentLevel), false, false);
        return;
      }
      currentKkoin = data.profile.kkoin;
      if (kkoinValueEl) kkoinValueEl.textContent = currentKkoin;
      const nextLevelNum = data.profile.bubbleLevel;
      const atCap = currentLevel >= MAX_LEVEL;
      playSfx('select');
      showOverlay(
        atCap ? '🏆 Максимальний рівень!' : ('🎉 Рівень ' + currentLevel + ' пройдено!'),
        atCap ? ('+' + data.awarded + ' KKrampus coin — ти вже на межі складності (' + MAX_LEVEL + '), можна грати далі на них') : ('+' + data.awarded + ' KKrampus coin — далі складніше'),
        atCap ? 'Грати ще раз' : 'Наступний рівень',
        () => startLevel(nextLevelNum),
        true,
        false
      );
    }).catch(() => {
      showOverlay('Ой!', 'Не вдалося з’єднатися із сервером', 'Спробувати ще раз', () => startLevel(currentLevel), false, false);
    });
  }

  function loseLevel() {
    gameActive = false;
    flying = null;
    playSfx('wrong');
    playEffect('poison', canvas || document.body);
    showOverlay('💥 Кулі дісталися низу', 'Рівень ' + currentLevel + ' — спробуй ще раз', 'Спробувати ще раз', () => startLevel(currentLevel), false, true);
  }

  // showOverlay: win/lose/error card over the board. showTrophy (2026-07-21,
  // dima: "можеш типу той кет інтерфейс використати десь" -- was a cat-face
  // mascot; kept as a simple trophy glyph on the shared gold overlay-icon
  // circle in this pass so it always matches the new .bub-overlay-icon
  // styling regardless of win/error/lose, rather than needing its own image
  // asset positioned specially) only true on an actual level-clear, not on
  // the error/retry path. isLose toggles the overlay's red styling variant
  // (see .bub-overlay.lose in style.css).
  function showOverlay(title, sub, btnText, onClick, showTrophy, isLose) {
    overlayIcon.textContent = isLose ? '💥' : (showTrophy ? '🏆' : '⚠️');
    overlay.classList.toggle('lose', !!isLose);
    overlayTitle.textContent = title;
    overlaySub.textContent = sub;
    overlayBtn.textContent = btnText;
    overlayBtn.onclick = onClick;
    overlay.classList.add('show');
  }
  function hideOverlay() { overlay.classList.remove('show'); }

  // ---- input (mouse aim + click, or touch tap-to-fire) ----
  function canvasPointFromEvent(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (CANVAS_W / rect.width),
      y: (clientY - rect.top) * (CANVAS_H / rect.height)
    };
  }

  function updateAim(clientX, clientY) {
    const p = canvasPointFromEvent(clientX, clientY);
    const dx = p.x - SHOOTER_X;
    const dy = Math.min(p.y - SHOOTER_Y, -10); // always treat as "above" the shooter
    let angle = Math.atan2(dx, -dy);
    angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, angle));
    aimAngle = angle;
    computeAimDots();
  }

  // Traces the SAME wall-bounce physics update() below actually uses (see
  // there) so the dot trail is a real preview, not a cosmetic straight line
  // -- it genuinely bends around a wall bounce the way the shot will.
  function computeAimDots() {
    aimDots = [];
    let x = SHOOTER_X, y = SHOOTER_Y;
    let vx = Math.sin(aimAngle), vy = -Math.cos(aimAngle);
    const step = 14, maxDots = 18;
    for (let i = 0; i < maxDots; i++) {
      x += vx * step; y += vy * step;
      if (x - BUBBLE_R < 0) { x = BUBBLE_R; vx = Math.abs(vx); }
      if (x + BUBBLE_R > CANVAS_W) { x = CANVAS_W - BUBBLE_R; vx = -Math.abs(vx); }
      if (y - BUBBLE_R <= MARGIN_Y) break;
      let hit = false;
      for (let r = 0; r < grid.length && !hit; r++) {
        const rowObj = grid[r];
        for (let c = 0; c < colsInRow(rowObj) && !hit; c++) {
          if (!cellAt(r, c)) continue;
          if (Math.hypot(pixelX(rowObj, c) - x, pixelY(r) - y) <= BUBBLE_D - 2) hit = true;
        }
      }
      if (hit) break;
      aimDots.push({ x, y, opacity: Math.max(0.15, 1 - (i / maxDots) * 0.8) });
    }
  }

  function fireShot() {
    if (!gameActive || flying) return;
    const speed = ballSpeedForLevel(currentLevel);
    flying = {
      x: SHOOTER_X, y: SHOOTER_Y,
      vx: speed * Math.sin(aimAngle), vy: -speed * Math.cos(aimAngle),
      color: currentColor
    };
    aimDots = [];
  }

  // ---- physics ----
  function snapNear(hitRow, hitCol) {
    const candidates = neighborsOf(hitRow, hitCol).filter(([r, c]) => !cellAt(r, c));
    let best = null, bestDist = Infinity;
    candidates.forEach(([r, c]) => {
      const rowObj = grid[r];
      const d = Math.hypot(flying.x - pixelX(rowObj, c), flying.y - pixelY(r));
      if (d < bestDist) { bestDist = d; best = [r, c]; }
    });
    if (!best) {
      // Fallback for the rare case the hit cell's immediate neighbors are all
      // full: widen the search a couple of rows around the hit.
      for (let r = Math.max(0, hitRow - 1); r <= Math.min(grid.length - 1, hitRow + 2) && !best; r++) {
        const rowObj = grid[r];
        for (let c = 0; c < colsInRow(rowObj); c++) {
          if (cellAt(r, c)) continue;
          const d = Math.hypot(flying.x - pixelX(rowObj, c), flying.y - pixelY(r));
          if (d < bestDist) { bestDist = d; best = [r, c]; }
        }
      }
    }
    if (!best) { flying = null; return; } // board essentially full -- just drop the shot
    resolveHit(best[0], best[1], flying.color);
  }

  function snapAtTopRow() {
    if (!grid.length) { flying = null; return; }
    const rowObj = grid[0];
    let best = null, bestDist = Infinity;
    for (let c = 0; c < colsInRow(rowObj); c++) {
      if (cellAt(0, c)) continue;
      const d = Math.abs(flying.x - pixelX(rowObj, c));
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (best === null) { flying = null; return; }
    resolveHit(0, best, flying.color);
  }

  function update(dt) {
    if (!flying) return;
    flying.x += flying.vx * dt;
    flying.y += flying.vy * dt;
    if (flying.x - BUBBLE_R < 0) { flying.x = BUBBLE_R; flying.vx *= -1; }
    if (flying.x + BUBBLE_R > CANVAS_W) { flying.x = CANVAS_W - BUBBLE_R; flying.vx *= -1; }
    if (flying.y - BUBBLE_R <= MARGIN_Y) { snapAtTopRow(); return; }
    for (let r = 0; r < grid.length; r++) {
      const rowObj = grid[r];
      for (let c = 0; c < colsInRow(rowObj); c++) {
        if (!cellAt(r, c)) continue;
        if (Math.hypot(flying.x - pixelX(rowObj, c), flying.y - pixelY(r)) <= BUBBLE_D - 2) { snapNear(r, c); return; }
      }
    }
  }

  // ---- rendering ----
  // colorKey -> preloaded Image; falls back to a flat circle in the ball's
  // approximate hue if the sprite hasn't finished loading yet (only visible
  // for the first frame or two after page load) or somehow fails to load.
  function drawBubble(x, y, colorKey, radius) {
    const r = radius || BUBBLE_R;
    const img = BALL_IMAGES[colorKey];
    ctx.save();
    ctx.shadowColor = BALL_GLOW[colorKey] || 'rgba(255,255,255,0.4)';
    ctx.shadowBlur = 9;
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r - 1, 0, Math.PI * 2);
      ctx.fillStyle = BALL_FALLBACK_FILL[colorKey] || '#888';
      ctx.fill();
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(233,69,96,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const dangerY = pixelY(DANGER_ROW_INDEX) - BUBBLE_R - 4;
    ctx.moveTo(0, dangerY);
    ctx.lineTo(CANVAS_W, dangerY);
    ctx.stroke();
    ctx.restore();

    for (let r = 0; r < grid.length; r++) {
      const rowObj = grid[r];
      for (let c = 0; c < colsInRow(rowObj); c++) {
        const cell = cellAt(r, c);
        if (cell) drawBubble(pixelX(rowObj, c), pixelY(r), cell.color);
      }
    }

    // aim-dot trail (2026-07-22, replaces the old single dashed line --
    // matches the reference's look and, via computeAimDots, genuinely
    // traces the real bounce path rather than a straight guess).
    if (gameActive && !flying) {
      aimDots.forEach((dot) => {
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,' + (dot.opacity * 0.8).toFixed(2) + ')';
        ctx.shadowColor = 'rgba(255,255,255,0.5)';
        ctx.shadowBlur = 4;
        ctx.fill();
        ctx.shadowBlur = 0;
      });
    }

    if (flying) drawBubble(flying.x, flying.y, flying.color);

    if (gameActive) {
      // faint ring around the shooter slot, echoing the reference's shooter halo
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(SHOOTER_X, SHOOTER_Y, BUBBLE_R + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      if (currentColor) drawBubble(SHOOTER_X, SHOOTER_Y, currentColor);
      if (nextColor) {
        ctx.globalAlpha = 0.75;
        drawBubble(28, SHOOTER_Y - 4, nextColor, BUBBLE_R * 0.6);
        ctx.globalAlpha = 1;
        ctx.font = '700 8px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.textAlign = 'center';
        ctx.fillText('ДАЛІ', 28, SHOOTER_Y + 20);
      }
    }
  }

  function loop(ts) {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;
    if (gameActive) update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // ---- page chrome (2026-07-22 overhaul) ----
  function buildPage() {
    // Device-pixel-ratio-aware canvas (2026-07-22): the backing buffer is
    // sized at CANVAS_W/H * dpr real pixels so the hand-painted ball sprites
    // stay crisp on retina-class screens instead of getting upscaled and
    // blurred -- flat arc() fills (the old renderer) never showed this, but
    // detailed PNG textures do. #bub-canvas's own CSS (width:100%; height:
    // auto) derives the on-page size from these HTML width/height attributes'
    // ASPECT RATIO, and dpr cancels out of that ratio, so the element still
    // displays at exactly the same CSS size as before -- just backed by more
    // real pixels. ctx.scale(dpr, dpr) right after grabbing the context then
    // makes every existing CANVAS_W/H-space draw call (and canvasPointFromEvent's
    // rect-based, dpr-agnostic input mapping) keep working completely unchanged.
    const dpr = window.devicePixelRatio || 1;
    canvas = el('canvas', { id: 'bub-canvas', width: String(CANVAS_W * dpr), height: String(CANVAS_H * dpr) });
    overlayIcon = el('div', { class: 'bub-overlay-icon' }, ['🏆']);
    overlayTitle = el('div', { class: 'bub-overlay-title' }, ['']);
    overlaySub = el('div', { class: 'bub-overlay-sub' }, ['']);
    overlayBtn = el('button', { class: 'bj-deal-btn bub-overlay-btn' }, ['']);
    overlay = el('div', { class: 'bub-overlay' }, [overlayIcon, overlayTitle, overlaySub, overlayBtn]);

    levelValueEl = el('span', { class: 'bub-hud-value' }, ['1']);
    kkoinValueEl = el('span', { class: 'bub-hud-value' }, ['0']);
    const kcoinIcon = el('div', { class: 'kcoin', style: 'width:16px; height:16px;' }, [
      el('div', { class: 'kcoin-glow' }),
      el('div', { class: 'kcoin-inner' }, [
        el('div', { class: 'kcoin-face' }, [el('img', { src: '/img/kkrampus-coin.jpg', alt: '' })]),
        el('div', { class: 'kcoin-back' }, [el('span', { style: 'font-size:6px;' }, ['KK'])])
      ])
    ]);

    const hud = el('div', { class: 'bub-hud' }, [
      el('div', { class: 'bub-hud-chip' }, [el('span', { class: 'bub-hud-icon' }, ['🧗']), el('span', { class: 'bub-hud-label' }, ['Рівень']), levelValueEl]),
      el('div', { class: 'bub-hud-chip' }, [kcoinIcon, el('span', { class: 'bub-hud-label' }, ['Krampus']), kkoinValueEl])
    ]);

    const boardWrap = el('div', { class: 'bub-board-wrap' }, [
      el('div', { class: 'bub-board-frame' }, [
        el('div', { class: 'bub-board-inner' }, [canvas, overlay])
      ])
    ]);

    app.appendChild(el('div', { class: 'ds-page bj-page bub-page' }, [
      el('div', { class: 'hub-bg-spheres', 'aria-hidden': 'true' }, [
        el('span', { class: 'hub-sphere s1' }), el('span', { class: 'hub-sphere s2' }), el('span', { class: 'hub-sphere s3' })
      ]),
      el('div', { class: 'ds-shell' }, [
        el('div', { class: 'bj-topbar', style: 'display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;' }, [
          el('a', { href: '/minigames.html', class: 'back-link' }, ['← До міні-ігор'])
        ]),
        el('div', { class: 'bj-title-block', style: 'text-align:center;' }, [
          el('div', { class: 'bj-eyebrow' }, ['/ Міні-ігри · Аркада']),
          el('h1', { class: 'bj-title bub-title' }, ['🫧 Бульбашки'])
        ]),
        hud,
        boardWrap,
        el('p', { class: 'bub-help' }, ['Цілься мишкою (або пальцем на телефоні) і тапни/клікни по полю, щоб вистрілити. Зістав 3+ бульбашки одного кольору, щоб їх прибрати.']),
        el('p', { class: 'footer-note', style: 'text-align:center;' }, ['Made by DimaSh'])
      ])
    ]));

    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    canvas.addEventListener('mousemove', (e) => { if (gameActive && !flying) updateAim(e.clientX, e.clientY); });
    canvas.addEventListener('mouseleave', () => { aimDots = []; });
    canvas.addEventListener('click', (e) => { updateAim(e.clientX, e.clientY); fireShot(); });
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      updateAim(t.clientX, t.clientY);
      fireShot();
    }, { passive: false });

    requestAnimationFrame(loop);
  }

  // ---- nickname gate + profile bootstrap ----
  function boot(login) {
    nickname = login;
    api('/api/profile/' + encodeURIComponent(nickname)).then(({ status, data }) => {
      if (status !== 200 || data.error) { toast((data && data.error) || 'Не вдалося завантажити профіль', true); return; }
      currentKkoin = data.profile.kkoin || 0;
      buildPage();
      kkoinValueEl.textContent = currentKkoin;
      startLevel(data.profile.bubbleLevel || 1);
    }).catch(() => toast('Не вдалося з’єднатися із сервером', true));
  }

  // dima 2026-07-21 "видали гостя, зроби реєстрацію обов'язковою скрізь" --
  // requireAccount() (common.js) decides whether to show login/registration
  // or, if there's already a valid session (getAuth()), skip straight to boot().
  requireAccount(app, { title: 'Бульбашки', emoji: '🫧', backLink: el('a', { href: '/minigames.html', class: 'back-link' }, ['← До міні-ігор']) }, boot);
})();
