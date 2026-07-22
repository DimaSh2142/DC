// Plinko client -- solo, no table/room at all (see src/state/plinkoManager.js's
// header comment). One request/response per BATCH of drops: the client sends
// a stake and a ball count, the server deducts stake*count up front, simulates
// every ball's whole path independently, pays out, and returns one result per
// ball in a single shot (src/games/plinko.js's simulatePath/payout, looped by
// plinkoManager.dropMany). This file only ANIMATES each ball falling along its
// own already-decided path -- it never generates or trusts a client-side
// outcome, same "server is truth" discipline as every other casino game here.
// ROWS/MULTIPLIERS below are mirrored from games/plinko.js purely to draw the
// board/slot labels before a drop happens; the actual multiplier/payout shown
// after a drop always comes straight from the server's response.
//
// 2026-07-22 rewrite (dima sent a real base44 PlinkoBoard.jsx reference --
// canvas board, gravity/bounce physics, glowing pegs, ball trail, and a
// dropBalls(count) multi-ball API -- "перебери зіп і знайди там плінко,
// використай його" + "додай можливість запускати одночасно 1, 5, 10 та 25
// куль"). Ported the LOOK (canvas, glow, trail, gradient ball, multi-ball)
// but NOT the reference's actual physics engine: that version lets real
// collision physics decide where each ball lands, which would make the
// OUTCOME client-authoritative -- a real cheating hole in a currency system,
// and a hard break from this file's own header rule above. Instead, each
// ball's on-screen path is STEERED by the server's real path[] (one L/R per
// peg row, exactly as before this rewrite), just rendered with gravity-ish
// per-row easing, a peg glow at the row it "bounces" off, and a trail --
// visually in the spirit of the reference, outcome still 100% server-decided.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  // 2026-07-22 "набагато більше квадратиків... і з такими ж іксами" (dima's
  // reference screenshot) -- kept in sync with games/plinko.js's own
  // ROWS/MULTIPLIERS by hand (see that file's header: this copy is
  // display-only, the server never trusts anything computed here).
  const ROWS = 16;
  const MULTIPLIERS = [1000, 100, 20, 10, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 10, 20, 100, 1000];
  // dima 2026-07-22 "додай можливість запускати одночасно 1, 5, 10 та 25
  // куль" -- fixed preset buttons, same allow-list plinkoManager.js enforces
  // server-side (see that file's ALLOWED_BALL_COUNTS).
  const BALL_COUNTS = [1, 5, 10, 25];

  // ---- canvas board geometry (px, internal drawing-buffer units) ----
  const BW = 640, BH = 400;
  const PEG_MARGIN = 30;
  const PEG_TOP = BH * 0.10;
  const PEG_BOTTOM = BH * 0.82;
  const PEG_R = 3.2;
  const BALL_R = 6;

  let nickname = null;
  let balance = 0;
  let customBet = '';
  let ballCount = 1;
  let dropping = false;
  let lastBatch = null; // { count, totalNet, totalStake, totalPayout, bestMultiplier } once a whole batch finishes animating

  let canvas = null, ctx = null;
  let pegs = null; // built once, pure function of ROWS/BW/BH -- [{ x, y, row, glow }]
  let pegsByRow = null; // row -> array of pegs in that row, for nearest-peg glow lookups
  let activeBalls = []; // balls currently animating
  let rafHandle = null;

  function refreshBalance(cb) {
    fetch('/api/profile/' + encodeURIComponent(nickname)).then((r) => r.json()).then((data) => {
      balance = (data && data.profile && data.profile.kkoin) || 0;
      if (cb) cb();
    }).catch(() => { if (cb) cb(); });
  }

  function topBarNode() {
    return el('div', { class: 'bj-topbar', style: 'display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;' }, [
      el('a', { href: '/casino.html', class: 'back-link' }, ['← Казино']),
      el('div', { class: 'bj-coin-chip' }, [
        el('span', { class: 'bj-coin-icon' }, ['\u{1FA99}']),
        el('span', { class: 'bj-coin-value' }, [String(balance)]),
        el('span', { class: 'bj-coin-label' }, ['KKoin'])
      ])
    ]);
  }

  // ---- board geometry (built once -- ROWS/BW/BH never change at runtime) ----
  function buildPegs() {
    const list = [];
    const byRow = [];
    const spacing = (BW - 2 * PEG_MARGIN) / ROWS;
    for (let r = 0; r < ROWS; r++) {
      const count = r + 2;
      const rowStartX = (BW - (count - 1) * spacing) / 2;
      const y = PEG_TOP + (PEG_BOTTOM - PEG_TOP) * (r / (ROWS - 1));
      const row = [];
      for (let i = 0; i < count; i++) {
        const peg = { x: rowStartX + i * spacing, y, row: r, glow: 0 };
        list.push(peg);
        row.push(peg);
      }
      byRow.push(row);
    }
    return { list, byRow };
  }

  function nearestPegInRow(row, x) {
    const rowPegs = pegsByRow[row];
    if (!rowPegs || !rowPegs.length) return null;
    let best = rowPegs[0], bestDist = Math.abs(rowPegs[0].x - x);
    for (let i = 1; i < rowPegs.length; i++) {
      const d = Math.abs(rowPegs[i].x - x);
      if (d < bestDist) { best = rowPegs[i]; bestDist = d; }
    }
    return best;
  }

  // Same conditional-expectation math this file has used since the very
  // first version: at "step" (0..ROWS) bounces resolved, the ball's target
  // x is the EXPECTED final slot given the real bounces so far plus 0.5 per
  // still-unresolved bounce -- so it converges exactly on the server's real
  // slotIndex by step===ROWS, not a cosmetic guess.
  // The "+0.5" / "(ROWS+1)" below (not "/ROWS") lines the FINAL resting x up
  // with slot i's actual CENTER as .pk-slots-row lays it out (17 equal flex
  // cells, cell i centered at (i+0.5)/17) -- using /ROWS instead would land
  // the ball exactly on slot BOUNDARIES, visibly off-centre in its cell,
  // worst at the two edge slots.
  function targetForStep(rightCount, step) {
    const expectedSlot = rightCount + (ROWS - step) * 0.5;
    const xPct = ((expectedSlot + 0.5) / (ROWS + 1)) * 100;
    const yPct = (step / (ROWS + 1)) * 92 + 4;
    return { x: (xPct / 100) * BW, y: (yPct / 100) * BH };
  }

  function setupCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = BW * dpr;
    canvas.height = BH * dpr;
    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawBoard() {
    if (!ctx) return;
    ctx.clearRect(0, 0, BW, BH);
    for (const peg of pegs.list) {
      if (peg.glow > 0) {
        ctx.beginPath();
        ctx.arc(peg.x, peg.y, PEG_R + 5 * peg.glow, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 209, ' + (0.28 * peg.glow) + ')';
        ctx.fill();
        peg.glow = Math.max(0, peg.glow - 0.05);
      }
      ctx.beginPath();
      ctx.arc(peg.x, peg.y, PEG_R, 0, Math.PI * 2);
      ctx.fillStyle = peg.glow > 0 ? '#8ffff0' : 'rgba(255,255,255,.22)';
      ctx.fill();
    }
    for (const ball of activeBalls) {
      for (let t = 0; t < ball.trail.length; t++) {
        const tp = ball.trail[t];
        const a = (t / ball.trail.length) * 0.35;
        ctx.beginPath();
        ctx.arc(tp.x, tp.y, BALL_R * (t / ball.trail.length) * 0.75, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 209, ' + a + ')';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_R + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 255, 209, 0.28)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(ball.x - 2, ball.y - 2, 1, ball.x, ball.y, BALL_R);
      grad.addColorStop(0, '#e8fffb');
      grad.addColorStop(1, '#00FFD1');
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  // Drives every active ball's per-step easing (see targetForStep) and the
  // canvas redraw, on a single shared requestAnimationFrame loop shared by
  // however many balls are in flight at once (1 to 25) -- one loop, not one
  // per ball.
  function animationLoop(now) {
    for (let i = activeBalls.length - 1; i >= 0; i--) {
      const ball = activeBalls[i];
      const elapsed = now - ball.stepStartTime;
      const t = Math.min(1, elapsed / ball.stepMs);
      const easedY = t * t; // ease-in -- reads as gravity accelerating the fall within each row
      ball.x = ball.fromX + (ball.toX - ball.fromX) * t;
      ball.y = ball.fromY + (ball.toY - ball.fromY) * easedY;
      ball.trail.push({ x: ball.x, y: ball.y });
      if (ball.trail.length > 7) ball.trail.shift();

      if (t >= 1) {
        // ball.step (before the increment below) is the position just
        // ARRIVED at, so the peg row just crossed to get here is step-1 --
        // valid for every step 1..ROWS since spawnBall() always starts a
        // ball at step 1 (mid-flight across row 0).
        const justCrossedRow = ball.step - 1;
        if (justCrossedRow >= 0 && justCrossedRow < ROWS) {
          const peg = nearestPegInRow(justCrossedRow, ball.x);
          if (peg) peg.glow = 1;
        }
        ball.step++;
        if (ball.step > ROWS) {
          resolveBall(ball);
          activeBalls.splice(i, 1);
          continue;
        }
        if (ball.path[ball.step - 1] === 'R') ball.rightCount++;
        const next = targetForStep(ball.rightCount, ball.step);
        ball.fromX = ball.x; ball.fromY = ball.y;
        ball.toX = next.x; ball.toY = next.y;
        ball.stepStartTime = now;
      }
    }
    drawBoard();
    if (activeBalls.length > 0) {
      rafHandle = requestAnimationFrame(animationLoop);
    } else {
      rafHandle = null;
    }
  }

  function spawnBall(res, stepMs) {
    const start = targetForStep(0, 0);
    const first = targetForStep(res.path[0] === 'R' ? 1 : 0, 1);
    const ball = {
      res, step: 1, rightCount: res.path[0] === 'R' ? 1 : 0,
      fromX: start.x, fromY: start.y, toX: first.x, toY: first.y,
      x: start.x, y: start.y, stepMs, stepStartTime: performance.now(),
      trail: []
    };
    activeBalls.push(ball);
    if (!rafHandle) rafHandle = requestAnimationFrame(animationLoop);
  }

  // Transient flash-then-fade highlight on a slot as a ball lands there --
  // several balls landing in different slots a beat apart each get their own
  // visible flash mid-batch (the final, PERSISTENT highlight on the best
  // slot is a separate thing, driven by lastBatch.landedSlotIndex through
  // buildSlotsRow() in render(), not this function -- see finishBatch()).
  function flashSlot(slotIndex) {
    const row = document.getElementById('pk-slots-row');
    const cell = row && row.children[slotIndex];
    if (!cell) return;
    cell.classList.add('landed');
    setTimeout(() => cell.classList.remove('landed'), 700);
  }

  let batchResolvedCount = 0;
  let batchResults = [];
  function resolveBall(ball) {
    flashSlot(ball.res.slotIndex);
    batchResolvedCount++;
    if (batchResolvedCount >= batchResults.length) finishBatch(batchResults);
  }

  function doDrop(amount) {
    const stake = Math.max(1, Math.floor(Number(amount) || 0));
    const totalCost = stake * ballCount;
    if (totalCost > balance) return toast('Недостатньо KKoin для ' + ballCount + ' куль по ' + stake + ' (треба ' + totalCost + ')', true);
    dropping = true;
    lastBatch = null;
    render();
    socket.emit('casino:plinko_drop_many', { nickname, stake, count: ballCount }, (res) => {
      if (res.error) { dropping = false; toast(res.error, true); render(); return; }
      startBatchAnimation(res.results);
    });
  }

  // Staggers each ball's spawn (matching the reference PlinkoBoard.jsx's own
  // dropBalls(count) idea: don't dump all N balls in at once, trickle them
  // in) and scales both the stagger and each ball's own per-row pace down as
  // the batch grows, so a 25-ball drop still finishes in a few seconds
  // instead of taking as long as 25 sequential single drops would.
  function startBatchAnimation(results) {
    batchResults = results;
    batchResolvedCount = 0;
    const n = results.length;
    const spawnGapMs = n === 1 ? 0 : n <= 5 ? 90 : n <= 10 ? 60 : 35;
    const stepMs = n === 1 ? 220 : n <= 5 ? 170 : n <= 10 ? 120 : 75;
    let i = 0;
    function next() {
      if (i >= n) return;
      spawnBall(results[i], stepMs);
      i++;
      if (i < n) setTimeout(next, spawnGapMs);
    }
    next();
  }

  function finishBatch(results) {
    dropping = false;
    // The animation loop (and with it, the per-frame peg-glow decay in
    // drawBoard()) stops the instant activeBalls empties out, right before
    // this runs -- snap any still-lit pegs fully off here instead of
    // leaving them stuck glowing until the next batch's loop happens to
    // fade them back out.
    for (const peg of pegs.list) peg.glow = 0;
    const totalStake = results.reduce((s, r) => s + r.stake, 0);
    const totalPayout = results.reduce((s, r) => s + r.payout, 0);
    const best = results.reduce((a, b) => (b.multiplier > a.multiplier ? b : a), results[0]);
    lastBatch = {
      count: results.length,
      totalNet: totalPayout - totalStake,
      totalStake, totalPayout,
      bestMultiplier: best.multiplier,
      landedSlotIndex: best.slotIndex, // read by render()'s buildSlotsRow() call below to persist the highlight -- flashSlot() can't do it here, render() is about to wipe and rebuild the whole slots row from scratch
      single: results.length === 1 ? results[0] : null
    };
    balance = results[results.length - 1].balance;
    customBet = '';
    playSfx(lastBatch.totalNet > 0 ? 'impact' : 'move');
    render();
    // dima 2026-07-22 "додай ефекти гарні" -- for a multi-ball batch this
    // only celebrates the SINGLE best result, not one burst per ball (with
    // up to 25 balls, most landing in the flat 0.2x band, firing an effect
    // per ball would be visual/audio spam rather than exciting).
    if (typeof playEffect === 'function') {
      const anchor = document.querySelector('.pk-slot.landed');
      if (anchor) {
        const m = best.multiplier;
        if (m >= 1000) playEffect('explosion', anchor);
        else if (m >= 100) playEffect('lightning', anchor);
        else if (m >= 10) playEffect('firework', anchor);
        else if (m >= 2) playEffect('coin-burst', anchor);
        else if (m <= 0.2 && results.length === 1) playEffect('poison', anchor);
      }
    }
  }

  function buildSlotsRow(landedIndex) {
    // "edge" gold styling: m>=10 covers the top 4 of 7 distinct values
    // (1000/100/20/10 gold, 4/2/0.2 not) -- roughly the same "about half the
    // row reads as a big win" proportion the two rebalances before this one
    // (2026-07-22) also aimed for, just against the new 17-slot number set.
    // Two-line "1000 / x" label (number over a small "x") instead of a
    // single "×1000" string -- matches dima's reference screenshot, which
    // already labels its slots this same way.
    return el('div', { class: 'pk-slots-row', id: 'pk-slots-row' }, MULTIPLIERS.map((m, i) => el('div', {
      class: 'pk-slot' + (m >= 10 ? ' edge' : '') + (landedIndex === i ? ' landed' : '')
    }, [
      el('div', { class: 'pk-slot-num' }, [String(m)]),
      el('div', { class: 'pk-slot-x' }, ['x'])
    ])));
  }

  function resultLineNode() {
    if (!lastBatch) return null;
    const text = lastBatch.single
      ? (lastBatch.totalNet >= 0 ? 'Виграш +' : 'Програш ') + lastBatch.totalNet + ' KKoin (×' + lastBatch.single.multiplier + ')'
      : (lastBatch.totalNet >= 0 ? 'Виграш +' : 'Програш ') + lastBatch.totalNet + ' KKoin · ' + lastBatch.count + ' куль' +
        (lastBatch.bestMultiplier >= 2 ? ' · найкращий кидок ×' + lastBatch.bestMultiplier : '');
    return el('div', { class: 'pk-result-line ' + (lastBatch.totalNet >= 0 ? 'pos' : 'neg') }, [text]);
  }

  function render() {
    clear(app);
    const raw = Math.max(0, Math.floor(balance));
    const presets = [1, 5, 10].filter((n) => n <= raw);
    const totalCost = Math.max(1, Math.floor(Number(customBet) || 0)) * ballCount;

    canvas = el('canvas', { id: 'pk-canvas', class: 'pk-canvas' });
    const boardWrap = el('div', { class: 'pk-board', id: 'pk-board' }, [canvas]);
    const slotsRow = buildSlotsRow(lastBatch ? lastBatch.landedSlotIndex : null);

    const ballCountRow = el('div', { class: 'pk-ballcount-row' }, [
      el('span', { class: 'bj-bet-label' }, ['Куль за раз:']),
      ...BALL_COUNTS.map((n) => el('button', {
        class: 'btn-small' + (n === ballCount ? '' : ' btn-outline') + ' pk-ballcount-btn',
        onclick: () => { ballCount = n; render(); }
      }, [String(n)]))
    ]);

    const controls = dropping
      ? el('div', { class: 'bj-waiting-label', style: 'text-align:center; margin-top:16px;' }, [ballCount > 1 ? 'Кулі падають…' : 'Куля падає…'])
      : el('div', { class: 'bj-bet-block' }, [
        raw < 1 ? el('p', { style: 'text-align:center; color:#C71585;' }, ['Недостатньо KKoin, щоб зробити ставку.']) : null,
        ballCountRow,
        el('div', { class: 'bj-bet-row' }, [
          el('span', { class: 'bj-bet-label' }, ['Ставка за кулю:']),
          ...presets.map((p) => el('button', { class: 'btn-small btn-outline bj-bet-preset', onclick: () => { customBet = String(p); render(); } }, [String(p)])),
          el('input', {
            type: 'number', min: '1', max: String(raw), placeholder: 'Своя сума', value: customBet, style: 'max-width:120px;',
            oninput: (e) => { customBet = e.target.value; render(); },
            onkeydown: (e) => { if (e.key === 'Enter') { if (!customBet) return toast('Впиши суму ставки', true); doDrop(customBet); } }
          }),
          el('button', {
            class: 'bj-deal-btn', style: 'padding:10px 20px; font-size:11px;', disabled: raw < 1 ? 'disabled' : null,
            onclick: () => { if (!customBet) return toast('Впиши суму ставки', true); doDrop(customBet); }
          }, ['\u{1F3B1} Кинути ' + (ballCount > 1 ? 'кулі' : 'кулю')])
        ]),
        customBet ? el('p', { class: 'pk-total-cost-hint' }, ['Загалом: ' + totalCost + ' KKoin (' + customBet + ' × ' + ballCount + ')']) : null
      ]);

    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [
        topBarNode(),
        el('div', { class: 'bj-title-block' }, [
          el('div', { class: 'bj-eyebrow' }, ['/ Казино · Кулі']),
          el('h1', { class: 'bj-title' }, ['Plinko'])
        ]),
        boardWrap,
        slotsRow,
        resultLineNode(),
        el('div', { class: 'bj-controls' }, [controls])
      ])
    ]));

    setupCanvas();
    drawBoard();
  }

  pegs = buildPegs();
  pegsByRow = pegs.byRow;

  requireAccount(app, { title: 'Plinko', emoji: '🔴', backLink: el('a', { href: '/casino.html', class: 'back-link' }, ['← Казино']) }, (login) => {
    nickname = login;
    refreshBalance(render);
  });
})();
