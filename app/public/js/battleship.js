// Морський бій (Battleship) client. Talks to src/socket/miniGameHandlers.js
// via the mg: events; all rules/validation are enforced server-side (see
// src/games/battleship.js) -- this file only renders whatever
// mg:room_state says and stages a LOCAL ship layout before submitting it in
// one shot, same "server is truth" spirit as the rest of this app.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const GAME_TYPE = 'battleship';
  const GRID_SIZE = 10;
  const SHIP_SIZES = [5, 4, 3, 3, 2];
  const SHIP_NAMES = ['Авіаносець', 'Лінкор', 'Крейсер', 'Підводний човен', 'Есмінець'];
  const COL_LABELS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К'];
  // Matches minigames.html's .ds-card--turquoise hue -- see minigame-common.js's
  // mgAccentStyle header comment for the full per-game color mapping.
  const ACCENT = '#17B8A6';

  let roomCode = null;
  let playerIdx = null;
  let roomState = null; // latest mg:room_state payload

  // ---- local ship-placement staging (never sent piecemeal -- submitted as
  // one full layout via mg:battleship_submit_layout once all 5 are placed) ----
  let placements = [];
  let placeDir = 'H';

  function shipCellsFor(x, y, size, dir) {
    const cells = [];
    for (let i = 0; i < size; i++) cells.push(dir === 'H' ? [x + i, y] : [x, y + i]);
    return cells;
  }
  function placedCellSet() {
    const set = new Set();
    placements.forEach(p => shipCellsFor(p.x, p.y, p.size, p.dir).forEach(([cx, cy]) => set.add(cx + ',' + cy)));
    return set;
  }
  function canPlace(x, y, size, dir) {
    const occ = placedCellSet();
    return shipCellsFor(x, y, size, dir).every(([cx, cy]) => cx >= 0 && cx < GRID_SIZE && cy >= 0 && cy < GRID_SIZE && !occ.has(cx + ',' + cy));
  }

  // ---- shared v2 board rendering (2026-07-22 visual overhaul, see the
  // .bship-* v2 block in style.css for the reference this matches) ----

  // Coordinate-labelled 10x10 board: column letters across the top, row
  // numbers down the side, matching GameGrid.jsx's layout. cellBuilder(x,y)
  // returns the actual <button class="bship-cell"> for each square; used
  // identically by the placement board and both battle boards below.
  function buildBoardWrap(cellBuilder) {
    const colLabels = el('div', { class: 'bship-col-labels' }, COL_LABELS.map(c => el('span', {}, [c])));
    const rowLabels = el('div', { class: 'bship-row-labels' }, []);
    const grid = el('div', { class: 'bship-grid' }, []);
    for (let y = 0; y < GRID_SIZE; y++) {
      rowLabels.appendChild(el('span', {}, [String(y + 1)]));
      for (let x = 0; x < GRID_SIZE; x++) grid.appendChild(cellBuilder(x, y));
    }
    return el('div', { class: 'bship-board-wrap' }, [colLabels, el('div', { class: 'bship-board-row' }, [rowLabels, grid])]);
  }

  // Given one ship's cells (order-agnostic -- server data isn't guaranteed
  // bow->stern, shipCellsFor's own output already is but sorting it again is
  // harmless), returns Map<'x,y', class string> with the right bow/stern
  // rounding modifier per segment so ships render as a single rounded hull
  // instead of a row of identical squares (matches ShipSegment.jsx's look,
  // simplified to gradient+rounding only -- see the zip2 read notes on why
  // the full per-segment superstructure SVGs weren't worth porting).
  function shipSegClasses(cells, stateClass) {
    const map = new Map();
    if (!cells.length) return map;
    const horizontal = cells.every(([, cy]) => cy === cells[0][1]);
    const sorted = cells.slice().sort((a, b) => horizontal ? a[0] - b[0] : a[1] - b[1]);
    sorted.forEach(([cx, cy], idx) => {
      let cls = 'bship-ship-seg' + (stateClass ? ' ' + stateClass : '');
      if (idx === 0) cls += horizontal ? ' bow-h' : ' bow-v';
      if (idx === sorted.length - 1) cls += horizontal ? ' stern-h' : ' stern-v';
      map.set(cx + ',' + cy, cls);
    });
    return map;
  }

  function render() {
    clear(app);
    if (!roomState) return;
    if (roomState.status === 'waiting') return mgRenderWaitingForOpponent(app, roomCode, { stake: roomState.stake, accent: ACCENT });
    if (roomState.status === 'finished') return renderFinishedScreen();
    if (roomState.gameState.phase === 'placing') return renderPlacement();
    return renderBattle();
  }

  function renderPlacement() {
    const gs = roomState.gameState;
    const wrap = el('div', {}, []);
    // dima 2026-07-22 "зроби кнопку виходу до головного меню, а то якась
    // пастка" -- the join/waiting-for-opponent screens already have this
    // (see mgRenderJoinScreen in minigame-common.js) and mgResignBar covers
    // the battle phase once shots are flying; placement was the one gap with
    // no way out at all. Safe to leave from here: nothing has been staked
    // yet at this phase (the room only debits KKoin once both players are
    // ready and the battle actually starts), so this is the same
    // no-side-effect abandonment the waiting screen's own back-link already allows.
    wrap.appendChild(el('a', { href: '/minigames.html', class: 'back-link' }, ['← До міні-ігор']));
    wrap.appendChild(el('div', { class: 'row between' }, [
      el('h2', {}, ['🚢 Розміщення кораблів']),
      el('span', { class: 'badge outline' }, ['Кімната ' + roomCode])
    ]));

    if (gs.ready[playerIdx]) {
      wrap.appendChild(el('p', { style: 'font-weight:700; color:var(--turquoise-dark); text-align:center;' }, ['✅ Ваш флот розміщено. Очікуємо суперника…']));
      app.appendChild(wrap);
      return;
    }

    const nextIdx = placements.length;
    const done = nextIdx >= SHIP_SIZES.length;
    wrap.appendChild(el('p', { style: 'text-align:center;' }, [
      done ? 'Усі кораблі розміщено! Перевірте флот і натисніть «Готово».' : ('Розмістіть: ' + SHIP_NAMES[nextIdx] + ' (' + SHIP_SIZES[nextIdx] + ' кл.)')
    ]));

    wrap.appendChild(el('div', { class: 'row', style: 'justify-content:center; margin-bottom:10px; gap:10px;' }, [
      el('button', { class: 'btn-small btn-outline', disabled: done ? 'disabled' : null, onclick: () => { placeDir = placeDir === 'H' ? 'V' : 'H'; render(); } },
        [(placeDir === 'H' ? '↔ Горизонтально' : '↕ Вертикально')]),
      el('button', { class: 'btn-small btn-outline crimson', onclick: () => { placements = []; render(); } }, ['⟲ Скинути'])
    ]));

    // Ship-type legend (matches PlacementPhase.jsx's dot-pip row) -- placed
    // ships shown struck-through, the one you're currently placing
    // highlighted, so the whole fleet's progress is visible at a glance
    // instead of only the single "Розмістіть: X" line above.
    wrap.appendChild(el('div', { class: 'row', style: 'justify-content:center; flex-wrap:wrap; gap:6px; margin-bottom:14px;' },
      SHIP_SIZES.map((size, i) => {
        const placed = i < nextIdx;
        const current = i === nextIdx;
        return el('span', {
          class: 'badge outline',
          style: 'font-size:11px;' + (placed ? ' opacity:.4; text-decoration:line-through;' : current ? ' border-color:var(--turquoise); color:var(--turquoise);' : '')
        }, [SHIP_NAMES[i] + ' (' + size + ')']);
      })
    ));

    const segClassMap = new Map();
    placements.forEach(p => shipSegClasses(shipCellsFor(p.x, p.y, p.size, p.dir), null).forEach((cls, key) => segClassMap.set(key, cls)));
    const cellNodes = new Map();
    function clearPreview() { cellNodes.forEach(node => node.classList.remove('preview-ok', 'preview-bad')); }

    const board = buildBoardWrap((x, y) => {
      const key = x + ',' + y;
      const btn = el('button', {
        class: 'bship-cell' + (done ? '' : ' usable'),
        disabled: done ? 'disabled' : null,
        'aria-label': COL_LABELS[x] + (y + 1),
        onmouseenter: () => {
          if (done) return;
          const size = SHIP_SIZES[placements.length];
          const ok = canPlace(x, y, size, placeDir);
          shipCellsFor(x, y, size, placeDir).forEach(([cx, cy]) => {
            const node = cellNodes.get(cx + ',' + cy);
            if (node) node.classList.add(ok ? 'preview-ok' : 'preview-bad');
          });
        },
        onmouseleave: clearPreview,
        onclick: () => {
          if (done) return;
          const size = SHIP_SIZES[placements.length];
          if (!canPlace(x, y, size, placeDir)) return toast('Тут корабель розмістити не можна (виходить за межі поля або перетинає інший)', true);
          clearPreview();
          placements.push({ x, y, dir: placeDir, size });
          render();
        }
      }, []);
      if (segClassMap.has(key)) btn.appendChild(el('div', { class: segClassMap.get(key) }, []));
      cellNodes.set(key, btn);
      return btn;
    });
    wrap.appendChild(el('div', { style: 'display:flex; justify-content:center;' }, [board]));

    if (done) {
      wrap.appendChild(el('div', { style: 'text-align:center; margin-top:14px;' }, [
        el('button', { onclick: () => {
          socket.emit('mg:battleship_submit_layout', { placements }, (res) => {
            if (res.error) { toast(res.error, true); placements = []; render(); }
          });
        }}, ['Готово, почати бій!'])
      ]));
    }

    app.appendChild(wrap);
  }

  function renderBattle() {
    const gs = roomState.gameState;
    const wrap = el('div', {}, []);
    wrap.appendChild(el('div', { class: 'row between' }, [
      el('h2', {}, ['🚢 Морський бій']),
      el('span', { class: 'badge outline' }, ['Кімната ' + roomCode])
    ]));
    wrap.appendChild(mgResignBar(socket, gs.turn === playerIdx ? 'Ваш хід! Стріляйте у флот суперника.' : 'Хід суперника…', roomState.stake));

    const boardsRow = el('div', { class: 'mg-boards-row' }, []);

    // ---- my own board: my ships + every shot the opponent has fired at me ----
    const myShots = new Map();
    gs.shotsOnMe.forEach(s => myShots.set(s.x + ',' + s.y, s.hit));
    const myShipSegClasses = new Map();
    const mySunkKeys = new Set();
    gs.myShips.forEach(s => {
      const sunk = s.cells.every(([cx, cy]) => myShots.get(cx + ',' + cy) === true);
      if (sunk) s.cells.forEach(([cx, cy]) => mySunkKeys.add(cx + ',' + cy));
      shipSegClasses(s.cells, sunk ? 'sunk' : null).forEach((cls, key) => myShipSegClasses.set(key, cls));
    });
    const myBoard = buildBoardWrap((x, y) => {
      const key = x + ',' + y;
      const btn = el('button', { class: 'bship-cell', disabled: 'disabled', 'aria-label': COL_LABELS[x] + (y + 1) }, []);
      if (myShipSegClasses.has(key)) {
        let segCls = myShipSegClasses.get(key);
        if (myShots.get(key) === true && !mySunkKeys.has(key)) segCls += ' hit';
        btn.appendChild(el('div', { class: segCls }, []));
      }
      if (myShots.has(key)) {
        const hit = myShots.get(key);
        // A hit that already sunk the ship is conveyed by the darker .sunk
        // hull color above -- stacking the bright hit-mark glow on top of it
        // too just reads as clutter, so it's only shown for a hit that
        // hasn't (yet) finished off its ship.
        if (hit && !mySunkKeys.has(key)) btn.appendChild(el('div', { class: 'bship-hit-mark' }, []));
        else if (!hit) btn.appendChild(el('div', { class: 'bship-miss-mark' }, []));
      }
      return btn;
    });
    boardsRow.appendChild(el('div', {}, [el('div', { class: 'mg-board-label' }, ['Ваш флот']), myBoard]));

    // ---- opponent's board: fog of war, click to fire ----
    const oppShots = new Map();
    gs.shotsIFired.forEach(s => oppShots.set(s.x + ',' + s.y, s.hit));
    const oppSunkSegClasses = new Map();
    const oppSunkKeys = new Set();
    gs.opponentSunkShips.forEach(s => {
      s.cells.forEach(([cx, cy]) => oppSunkKeys.add(cx + ',' + cy));
      shipSegClasses(s.cells, 'sunk').forEach((cls, key) => oppSunkSegClasses.set(key, cls));
    });
    const canFire = gs.turn === playerIdx;
    const oppBoard = buildBoardWrap((x, y) => {
      const key = x + ',' + y;
      const alreadyShot = oppShots.has(key);
      const sunk = oppSunkKeys.has(key);
      const usable = canFire && !alreadyShot && !sunk;
      const btn = el('button', {
        class: 'bship-cell' + (usable ? ' usable' : ''),
        disabled: usable ? null : 'disabled',
        'aria-label': COL_LABELS[x] + (y + 1),
        onclick: (e) => {
          if (!usable) return; // belt-and-suspenders, same pattern as player.js's board cells
          // captured synchronously -- a broadcast-driven render() could
          // replace this exact node before the socket callback below runs
          // (see file header: battleship's board updates come from
          // mg:room_state, not this call's own response), so a plain rect
          // is safer than holding onto e.currentTarget itself.
          const clickRect = e.currentTarget.getBoundingClientRect();
          socket.emit('mg:battleship_fire', { x, y }, (res) => {
            if (res.error) { toast(res.error, true); return; }
            playSfx(res.hit ? 'impact' : 'move');
            if (res.hit && typeof playEffect === 'function') playEffect('impact', clickRect);
          });
        }
      }, []);
      // Fog of war: a sunk ship reveals its full hull shape; a hit that
      // hasn't sunk its ship yet only reveals a hit-mark on this one square
      // (we don't know the rest of that ship's shape until it's sunk).
      if (sunk && oppSunkSegClasses.has(key)) btn.appendChild(el('div', { class: oppSunkSegClasses.get(key) }, []));
      if (alreadyShot) {
        const hit = oppShots.get(key);
        if (hit && !sunk) btn.appendChild(el('div', { class: 'bship-hit-mark' }, []));
        else if (!hit) btn.appendChild(el('div', { class: 'bship-miss-mark' }, []));
      }
      return btn;
    });
    boardsRow.appendChild(el('div', {}, [el('div', { class: 'mg-board-label' }, ['Флот суперника (стріляти сюди)']), oppBoard]));

    wrap.appendChild(boardsRow);
    app.appendChild(wrap);
  }

  function renderFinishedScreen() {
    const wrap = el('div', {}, [el('h2', { style: 'text-align:center;' }, ['🚢 Морський бій'])]);
    wrap.appendChild(mgFinishedBanner(playerIdx, roomState.gameState.winnerIdx, roomState.resignedIdx, null, () => {
      socket.emit('mg:rematch', { gameType: GAME_TYPE, roomCode }, (res) => {
        if (res && res.error) { toast(res.error, true); render(); return; }
        placements = []; // скинути локально застейджений флот попереднього раунду
      });
    }, roomState.stake));
    app.appendChild(wrap);
  }

  function showJoinScreen() {
    mgRenderJoinScreen(socket, app, {
      gameType: GAME_TYPE, gameLabel: 'Морський бій', emoji: '🚢', accent: ACCENT,
      tagline: 'Розстав флот і топи кораблі суперника',
      onJoined: ({ roomCode: rc, playerIdx: pi, room }) => { roomCode = rc; playerIdx = pi; roomState = room; placements = []; render(); }
    });
  }

  // Resume a previous session immediately if one is stored (Socket.IO
  // queues emits made before the connection finishes, so this is safe to
  // call right away rather than waiting for 'connect').
  mgTryReconnect(socket, GAME_TYPE, (ok, res) => {
    if (ok) { roomCode = res.room.code; playerIdx = res.playerIdx; roomState = res.room; render(); }
    else showJoinScreen();
  });

  // Re-sync on every (re)connect for an ALREADY-joined room -- covers a
  // network blip mid-game, not just the initial page load.
  socket.on('connect', () => {
    if (!roomCode) return;
    socket.emit('mg:reconnect', { gameType: GAME_TYPE, roomCode, nickname: localStorage.getItem('sigame_nickname') }, (res) => {
      if (!res.error) { roomState = res.room; playerIdx = res.playerIdx; render(); }
    });
  });

  socket.on('mg:room_state', (state) => {
    if (!roomCode || state.code !== roomCode) return;
    roomState = state;
    if (state.myPlayerIdx !== null && state.myPlayerIdx !== undefined) playerIdx = state.myPlayerIdx;
    render();
  });
})();
