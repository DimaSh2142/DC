// "Бульбашки" (Bubble Spinner-style single-player arcade game, 2026-07-21
// "Як отримати більше Крампус коїнів" expansion). Plain REST against
// /api/profile/:nickname (+bubble-clear), no socket.io -- same "no room
// context" reasoning as profile.js. Each nickname has its own persistent
// level (server-side, in playersStore.js's profile.bubbleLevel) so
// "кожен учасник мав власні рівні" holds across devices/sessions, and
// clearing a level awards +BUBBLE_LEVEL_KKOIN_REWARD KKoin (see config.js)
// via the same addKkoin economy the quiz uses.
//
// Mechanics: classic hex-grid bubble shooter. A shooter at the bottom aims
// (mouse or touch) and fires a colored bubble upward; it snaps into the grid
// on collision, and same-color groups of 3+ pop (flood fill), dropping any
// now-disconnected "floating" clusters too. Clearing the whole board wins the
// level. Every few shots a new row descends from the ceiling -- if any
// bubble crosses the danger line near the shooter, the level is lost (no
// KKoin penalty, just retry the same level). Difficulty (rows, colors, how
// often the ceiling descends, ball speed) scales up with the level number.
// Bubble colors are drawn from the site's own 4-hue palette + its dark
// shades (see PALETTE below) rather than inventing new hues, so even this
// game board stays inside the strict-palette rule documented in style.css.
(function () {
  const NICK_KEY = 'sigame_nickname';
  let nickname = (localStorage.getItem(NICK_KEY) || '').trim();

  const gateSection = document.getElementById('gate-section');
  const gateForm = document.getElementById('gate-form');
  const gateInput = document.getElementById('gate-nickname');
  const gameSection = document.getElementById('game-section');
  const levelEl = document.getElementById('bubbles-level');
  const kkoinEl = document.getElementById('bubbles-kkoin');
  const canvas = document.getElementById('bubbles-canvas');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('bubbles-overlay');
  const overlayMascot = document.getElementById('bubbles-overlay-mascot');
  const overlayTitle = document.getElementById('bubbles-overlay-title');
  const overlaySub = document.getElementById('bubbles-overlay-sub');
  const overlayBtn = document.getElementById('bubbles-overlay-btn');

  // ---- layout constants (must match the canvas's width/height attributes
  // in bubbles.html) ----
  const BUBBLE_R = 16, BUBBLE_D = 32, COLS = 8;
  const ROW_H = BUBBLE_R * Math.sqrt(3);
  const MARGIN_X = 32, MARGIN_Y = 20;
  const CANVAS_W = 320, CANVAS_H = 440;
  const SHOOTER_X = 160, SHOOTER_Y = 410;
  const DANGER_ROW_INDEX = 10; // bubble reaching this row (or deeper) ends the level
  const MAX_ANGLE = 75 * Math.PI / 180;
  // turquoise, crimson, orange, then their dark shades -- same 4 hues as the
  // rest of the site, not new colors (see style.css header comment).
  const PALETTE = ['#17B8A6', '#D7263D', '#F2994A', '#0E6E64', '#9C1B2C', '#C4732A'];

  let grid = [];              // array of { offset: 0|1, cells: [{color}|null, ...] }, index 0 = top row
  let activeColors = [];
  let currentColor = null;
  let nextColor = null;
  let flying = null;          // { x, y, vx, vy, color } while a shot is in flight
  let aimAngle = 0;
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
  // capped by the fixed 8-column board and the 6-color palette (see PALETTE
  // below), so from roughly level 20 onward, continued difficulty comes from
  // pace (shots-per-descent, ball speed) rather than board size -- that's
  // deliberate, not a missing feature.
  const MAX_LEVEL = 200;
  function numRowsForLevel(level) { return Math.min(6 + Math.floor((level - 1) / 4), 9); }
  function numColorsForLevel(level) { return Math.min(5 + Math.floor((level - 1) / 5), PALETTE.length); }
  function shotsPerDescentForLevel(level) { return Math.max(5 - Math.floor((level - 1) / 15), 2); }
  function ballSpeedForLevel(level) { return Math.min(480 + level * 3, 820); }

  function randomActiveColor() { return activeColors[Math.floor(Math.random() * activeColors.length)]; }

  function buildInitialGrid(level) {
    activeColors = PALETTE.slice(0, numColorsForLevel(level));
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
    overlay.style.display = 'none';
    currentLevel = level;
    grid = buildInitialGrid(level);
    ensureBottomBuffer();
    shotsFired = 0;
    flying = null;
    currentColor = pickRandomColor();
    nextColor = pickRandomColor();
    gameActive = true;
    levelEl.textContent = String(level) + (level >= MAX_LEVEL ? ' (максимум)' : '');
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
      removeFloating();
      playSfx('impact');
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
    api('/api/profile/' + encodeURIComponent(nickname) + '/bubble-clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: currentLevel })
    }).then(({ status, data }) => {
      if (status !== 200 || data.error) {
        if (data && data.profile) { currentKkoin = data.profile.kkoin || currentKkoin; kkoinEl.textContent = currentKkoin; }
        showOverlay('Ой!', (data && data.error) || 'Не вдалося зберегти прогрес', 'Спробувати ще раз', () => startLevel(currentLevel));
        return;
      }
      currentKkoin = data.profile.kkoin;
      kkoinEl.textContent = currentKkoin;
      const nextLevelNum = data.profile.bubbleLevel;
      const atCap = currentLevel >= MAX_LEVEL;
      playSfx('select');
      showOverlay(
        atCap ? '🏆 Максимальний рівень!' : ('🎉 Рівень ' + currentLevel + ' пройдено!'),
        atCap ? ('+' + data.awarded + ' KKrampus coin — ти вже на межі складності (' + MAX_LEVEL + '), можна грати далі на них') : ('+' + data.awarded + ' KKrampus coin — далі складніше'),
        atCap ? 'Грати ще раз' : 'Наступний рівень',
        () => startLevel(nextLevelNum),
        true
      );
    }).catch(() => {
      showOverlay('Ой!', 'Не вдалося з’єднатися із сервером', 'Спробувати ще раз', () => startLevel(currentLevel));
    });
  }

  function loseLevel() {
    gameActive = false;
    flying = null;
    playSfx('wrong');
    showOverlay('💥 Кулі дісталися низу', 'Рівень ' + currentLevel + ' — спробуй ще раз', 'Спробувати ще раз', () => startLevel(currentLevel));
  }

  // showMascot (2026-07-21, dima: "можеш типу той кет інтерфейс використати
  // десь") -- a tiny cat-face icon cut from the CatUI Free sprite sheet (see
  // README.md's asset-attribution note), shown only on an actual level-clear,
  // not on the error/retry path or on losing (a cheerful cat doesn't fit
  // either of those moments).
  function showOverlay(title, sub, btnText, onClick, showMascot) {
    overlayMascot.style.display = showMascot ? '' : 'none';
    overlayTitle.textContent = title;
    overlaySub.textContent = sub;
    overlayBtn.textContent = btnText;
    overlayBtn.onclick = onClick;
    overlay.style.display = 'flex';
  }

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
  }

  function fireShot() {
    if (!gameActive || flying) return;
    const speed = ballSpeedForLevel(currentLevel);
    flying = {
      x: SHOOTER_X, y: SHOOTER_Y,
      vx: speed * Math.sin(aimAngle), vy: -speed * Math.cos(aimAngle),
      color: currentColor
    };
  }

  canvas.addEventListener('mousemove', (e) => updateAim(e.clientX, e.clientY));
  canvas.addEventListener('click', (e) => { updateAim(e.clientX, e.clientY); fireShot(); });
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    updateAim(t.clientX, t.clientY);
    fireShot();
  }, { passive: false });

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
  function drawBubble(x, y, color) {
    ctx.beginPath();
    ctx.arc(x, y, BUBBLE_R - 1, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.stroke();
  }

  function draw() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(215,38,61,0.55)';
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

    if (gameActive && !flying) {
      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(11,61,56,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(SHOOTER_X, SHOOTER_Y);
      ctx.lineTo(SHOOTER_X + Math.sin(aimAngle) * 200, SHOOTER_Y - Math.cos(aimAngle) * 200);
      ctx.stroke();
      ctx.restore();
    }

    if (flying) drawBubble(flying.x, flying.y, flying.color);
    if (currentColor) drawBubble(SHOOTER_X, SHOOTER_Y, currentColor);
    if (nextColor) {
      ctx.globalAlpha = 0.7;
      drawBubble(SHOOTER_X + 44, SHOOTER_Y + 12, nextColor);
      ctx.globalAlpha = 1;
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
  requestAnimationFrame(loop);

  // ---- nickname gate + profile bootstrap (mirrors profile.html's pattern) ----
  function boot(nick) {
    nickname = nick;
    localStorage.setItem(NICK_KEY, nick);
    api('/api/profile/' + encodeURIComponent(nick)).then(({ status, data }) => {
      if (status !== 200 || data.error) { toast((data && data.error) || 'Не вдалося завантажити профіль', true); return; }
      gateSection.style.display = 'none';
      gameSection.style.display = '';
      currentKkoin = data.profile.kkoin || 0;
      kkoinEl.textContent = currentKkoin;
      startLevel(data.profile.bubbleLevel || 1);
    }).catch(() => toast('Не вдалося з’єднатися із сервером', true));
  }

  gateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const nick = gateInput.value.trim();
    if (!nick) return toast('Введіть нікнейм', true);
    boot(nick);
  });

  if (nickname) boot(nickname);
  else gateInput.focus();
})();
