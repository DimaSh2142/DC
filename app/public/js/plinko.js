// Plinko client -- solo, no table/room at all (see src/state/plinkoManager.js's
// header comment). One request/response per drop: the client sends a stake,
// the server deducts it, simulates the whole path, pays out, and returns
// the path + result in one shot (src/games/plinko.js's simulatePath/payout).
// This file only ANIMATES the ball falling along that already-decided path
// -- it never generates or trusts a client-side outcome, same "server is
// truth" discipline as every other casino game here. ROWS/MULTIPLIERS below
// are mirrored from games/plinko.js purely to draw the board/slot labels
// before a drop happens; the actual multiplier/payout shown after a drop
// always comes straight from the server's response, never recomputed here.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  // 2026-07-22 "набагато більше квадратиків... і з такими ж іксами" (dima's
  // reference screenshot) -- kept in sync with games/plinko.js's own
  // ROWS/MULTIPLIERS by hand (see that file's header: this copy is
  // display-only, the server never trusts anything computed here).
  const ROWS = 16;
  const MULTIPLIERS = [1000, 100, 20, 10, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 10, 20, 100, 1000];

  let nickname = null;
  let balance = 0;
  let customBet = '';
  let dropping = false;
  let lastResult = null; // { slotIndex, multiplier, payout, net, stake } once a drop finishes animating

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

  function buildBoard() {
    const board = el('div', { class: 'pk-board', id: 'pk-board' }, []);
    // decorative peg rows (purely visual -- the real random walk happens
    // server-side, these dots don't influence anything)
    for (let r = 1; r <= ROWS; r++) {
      const pegCount = r + 1;
      for (let p = 0; p < pegCount; p++) {
        const xPct = (50) + (p - (pegCount - 1) / 2) * (80 / ROWS);
        const yPct = (r / (ROWS + 1)) * 92 + 4;
        board.appendChild(el('div', { class: 'pk-peg', style: 'left:' + xPct + '%; top:' + yPct + '%;' }));
      }
    }
    const ball = el('div', { class: 'pk-ball', id: 'pk-ball', style: 'left:50%; top:4%; opacity:0;' });
    board.appendChild(ball);
    return board;
  }

  function buildSlotsRow(landedIndex) {
    // "edge" gold styling: m>=10 covers the top 4 of 7 distinct values
    // (1000/100/20/10 gold, 4/2/0.2 not) -- roughly the same "about half the
    // row reads as a big win" proportion the two rebalances before this one
    // (2026-07-22) also aimed for, just against the new 17-slot number set.
    // Two-line "1000 / x" label (number over a small "x") instead of a
    // single "×1000" string -- with 17 slots crammed into the row now
    // (up from 11), that's the only way "1000" and "0.2" both stay readable
    // instead of wrapping or overflowing their cell. Matches dima's
    // reference screenshot, which already labels its slots this same way.
    return el('div', { class: 'pk-slots-row', id: 'pk-slots-row' }, MULTIPLIERS.map((m, i) => el('div', {
      class: 'pk-slot' + (m >= 10 ? ' edge' : '') + (landedIndex === i ? ' landed' : '')
    }, [
      el('div', { class: 'pk-slot-num' }, [String(m)]),
      el('div', { class: 'pk-slot-x' }, ['x'])
    ])));
  }

  function render() {
    clear(app);
    const raw = Math.max(0, Math.floor(balance));
    const presets = [1, 5, 10].filter((n) => n <= raw);

    const board = buildBoard();
    const slotsRow = buildSlotsRow(lastResult ? lastResult.slotIndex : null);

    const controls = dropping
      ? el('div', { class: 'bj-waiting-label', style: 'text-align:center; margin-top:16px;' }, ['Куля падає…'])
      : el('div', { class: 'bj-bet-block' }, [
        raw < 1 ? el('p', { style: 'text-align:center; color:#C71585;' }, ['Недостатньо KKoin, щоб зробити ставку.']) : null,
        el('div', { class: 'bj-bet-row' }, [
          el('span', { class: 'bj-bet-label' }, ['Ставка:']),
          ...presets.map((p) => el('button', { class: 'btn-small btn-outline bj-bet-preset', onclick: () => doDrop(p) }, [String(p)])),
          el('input', {
            type: 'number', min: '1', max: String(raw), placeholder: 'Своя сума', value: customBet, style: 'max-width:120px;',
            oninput: (e) => { customBet = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') { if (!customBet) return toast('Впиши суму ставки', true); doDrop(customBet); } }
          }),
          el('button', {
            class: 'bj-deal-btn', style: 'padding:10px 20px; font-size:11px;', disabled: raw < 1 ? 'disabled' : null,
            onclick: () => { if (!customBet) return toast('Впиши суму ставки', true); doDrop(customBet); }
          }, ['\u{1F3B1} Кинути кулю'])
        ])
      ]);

    const resultLine = lastResult ? el('div', { class: 'pk-result-line ' + (lastResult.net >= 0 ? 'pos' : 'neg') }, [
      (lastResult.net >= 0 ? 'Виграш +' : 'Програш ') + lastResult.net + ' KKoin (×' + lastResult.multiplier + ')'
    ]) : null;

    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [
        topBarNode(),
        el('div', { class: 'bj-title-block' }, [
          el('div', { class: 'bj-eyebrow' }, ['/ Казино · Кулі']),
          el('h1', { class: 'bj-title' }, ['Plinko'])
        ]),
        board,
        slotsRow,
        resultLine,
        el('div', { class: 'bj-controls' }, [controls])
      ])
    ]));
  }

  function doDrop(amount) {
    const stake = Math.max(1, Math.floor(Number(amount) || 0));
    if (stake > balance) return toast('Недостатньо KKoin для такої ставки', true);
    dropping = true;
    lastResult = null;
    render();
    socket.emit('casino:plinko_drop', { nickname, stake }, (res) => {
      if (res.error) { dropping = false; toast(res.error, true); render(); return; }
      animateBall(res);
    });
  }

  // Walks the ball down the board following the server-decided path, one
  // row per step. At step t, the ball's horizontal slot position is set to
  // the CONDITIONAL EXPECTATION of the final slot given the first t bounces
  // (cumulative rights so far, plus 0.5 per remaining unresolved bounce) --
  // this is mathematically the expected value, not a cosmetic guess, so the
  // ball visually converges smoothly toward wherever it's actually going to
  // land instead of jumping around.
  function animateBall(res) {
    const ball = document.getElementById('pk-board') && document.getElementById('pk-ball');
    if (!ball) { finishDrop(res); return; }
    ball.style.opacity = '1';
    let rightCount = 0;
    let step = 0;
    const stepMs = 220;
    function tick() {
      if (step > ROWS) { setTimeout(() => finishDrop(res), 250); return; }
      if (step > 0 && res.path[step - 1] === 'R') rightCount++;
      const expectedSlot = rightCount + (ROWS - step) * 0.5;
      const xPct = (expectedSlot / ROWS) * 100;
      const yPct = (step / (ROWS + 1)) * 92 + 4;
      ball.style.left = xPct + '%';
      ball.style.top = yPct + '%';
      step++;
      setTimeout(tick, stepMs);
    }
    tick();
  }

  function finishDrop(res) {
    dropping = false;
    lastResult = { slotIndex: res.slotIndex, multiplier: res.multiplier, payout: res.payout, net: res.net, stake: res.stake };
    balance = res.balance;
    customBet = '';
    playSfx(res.net > 0 ? 'impact' : 'move');
    render();
    // dima 2026-07-22 "додай ефекти гарні, в казино там і в іграх" -- tiered
    // by how good the multiplier is, from the landed slot itself (the one
    // with the .landed class buildSlotsRow just added). Only the genuinely
    // exciting outcomes get a burst -- a plain 1x (breakeven-ish) stays
    // quiet, same "don't wear out the novelty" restraint as playSfx above.
    if (typeof playEffect === 'function') {
      const anchor = document.querySelector('.pk-slot.landed');
      if (anchor) {
        // Retiered for the new 17-slot table (2026-07-22 board rebuild) --
        // 1000x is a brand-new, ~16x rarer top tier than the old max (100x),
        // so it gets its own biggest/rarest sprite (explosion, previously
        // unused by Plinko) instead of sharing "lightning" with 100x.
        if (res.multiplier >= 1000) playEffect('explosion', anchor);
        else if (res.multiplier >= 100) playEffect('lightning', anchor);
        else if (res.multiplier >= 10) playEffect('firework', anchor);
        else if (res.multiplier >= 2) playEffect('coin-burst', anchor);
        else if (res.multiplier <= 0.2) playEffect('poison', anchor);
      }
    }
  }

  requireAccount(app, { title: 'Plinko', emoji: '🔴', backLink: el('a', { href: '/casino.html', class: 'back-link' }, ['← Казино']) }, (login) => {
    nickname = login;
    refreshBalance(render);
  });
})();
