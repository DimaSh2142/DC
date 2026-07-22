// Рулетка (Roulette) client -- shared multiplayer table, 2026-07-22 Казино
// Phase 2. European single-zero wheel: straight-up number bets + the
// standard even-money outside bets (red/black, odd/even, low/high). All
// rules/RNG live server-side (src/games/roulette.js) -- the winning number
// is decided the instant casino:roulette_spin is called, BEFORE this file
// ever sees it; the "spin" the player watches is purely a client-side
// animation that always ends on the number the server already picked (see
// renderReel below). No reference design exists for this page (dima's
// base44 export never had a working Roulette, only the "СКОРО" placeholder
// card on casino.html) -- built fresh in the same dark casino visual
// language as blackjack.js (bj-topbar/coin-chip/ds-panel), plus new rl-*
// classes for the number grid and spinning reel.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const TABLE_STORAGE_KEY = 'rl_table_code';
  const OUTSIDE_LABELS = { red: 'Червоне', black: 'Чорне', odd: 'Непарне', even: 'Парне', low: '1-18', high: '19-36' };

  let nickname = null;
  let balance = 0;
  let tableCode = null;
  let tableState = null;
  let chipSize = 5;
  let draftBets = []; // [{ type, number?, amount }] -- local, not yet sent to the server
  let lastAnimatedNumber = null; // guards against re-animating the reel on every unrelated re-render

  function refreshBalance(cb) {
    fetch('/api/profile/' + encodeURIComponent(nickname)).then((r) => r.json()).then((data) => {
      balance = (data && data.profile && data.profile.kkoin) || 0;
      if (cb) cb();
    }).catch(() => { if (cb) cb(); });
  }

  function colorOfNumber(n) {
    if (n === 0) return 'green';
    const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
    return RED.has(n) ? 'red' : 'black';
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
  function titleBlockNode(subtitle) {
    return el('div', { class: 'bj-title-block' }, [
      el('div', { class: 'bj-eyebrow' }, ['/ Казино · Колесо']),
      el('h1', { class: 'bj-title' }, ['Рулетка' + (subtitle ? ' — ' + subtitle : '')])
    ]);
  }

  function render() {
    clear(app);
    if (!tableState) return renderJoinScreen();
    if (tableState.status === 'lobby') return renderLobby();
    return renderResult();
  }

  function renderJoinScreen() {
    const codeInput = el('input', { type: 'text', placeholder: 'Код столу', maxlength: '8', style: 'text-transform:uppercase; letter-spacing:3px; font-weight:700;' });
    const panel = el('div', { class: 'ds-panel', style: 'max-width:440px; margin:18px auto 0;' }, [
      el('p', { style: 'color:var(--ds-text-dim); font-size:13px; line-height:1.6; margin-top:0;' }, [
        'Європейське колесо (0-36, без подвійного зеро). Кожен ставить своє, потім будь-хто крутить колесо для всього столу одразу.'
      ]),
      el('div', { style: 'display:flex; flex-direction:column; gap:14px;' }, [
        el('button', { class: 'btn-small', style: 'width:100%;', onclick: doCreateTable }, ['➕ Створити новий стіл']),
        el('div', { style: 'display:flex; gap:8px; align-items:flex-end;' }, [
          el('div', { style: 'flex:1;' }, [el('label', {}, ['Або приєднатись за кодом']), codeInput]),
          el('button', { class: 'btn-small btn-outline', onclick: () => {
            const c = codeInput.value.trim().toUpperCase();
            if (!c) return toast('Вкажіть код столу', true);
            doJoinTable(c);
          } }, ['Приєднатись'])
        ])
      ])
    ]);
    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBarNode(), titleBlockNode(null), panel])
    ]));
  }

  function doCreateTable() {
    socket.emit('casino:roulette_create', { nickname }, (res) => {
      if (res.error) return toast(res.error, true);
      tableCode = res.table.code; tableState = res.table;
      localStorage.setItem(TABLE_STORAGE_KEY, tableCode);
      render();
    });
  }
  function doJoinTable(code) {
    socket.emit('casino:roulette_join', { roomCode: code, nickname }, (res) => {
      if (res.error) return toast(res.error, true);
      tableCode = res.table.code; tableState = res.table;
      localStorage.setItem(TABLE_STORAGE_KEY, tableCode);
      render();
    });
  }

  function mySeat() {
    if (!tableState) return null;
    return tableState.seats.find(s => s.nickname.trim().toLowerCase() === (nickname || '').trim().toLowerCase()) || null;
  }

  function addDraftBet(type, number) {
    const existing = draftBets.find(b => b.type === type && b.number === number);
    if (existing) existing.amount += chipSize;
    else draftBets.push({ type, number, amount: chipSize });
    renderDraftOnly();
  }
  function removeDraftBet(idx) { draftBets.splice(idx, 1); renderDraftOnly(); }
  function draftTotal() { return draftBets.reduce((sum, b) => sum + b.amount, 0); }

  // Re-render just the draft/bet-picker panel (not the whole seats row) so
  // clicking chips feels instant without a full server round-trip.
  function renderDraftOnly() {
    const holder = document.getElementById('rl-draft-holder');
    if (holder) { clear(holder); holder.appendChild(draftPanelInner()); }
  }

  function betLabel(b) {
    return b.type === 'straight' ? ('Число ' + b.number) : OUTSIDE_LABELS[b.type];
  }

  function draftPanelInner() {
    const list = draftBets.length ? el('div', { class: 'rl-draft-list' }, draftBets.map((b, i) => el('div', { class: 'rl-draft-item' }, [
      el('span', {}, [betLabel(b) + ' — ' + b.amount + ' KKoin']),
      el('button', { class: 'rl-draft-remove', onclick: () => removeDraftBet(i) }, ['✕'])
    ]))) : el('p', { style: 'text-align:center; font-size:12px; color:var(--ds-text-dimmer);' }, ['Ще немає ставок -- клацни по числу або кольору нижче.']);
    return el('div', {}, [
      list,
      el('div', { style: 'text-align:center; margin-top:10px; font-weight:800; font-size:13px;' }, ['Разом: ' + draftTotal() + ' KKoin']),
      el('div', { style: 'text-align:center; margin-top:10px;' }, [
        el('button', { class: 'btn-small', disabled: draftBets.length ? null : 'disabled', onclick: submitDraft }, ['Поставити']),
        ' ',
        el('button', { class: 'btn-small btn-outline', disabled: draftBets.length ? null : 'disabled', onclick: () => { draftBets = []; renderDraftOnly(); } }, ['Очистити'])
      ])
    ]);
  }

  function submitDraft() {
    if (draftTotal() > balance) return toast('Недостатньо KKoin для цих ставок', true);
    socket.emit('casino:roulette_bet', { bets: draftBets }, (res) => {
      if (res && res.error) return toast(res.error, true);
      draftBets = [];
      toast('Ставки прийнято');
    });
  }

  function renderLobby() {
    // load whatever this seat already has staked from the server as the
    // starting draft, so re-opening the page mid-lobby doesn't lose it.
    const existingMine = mySeat();
    if (existingMine && draftBets.length === 0 && existingMine.pendingBets.length) draftBets = existingMine.pendingBets.map(b => ({ ...b }));

    const numberGrid = el('div', { class: 'rl-numbers-grid' }, Array.from({ length: 37 }, (_, n) => {
      const active = draftBets.some(b => b.type === 'straight' && b.number === n);
      return el('button', { class: 'rl-num-btn ' + colorOfNumber(n) + (active ? ' active' : ''), onclick: () => addDraftBet('straight', n) }, [String(n)]);
    }));
    const outsideRow = el('div', { class: 'rl-outside-row' }, Object.keys(OUTSIDE_LABELS).map((type) => {
      const active = draftBets.some(b => b.type === type);
      return el('button', { class: 'rl-outside-btn' + (active ? ' active' : ''), onclick: () => addDraftBet(type, undefined) }, [OUTSIDE_LABELS[type] + ' · ×2']);
    }));
    const chipInput = el('input', { type: 'number', min: '1', value: String(chipSize), style: 'max-width:90px;', oninput: (e) => { chipSize = Math.max(1, Math.floor(Number(e.target.value) || 1)); } });

    const seatRows = tableState.seats.map((s) => el('div', { class: 'bjt-lobby-row' + (s.connected ? '' : ' offline') }, [
      avatarEl(s, 28),
      el('span', { class: 'bjt-lobby-row-name' }, [s.nickname + (s.connected ? '' : ' · офлайн')]),
      el('span', { class: 'bjt-lobby-row-bet' + (s.pendingTotal > 0 ? '' : ' none') }, [s.pendingTotal > 0 ? ('\u{1FA99} ' + s.pendingTotal) : 'без ставки'])
    ]));

    const bettingCount = tableState.seats.filter(s => s.pendingTotal > 0).length;
    const canSpin = bettingCount >= 1;

    const panel = el('div', { class: 'ds-panel', style: 'max-width:560px; margin:18px auto 0;' }, [
      el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;' }, [
        el('div', { class: 'ds-panel-label', style: 'margin:0;' }, ['Стіл ', el('span', { class: 'room-code', style: 'font-size:16px; padding:2px 10px;' }, [tableState.code])]),
        el('button', { class: 'btn-small btn-outline crimson', style: 'padding:6px 12px; font-size:10px;', onclick: () => {
          socket.emit('casino:roulette_leave', {}, (res) => {
            if (res && res.error) return toast(res.error, true);
            localStorage.removeItem(TABLE_STORAGE_KEY);
            tableCode = null; tableState = null; draftBets = [];
            render();
          });
        } }, ['Вийти'])
      ]),
      el('div', { class: 'bjt-lobby-players' }, seatRows),
      el('div', { style: 'margin-top:16px;' }, [numberGrid]),
      outsideRow,
      el('div', { class: 'rl-chip-row' }, [el('span', { style: 'font-size:12px; color:var(--ds-text-dim);' }, ['Розмір фішки:']), chipInput]),
      el('div', { id: 'rl-draft-holder' }, [draftPanelInner()]),
      el('div', { style: 'text-align:center; margin-top:20px;' }, [
        el('button', { class: 'bj-deal-btn', disabled: canSpin ? null : 'disabled', onclick: () => {
          socket.emit('casino:roulette_spin', {}, (res) => { if (res && res.error) toast(res.error, true); });
        } }, ['\u{1F3B0} Крутити колесо' + (canSpin ? '' : ' (потрібна хоча б 1 ставка)')])
      ])
    ]);
    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBarNode(), titleBlockNode('за столом · лобі'), panel])
    ]));
  }

  function renderReel(winningNumber, shouldAnimate) {
    const seq = [];
    if (shouldAnimate) { for (let i = 0; i < 32; i++) seq.push(Math.floor(Math.random() * 37)); }
    seq.push(winningNumber);
    const strip = el('div', { class: 'rl-reel-strip' }, seq.map(n => el('div', { class: 'rl-reel-cell ' + colorOfNumber(n) }, [String(n)])));
    const wrap = el('div', { class: 'rl-reel-wrap' }, [el('div', { class: 'rl-reel-marker' }), strip]);
    if (shouldAnimate) {
      requestAnimationFrame(() => {
        const wrapWidth = wrap.getBoundingClientRect().width || 460;
        const cellWidth = 54;
        const offset = (seq.length - 0.5) * cellWidth - wrapWidth / 2;
        // dima 2026-07-22 "зроби щоб колесо крутилось в 3 рази довше" -- was 3.2s.
        strip.style.transition = 'transform 9.6s cubic-bezier(.13,.78,.22,1)';
        strip.style.transform = 'translateX(-' + offset + 'px)';
      });
    } else {
      const cellWidth = 54;
      strip.style.transform = 'translateX(-' + (0.5 * cellWidth) + 'px)';
    }
    return wrap;
  }

  function renderResult() {
    const wasAlreadyAnimated = lastAnimatedNumber === tableState.winningNumber + ':' + tableState.code;
    const reel = renderReel(tableState.winningNumber, !wasAlreadyAnimated);
    lastAnimatedNumber = tableState.winningNumber + ':' + tableState.code;

    const seatNodes = tableState.seats.filter(s => s.lastResult).map((s) => {
      const net = s.lastResult.net;
      const cls = net > 0 ? 'pos' : (net < 0 ? 'neg' : 'zero');
      const isMe = s.nickname.trim().toLowerCase() === (nickname || '').trim().toLowerCase();
      return el('div', { class: 'rl-seat' + (s.connected ? '' : ' offline') + (isMe ? ' is-me' : '') }, [
        avatarEl(s, 32),
        el('div', { class: 'rl-seat-name' }, [s.nickname]),
        el('div', { class: 'rl-seat-net ' + cls }, [(net > 0 ? '+' : '') + net + ' KKoin']),
        el('div', { class: 'rl-seat-bets' }, [s.lastResult.bets.map(b => betLabel(b) + ' (' + b.amount + ')').join(', ')])
      ]);
    });
    const spectators = tableState.seats.filter(s => !s.lastResult);

    const panel = el('div', { class: 'ds-panel', style: 'max-width:640px; margin:18px auto 0; text-align:center;' }, [
      el('div', { class: 'ds-panel-label', style: 'margin:0 0 4px; justify-content:center;' }, ['Стіл ', el('span', { class: 'room-code', style: 'font-size:16px; padding:2px 10px;' }, [tableState.code])]),
      reel,
      el('div', { class: 'rl-reel-result-line' }, ['Випало: ' + tableState.winningNumber + ' (' + ({ red: 'червоне', black: 'чорне', green: 'зеро' }[tableState.winningColor]) + ')']),
      el('div', { class: 'rl-seats-row' }, seatNodes),
      spectators.length ? el('p', { style: 'font-size:11px; color:var(--ds-text-dimmer);' }, [spectators.map(s => s.nickname).join(', ') + ' спостерігали цей спін без ставки.']) : null,
      el('button', { class: 'bj-deal-btn', style: 'margin-top:10px;', onclick: () => {
        socket.emit('casino:roulette_new_round', {}, (res) => { if (res && res.error) toast(res.error, true); refreshBalance(); });
      } }, ['\u{1F501} Нова ставка'])
    ]);
    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBarNode(), titleBlockNode('стіл · ' + tableState.code), panel])
    ]));
    refreshBalance(() => { const chip = app.querySelector('.bj-coin-value'); if (chip) chip.textContent = String(balance); });

    // dima 2026-07-22 "додай ефекти гарні, в казино там і в іграх" -- reuses
    // the wasAlreadyAnimated guard above so this fires exactly once per new
    // spin, not on every unrelated re-render while the result stays on screen.
    if (!wasAlreadyAnimated && typeof playEffect === 'function') {
      const my = mySeat();
      if (my && my.lastResult) {
        const anchor = document.querySelector('.rl-seat.is-me') || document.querySelector('.rl-reel-result-line');
        const hitStraight = my.lastResult.bets.some(b => b.type === 'straight' && b.number === tableState.winningNumber);
        if (hitStraight) playEffect('lightning', anchor);
        else if (my.lastResult.net > 0) playEffect('coin-burst', anchor);
        else if (my.lastResult.net < 0) playEffect('poison', anchor);
      }
    }
  }

  socket.on('casino:roulette_state', (state) => {
    if (!tableCode || state.code !== tableCode) return;
    tableState = state;
    render();
  });

  socket.on('connect', () => {
    if (tableCode) {
      socket.emit('casino:roulette_reconnect', { roomCode: tableCode, nickname }, (res) => {
        if (res && res.ok) { tableState = res.table; render(); }
      });
    }
  });

  requireAccount(app, { title: 'Рулетка', emoji: '🎡', backLink: el('a', { href: '/casino.html', class: 'back-link' }, ['← Казино']) }, (login) => {
    nickname = login;
    refreshBalance(() => {
      const stored = localStorage.getItem(TABLE_STORAGE_KEY);
      if (stored) {
        socket.emit('casino:roulette_reconnect', { roomCode: stored, nickname }, (res) => {
          if (res && res.ok) { tableCode = res.table.code; tableState = res.table; }
          else localStorage.removeItem(TABLE_STORAGE_KEY);
          render();
        });
      } else {
        render();
      }
    });
  });
})();
