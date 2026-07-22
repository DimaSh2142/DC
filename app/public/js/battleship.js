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

  function render() {
    clear(app);
    if (!roomState) return;
    if (roomState.status === 'waiting') return mgRenderWaitingForOpponent(app, roomCode, { stake: roomState.stake });
    if (roomState.status === 'finished') return renderFinishedScreen();
    if (roomState.gameState.phase === 'placing') return renderPlacement();
    return renderBattle();
  }

  function renderPlacement() {
    const gs = roomState.gameState;
    const wrap = el('div', {}, []);
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
        ['Напрямок: ' + (placeDir === 'H' ? 'Горизонтально →' : 'Вертикально ↓')]),
      el('button', { class: 'btn-small btn-outline crimson', onclick: () => { placements = []; render(); } }, ['Скинути розміщення'])
    ]));

    const occupied = placedCellSet();
    const grid = el('div', { class: 'bship-grid' }, []);
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const isShip = occupied.has(x + ',' + y);
        grid.appendChild(el('button', {
          class: 'bship-cell' + (isShip ? ' ship' : ''),
          disabled: done ? 'disabled' : null,
          onclick: () => {
            if (done) return;
            const size = SHIP_SIZES[placements.length];
            if (!canPlace(x, y, size, placeDir)) return toast('Тут корабель розмістити не можна (виходить за межі поля або перетинає інший)', true);
            placements.push({ x, y, dir: placeDir, size });
            render();
          }
        }, []));
      }
    }
    wrap.appendChild(el('div', { style: 'display:flex; justify-content:center;' }, [grid]));

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
    const myShipCells = new Set();
    gs.myShips.forEach(s => s.cells.forEach(([cx, cy]) => myShipCells.add(cx + ',' + cy)));
    const myGrid = el('div', { class: 'bship-grid' }, []);
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const key = x + ',' + y;
        let cls = 'bship-cell';
        let label = '';
        if (myShots.has(key)) {
          const hit = myShots.get(key);
          cls += hit ? ' hit' : ' miss';
          label = hit ? '✕' : '·';
        } else if (myShipCells.has(key)) {
          cls += ' ship';
        }
        myGrid.appendChild(el('button', { class: cls, disabled: 'disabled' }, [label]));
      }
    }
    boardsRow.appendChild(el('div', {}, [el('div', { class: 'mg-board-label' }, ['Ваш флот']), myGrid]));

    // ---- opponent's board: fog of war, click to fire ----
    const oppShots = new Map();
    gs.shotsIFired.forEach(s => oppShots.set(s.x + ',' + s.y, s.hit));
    const oppSunkCells = new Set();
    gs.opponentSunkShips.forEach(s => s.cells.forEach(([cx, cy]) => oppSunkCells.add(cx + ',' + cy)));
    const canFire = gs.turn === playerIdx;
    const oppGrid = el('div', { class: 'bship-grid' }, []);
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const key = x + ',' + y;
        let cls = 'bship-cell';
        let label = '';
        const alreadyShot = oppShots.has(key);
        if (oppSunkCells.has(key)) { cls += ' sunk'; label = '💀'; }
        else if (alreadyShot) { const hit = oppShots.get(key); cls += hit ? ' hit' : ' miss'; label = hit ? '✕' : '·'; }
        const usable = canFire && !alreadyShot && !oppSunkCells.has(key);
        oppGrid.appendChild(el('button', {
          class: cls,
          disabled: usable ? null : 'disabled',
          onclick: () => {
            if (!usable) return; // belt-and-suspenders, same pattern as player.js's board cells
            socket.emit('mg:battleship_fire', { x, y }, (res) => {
              if (res.error) { toast(res.error, true); return; }
              playSfx(res.hit ? 'impact' : 'move');
            });
          }
        }, [label]));
      }
    }
    boardsRow.appendChild(el('div', {}, [el('div', { class: 'mg-board-label' }, ['Флот суперника (стріляти сюди)']), oppGrid]));

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
      gameType: GAME_TYPE, gameLabel: 'Морський бій', emoji: '🚢',
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
