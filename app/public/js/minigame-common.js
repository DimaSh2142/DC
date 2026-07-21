// Shared client-side chrome for the 3 mini-game pages (battleship.js/
// checkers.js/chess.js). Each page's own JS still owns its render()
// dispatch and game-specific board rendering (grids differ enormously
// between a 10x10 fog-of-war Battleship board, an 8x8 checkers board, and a
// chessboard) -- this file only factors out the identical "type a nickname,
// create or join a room by code" screen, the reconnect-after-refresh flow,
// the resign button, and the game-over banner, so the three games share one
// implementation of that chrome instead of three hand-duplicated (and
// eventually drifting) copies. Loaded after common.js, before the
// game-specific script -- see each game's .html.

function mgRoomStorageKey(gameType) { return 'mg_room_' + gameType; }

// Renders the "join or create a room" screen into #app. Calls
// onJoined({ roomCode, playerIdx, room }) once socket join/create succeeds
// (the caller owns roomState/render() from that point on).
function mgRenderJoinScreen(socket, app, opts) {
  const nickname = localStorage.getItem('sigame_nickname') || '';
  const nickInput = el('input', { type: 'text', placeholder: 'Наприклад, Діма', value: nickname, maxlength: '24' });
  const codeInput = el('input', { type: 'text', placeholder: 'Код кімнати', maxlength: '8', style: 'text-transform:uppercase; letter-spacing:3px; font-weight:700;' });

  function doCreate() {
    const nick = nickInput.value.trim();
    if (!nick) return toast('Вкажіть нікнейм', true);
    localStorage.setItem('sigame_nickname', nick);
    socket.emit('mg:create_room', { gameType: opts.gameType, nickname: nick }, (res) => {
      if (res.error) return toast(res.error, true);
      localStorage.setItem(mgRoomStorageKey(opts.gameType), res.room.code);
      opts.onJoined({ roomCode: res.room.code, playerIdx: res.playerIdx, room: res.room });
    });
  }
  function doJoin() {
    const nick = nickInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    if (!nick || !code) return toast('Вкажіть нікнейм і код кімнати', true);
    localStorage.setItem('sigame_nickname', nick);
    socket.emit('mg:join_room', { gameType: opts.gameType, roomCode: code, nickname: nick }, (res) => {
      if (res.error) return toast(res.error, true);
      localStorage.setItem(mgRoomStorageKey(opts.gameType), res.room.code);
      opts.onJoined({ roomCode: res.room.code, playerIdx: res.playerIdx, room: res.room });
    });
  }

  clear(app);
  app.appendChild(el('div', { class: 'center-screen', style: 'min-height:80vh;' }, [
    el('div', { class: 'card', style: 'max-width:420px; width:100%;' }, [
      el('a', { href: '/minigames.html', class: 'back-link' }, ['← До міні-ігор']),
      el('div', { style: 'text-align:center; font-size:40px; margin-bottom:6px;' }, [opts.emoji]),
      el('h1', { style: 'text-align:center; margin-top:0;' }, [opts.gameLabel]),
      el('div', { class: 'field' }, [el('label', {}, ['Нікнейм']), nickInput]),
      el('div', { class: 'stack' }, [
        el('button', { onclick: doCreate }, ['Створити нову гру']),
        el('div', { class: 'row', style: 'align-items:flex-end;' }, [
          el('div', { class: 'field', style: 'flex:1; margin-bottom:0;' }, [el('label', {}, ['Або приєднатись за кодом']), codeInput]),
          el('button', { class: 'btn-outline', onclick: doJoin }, ['Приєднатись'])
        ])
      ])
    ])
  ]));
  nickInput.focus();
}

function mgRenderWaitingForOpponent(app, roomCode, opts) {
  clear(app);
  app.appendChild(el('div', { class: 'center-screen', style: 'min-height:80vh;' }, [
    el('div', { class: 'card', style: 'max-width:420px; width:100%; text-align:center;' }, [
      el('a', { href: '/minigames.html', class: 'back-link' }, ['← До міні-ігор']),
      el('h2', {}, ['Очікуємо суперника…']),
      el('p', {}, ['Надішліть цей код другові:']),
      el('div', { class: 'room-code' }, [roomCode]),
      opts && opts.extra ? opts.extra : null
    ])
  ]));
}

// Small persistent bar shown during active play on every game page: shows
// whose turn it is (caller-provided text) and a resign button. Kept as a
// DOM-node factory (not a full render) so each game's own renderBattle()-
// style function can just splice it into its own layout.
function mgResignBar(socket, statusText) {
  return el('div', { class: 'row between', style: 'margin:10px 0;' }, [
    el('strong', {}, [statusText]),
    el('button', { class: 'btn-small btn-outline crimson', onclick: () => {
      if (confirm('Здатися? Суперник отримає перемогу.')) socket.emit('mg:resign', {}, (res) => { if (res && res.error) toast(res.error, true); });
    }}, ['Здатися'])
  ]);
}

// winnerIdx: 0|1|null (null covers both "draw" and "not-a-real-answer" --
// callers pass drawReason separately when relevant, e.g. chess stalemate).
function mgFinishedBanner(myIdx, winnerIdx, resignedIdx, drawReason) {
  let title, sub = null;
  if (drawReason) {
    title = '\u{1F91D} Нічия';
    sub = drawReason;
  } else if (winnerIdx === myIdx) {
    title = '\u{1F3C6} Ви перемогли!';
    if (resignedIdx !== null && resignedIdx !== undefined) sub = 'Суперник здався.';
  } else {
    title = '\u{1F614} Ви програли';
    if (resignedIdx === myIdx) sub = 'Ви здалися.';
  }
  return el('div', { class: 'card', style: 'text-align:center; margin:14px 0; border-color:var(--orange);' }, [
    el('div', { style: 'font-size:22px; font-weight:800;' }, [title]),
    sub ? el('div', { style: 'font-size:13px; color:var(--turquoise-dark); margin-top:6px;' }, [sub]) : null,
    el('a', { href: '/minigames.html' }, [el('button', { style: 'margin-top:12px;' }, ['До міні-ігор'])])
  ]);
}

// Attempts to silently re-attach to a stored room after a page refresh --
// mirrors player.js's socket.on('connect', ...) re-join pattern. Calls
// cb(true, res) on success, cb(false) if there was nothing to reconnect to
// (or the stored room is gone), so the caller falls back to the join screen.
function mgTryReconnect(socket, gameType, cb) {
  const nickname = localStorage.getItem('sigame_nickname') || '';
  const roomCode = localStorage.getItem(mgRoomStorageKey(gameType)) || '';
  if (!nickname || !roomCode) return cb(false);
  socket.emit('mg:reconnect', { gameType, roomCode, nickname }, (res) => {
    if (!res || res.error) { localStorage.removeItem(mgRoomStorageKey(gameType)); return cb(false); }
    cb(true, res);
  });
}
