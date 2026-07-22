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

// dima 2026-07-22 "додай ефекти гарні ... в іграх" -- module-scoped (not per-
// game) is fine here even though this file is shared by 4 games, because
// each game is its own separate page load with its own fresh JS context;
// this just needs to stop mgFinishedBanner's effect from re-firing on every
// unrelated re-render while the SAME finished result stays on screen (same
// "_settledOnce" idea as blackjack.js/roulette.js use for their own result
// screens, just keyed by a signature of the banner's own inputs instead of
// a boolean, since this one function is reused by 4 different games).
let _mgLastEffectSignature = null;

// Renders the "join or create a room" screen into #app. Calls
// onJoined({ roomCode, playerIdx, room }) once socket join/create succeeds
// (the caller owns roomState/render() from that point on).
//
// dima 2026-07-21 "видали гостя, зроби реєстрацію обов'язковою скрізь" --
// gated behind requireAccount() (common.js) first; the nickname used for
// mg:create_room/mg:join_room below is now always the verified login, never
// a freely-typed value.
function mgRenderJoinScreen(socket, app, opts) {
  const backLink = el('a', { href: '/minigames.html', class: 'back-link' }, ['← До міні-ігор']);
  requireAccount(app, { title: opts.gameLabel, emoji: opts.emoji, backLink }, (nickname) => {
    renderActualJoinScreen(nickname);
  });

  function renderActualJoinScreen(nickname) {
    const codeInput = el('input', { type: 'text', placeholder: 'Код кімнати', maxlength: '8', style: 'text-transform:uppercase; letter-spacing:3px; font-weight:700;' });
    // dima 2026-07-22 "якщо я хочу зіграти на гроші (KKoins) чому я ніде не
    // можу це поставити" -- optional stake, only settable by whoever CREATES
    // the room (see miniGameManager.createRoom/joinRoom: the joiner just has
    // to match it, they don't choose their own number). 0/empty = normal
    // free game, unchanged from before this feature existed.
    const stakeInput = el('input', { type: 'number', min: '0', step: '1', placeholder: '0', value: '0', style: 'max-width:120px;' });
    const balanceLabel = el('span', { style: 'font-size:12px; color:var(--turquoise-dark);' }, ['']);
    fetch('/api/profile/' + encodeURIComponent(nickname)).then(r => r.json()).then((data) => {
      const kkoin = data && data.profile && data.profile.kkoin;
      balanceLabel.textContent = 'Баланс: ' + (Number.isFinite(kkoin) ? kkoin : 0) + ' KKoin';
    }).catch(() => {});

    function doCreate() {
      const stake = Math.max(0, Math.floor(Number(stakeInput.value) || 0));
      socket.emit('mg:create_room', { gameType: opts.gameType, nickname, stake }, (res) => {
        if (res.error) return toast(res.error, true);
        localStorage.setItem(mgRoomStorageKey(opts.gameType), res.room.code);
        opts.onJoined({ roomCode: res.room.code, playerIdx: res.playerIdx, room: res.room });
      });
    }
    function doJoin() {
      const code = codeInput.value.trim().toUpperCase();
      if (!code) return toast('Вкажіть код кімнати', true);
      socket.emit('mg:join_room', { gameType: opts.gameType, roomCode: code, nickname }, (res) => {
        if (res.error) return toast(res.error, true);
        localStorage.setItem(mgRoomStorageKey(opts.gameType), res.room.code);
        opts.onJoined({ roomCode: res.room.code, playerIdx: res.playerIdx, room: res.room });
      });
    }
    // dima 2026-07-22 "зроби щоб у хрестики нулики можна було грати з ШІ" --
    // opts.vsAI (currently only set by tictactoe.js) adds this third path
    // alongside create/join. Skips the stake entirely (see
    // miniGameManager.createAIRoom -- playing a bot for KKoin is meaningless).
    function doPlayAI() {
      socket.emit('mg:create_ai_room', { gameType: opts.gameType, nickname }, (res) => {
        if (res.error) return toast(res.error, true);
        localStorage.setItem(mgRoomStorageKey(opts.gameType), res.room.code);
        opts.onJoined({ roomCode: res.room.code, playerIdx: res.playerIdx, room: res.room });
      });
    }

    // dima 2026-07-22: uploaded a base44 "GameLobby.jsx" reference and asked
    // this join/create screen to match the mini-games hub's own polish level
    // (minigames.html's .ds-card grid). accentVars carries each game's own
    // hue -- see the mgRenderJoinScreen call sites in battleship.js/
    // checkers.js/chess.js/tictactoe.js -- reusing the exact colors
    // minigames.html's .ds-card--* already established, not a new palette.
    const accentVars = mgAccentStyle(opts.accent);
    clear(app);
    app.appendChild(el('div', { class: 'mg-lobby-wrap', style: accentVars }, [
      el('div', { class: 'mg-lobby-card' }, [
        el('a', { href: '/minigames.html', class: 'back-link mg-lobby-back' }, ['← До міні-ігор']),
        el('div', { class: 'mg-lobby-icon-wrap' }, [el('div', { class: 'mg-lobby-icon' }, [opts.emoji])]),
        el('h1', { class: 'mg-lobby-title' }, [opts.gameLabel]),
        opts.tagline ? el('p', { class: 'mg-lobby-tagline' }, [opts.tagline]) : null,
        // dima 2026-07-22 "забери ось це Граєш як, всерівно гравці ж
        // зареєстровані і знають свої ніки" -- nickname is still used
        // internally (doCreate/doJoin close over it), just no longer shown.
        el('div', { class: 'mg-lobby-field-label' }, [el('span', {}, ['Ставка (KKoin), необов’язково']), balanceLabel]),
        stakeInput,
        el('button', { class: 'mg-lobby-cta', onclick: doCreate }, ['✨ Створити нову гру']),
        opts.vsAI ? el('button', { class: 'btn-small btn-outline', style: 'width:100%; margin-top:8px;', onclick: doPlayAI }, ['🤖 Грати проти ШІ']) : null,
        el('div', { class: 'mg-lobby-divider' }, [el('span', {}), el('em', {}, ['або']), el('span', {})]),
        el('label', { class: 'mg-lobby-field-label' }, [el('span', {}, ['Приєднатись за кодом'])]),
        el('div', { class: 'mg-lobby-join-row' }, [
          codeInput,
          el('button', { class: 'mg-lobby-join-btn', onclick: doJoin }, ['Приєднатись'])
        ]),
        el('p', { class: 'mg-lobby-note' }, ['Якщо у кімнаті є ставка, той хто приєднується має мати стільки ж KKoin — сума спишеться з обох одразу, як гра почнеться, і переможець забирає банк.'])
      ])
    ]));
    codeInput.className = 'mg-lobby-input';
    stakeInput.className = 'mg-lobby-input';
    codeInput.focus();
  }
}

// Each game's own accent (see the mgRenderJoinScreen({accent: '#rrggbb'})
// call sites) reuses minigames.html's .ds-card--* hues exactly:
//   battleship=turquoise #17B8A6, checkers=crimson #D7263D,
//   chess=orange #F2994A, tictactoe=gold #DAA520.
// Kept as one small helper (rather than 4 near-duplicate rgba literals
// scattered across game files) so the accent->glow conversion only needs to
// be right in one place.
function mgAccentStyle(hex) {
  const h = hex || '#17B8A6';
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  return '--mg-accent:' + h + '; --mg-glow: rgba(' + r + ',' + g + ',' + b + ',.28);';
}

function mgRenderWaitingForOpponent(app, roomCode, opts) {
  clear(app);
  const stake = opts && opts.stake;
  const accentVars = mgAccentStyle(opts && opts.accent);
  app.appendChild(el('div', { class: 'mg-lobby-wrap', style: accentVars }, [
    el('div', { class: 'mg-lobby-card', style: 'text-align:center;' }, [
      el('a', { href: '/minigames.html', class: 'back-link mg-lobby-back' }, ['← До міні-ігор']),
      el('h2', { class: 'mg-lobby-title', style: 'margin-top:14px;' }, ['Очікуємо суперника…']),
      el('p', { class: 'mg-lobby-tagline' }, ['Надішліть цей код другові:']),
      el('div', { class: 'mg-lobby-waiting-code' }, [roomCode]),
      stake > 0 ? el('p', { style: 'font-weight:700; color:var(--orange); margin-top:6px; font-size:13px;' }, ['\u{1FA99} Гра на ставку: ' + stake + ' KKoin (спишеться з обох, щойно суперник приєднається)']) : null,
      opts && opts.extra ? opts.extra : null
    ])
  ]));
}

// Small persistent bar shown during active play on every game page: shows
// whose turn it is (caller-provided text) and a resign button. Kept as a
// DOM-node factory (not a full render) so each game's own renderBattle()-
// style function can just splice it into its own layout.
function mgResignBar(socket, statusText, stake) {
  return el('div', { class: 'row between', style: 'margin:10px 0; align-items:center;' }, [
    el('div', {}, [
      el('strong', {}, [statusText]),
      stake > 0 ? el('div', { style: 'font-size:12px; color:var(--orange); font-weight:700;' }, ['\u{1FA99} Банк: ' + (stake * 2) + ' KKoin']) : null
    ]),
    el('button', { class: 'btn-small btn-outline crimson', onclick: () => {
      if (confirm('Здатися? Суперник отримає перемогу.' + (stake > 0 ? (' Ставку (' + stake + ' KKoin) буде втрачено.') : ''))) socket.emit('mg:resign', {}, (res) => { if (res && res.error) toast(res.error, true); });
    }}, ['Здатися'])
  ]);
}

// winnerIdx: 0|1|null (null covers both "draw" and "not-a-real-answer" --
// callers pass drawReason separately when relevant, e.g. chess stalemate).
// dima 2026-07-22 "чому після гри я не можу запустити нову" -- onRematch (якщо
// переданий) малює кнопку "Грати знову" поруч із "До міні-ігор". Викликач сам
// вирішує, що саме відбувається по кліку (зазвичай -- socket.emit('mg:rematch', ...)),
// цей файл нічого не знає про socket/gameType конкретної гри.
function mgFinishedBanner(myIdx, winnerIdx, resignedIdx, drawReason, onRematch, stake) {
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
  // dima 2026-07-22 "якщо я хочу зіграти на гроші (KKoins)" -- payout already
  // happened server-side the instant the room became "finished" (see
  // miniGameManager.settleStakes); this is purely the after-the-fact summary
  // line, matching whatever the server actually did.
  let stakeLine = null;
  if (stake > 0) {
    if (drawReason) stakeLine = '\u{1FA99} Нічия -- ставку (' + stake + ' KKoin) повернено обом.';
    else if (winnerIdx === myIdx) stakeLine = '\u{1FA99} Ви забрали банк: ' + (stake * 2) + ' KKoin.';
    else stakeLine = '\u{1FA99} Ставку втрачено: -' + stake + ' KKoin.';
  }
  const rematchBtn = onRematch ? el('button', {
    style: 'margin-top:12px; margin-right:8px;',
    onclick: (e) => {
      e.currentTarget.disabled = true;
      onRematch();
    }
  }, ['\u{1F501} Грати знову']) : null;

  const effectSignature = JSON.stringify([myIdx, winnerIdx, resignedIdx, drawReason, stake]);
  if (typeof playEffect === 'function' && effectSignature !== _mgLastEffectSignature) {
    _mgLastEffectSignature = effectSignature;
    const effectKey = drawReason ? null : (winnerIdx === myIdx ? 'firework' : 'poison');
    if (effectKey) {
      // banner isn't in the document yet (the caller appends the node this
      // function returns) -- defer one frame so the .mg-finished-banner
      // query below has something real to find.
      requestAnimationFrame(() => {
        const anchor = document.querySelector('.mg-finished-banner') || document.body;
        playEffect(effectKey, anchor);
      });
    }
  }

  // dima 2026-07-22 скрін хрестиків-нуликів: "не можна було курсором
  // наклацати" (looked bad highlighted like normal text when
  // click-dragged) + "хай цей напис у всіх іграх буде по центру екрана" --
  // user-select:none kills the highlight, and max-width+margin:auto makes
  // this a genuinely centered card instead of a full-width .card with only
  // its TEXT centered inside (which could sit off-center-looking on a wide
  // screen depending on ambient layout). Applies to all 4 games that call
  // this function (tictactoe/battleship/chess/checkers), not just the one
  // dima screenshotted.
  return el('div', { class: 'card mg-finished-banner', style: 'text-align:center; margin:14px auto; max-width:420px; border-color:var(--orange); user-select:none;' }, [
    el('div', { style: 'font-size:22px; font-weight:800;' }, [title]),
    sub ? el('div', { style: 'font-size:13px; color:var(--turquoise-dark); margin-top:6px;' }, [sub]) : null,
    stakeLine ? el('div', { style: 'font-size:14px; font-weight:700; color:var(--orange); margin-top:8px;' }, [stakeLine]) : null,
    rematchBtn,
    el('a', { href: '/minigames.html' }, [el('button', { class: 'btn-outline', style: 'margin-top:12px;' }, ['До міні-ігор'])])
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
