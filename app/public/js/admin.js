// admin.html dashboard logic. Room-hosting controls for the quiz (create
// rooms, assign teams, generate the board, watch/adjust a live game).
//
// 2026-07-22 auth rework (dima: "забери цю адмін панель в вікторині, якщо я
// і так адмін по персональному кабінету, то там додатковий пароль і це
// вікно непотрібно") -- this page no longer has its OWN standalone password
// form. It now reuses the same cabinet login every other page here already
// has (see common.js's getAuth()): if this browser already holds an
// admin-role account token, the dashboard opens immediately with zero extra
// prompts -- exactly the flow dima gets by clicking the "Адмін-панель"
// button on quiz.html, which (see quiz.js) only ever shows to an admin-role
// account in the first place, so a valid token is already guaranteed to be
// sitting in localStorage by the time this page loads that way.
//
// The actual security boundary is still 100% server-side and unchanged in
// spirit -- see socketHandlers.js's admin:authenticate, which now accepts
// EITHER the original standalone admin password token (adminAuth.js, kept
// working as a dormant fallback, just no longer surfaced anywhere in this
// UI) OR a cabinet session token whose role is 'admin' (authSessions.js).
// Every admin-only socket event still independently re-checks
// socket.isAdmin server-side, exactly as before this change -- nothing
// about WHAT is allowed changed, only HOW a browser proves it up front.
//
// 2026-07-22 visual rework (dima: "онови адмін панель... більш гарнішим і
// технологічнішим все зроби") -- re-skinned onto the same .ds-page/.ds-panel
// glass system profile.html/casino.html/minigames.html/plinko.html already
// use, instead of the older plain .card layout. Purely a rendering-layer
// change: every socket event, state variable, and business rule below
// (SCORE_STEP, controlsDraft defaults, etc.) is exactly the same logic as
// before -- just wrapped in different container classes.
//
// 2026-07-22 (dima: "видали вставлення музики (тільки у адміна)") -- the
// host-side YouTube "Музика (для ведучого)" panel and all its player
// plumbing (renderMusicPanel, playYouTubeUrl/pause/stop, the hidden
// #ytMusicPlayer host div) have been removed outright. Players' own
// in-team music (team_music, a totally separate feature living in
// player.js) is untouched.
(function () {
  const app = document.getElementById('app');
  let token = null;
  let socket = null;
  let authed = false;
  // Distinguishes "still checking the cabinet token" from "checked, and
  // this browser definitely isn't an admin" so renderLogin() doesn't flash
  // the wrong message while the silent handshake in boot() is in flight.
  let authStatus = 'checking'; // 'checking' | 'need-login' | 'not-admin'

  let rooms = [];
  let selected = null;       // admin:room_state for the selected room (superset of room:state -- see roomManager.adminState)
  let lastResolved = null;   // last answer:resolved payload for selected room
  let playerStats = [];
  let bankStats = null;

  // ---- live "time left" countdown for the room being watched (point 8) ----
  // Mirrors player.js's own startTimer()/stopTimer(), driven by the same
  // question:opened/answer:resolved events a player gets (the admin socket is
  // also a member of the room's player channel -- see socketHandlers.js).
  let adminTimerHandle = null;
  let adminTimerEnd = null;
  let adminTimerQuestionKey = null; // themeId:price of the question the running timer is for
  // Survives across the frequent full re-renders triggered by room:state
  // broadcasts (any player joining/answering causes one) so that an admin
  // mid-keystroke in these fields doesn't see their input silently reset to
  // the hardcoded default -- see PROGRESS.md "known limitation" note.
  const controlsDraft = { numTeams: 2, numRounds: 2, perRound: 5 }; // dima 2026-07-21: дефолт 2 команди, а не 3
  const teamNameDrafts = {}; // teamId -> in-progress typed name (same purpose as controlsDraft)

  const TEAM_COLOR_CLASS = {
    turquoise: 'team-turquoise', crimson: 'team-crimson', orange: 'team-orange',
    'turquoise-dark': 'team-turquoise-dark', 'crimson-dark': 'team-crimson-dark', 'orange-dark': 'team-orange-dark'
  };

  function connectSocket() {
    socket = io();
    socket.on('connect', () => {
      socket.emit('admin:authenticate', { token }, (res) => {
        if (res && res.ok) {
          authed = true;
          socket.emit('admin:watch_lobby', {}, (r) => { rooms = (r && r.rooms) || []; render(); });
          bindAdminEvents();
        } else {
          // Cabinet token didn't authenticate as admin (not an admin-role
          // login, or an old/expired token) -- do NOT touch localStorage's
          // shared 'sigame_auth' here, that's the whole cabinet session and
          // other pages still need it; only this page's own in-memory
          // `token` gets dropped.
          authed = false;
          authStatus = 'not-admin';
          token = null;
          render();
        }
      });
    });
  }

  function bindAdminEvents() {
    socket.on('admin:rooms_changed', () => {
      socket.emit('admin:list_rooms', {}, (r) => { rooms = (r && r.rooms) || []; render(); });
    });
    // admin:room_state (roomManager.adminState) is the answers-included
    // superset of the public room:state players get -- this admin UI relies
    // ONLY on this event now (not the generic 'room:state', which this socket
    // also technically receives as a member of the room's player channel, but
    // we deliberately ignore it here so the richer payload always wins).
    socket.on('admin:room_state', (state) => {
      if (selected && state.code === selected.code) { selected = state; syncAdminTimerFromState(state); }
      const idx = rooms.findIndex(r => r.code === state.code);
      if (idx >= 0) rooms[idx] = state;
      render();
    });
    // question:opened/answer:resolved are broadcast to the whole room
    // (players + this admin socket, since admin also joins room.code -- see
    // socketHandlers.js). Because an admin can watch/switch between several
    // rooms in one session (each watch_room joins another channel without
    // leaving the previous one), guard with the payload's own room code so a
    // stale event from a room we're no longer looking at can't show the
    // wrong timer/banner/answer.
    socket.on('question:opened', (payload) => {
      if (!selected || payload.code !== selected.code) return;
      startAdminTimer(payload.themeId + ':' + payload.price, payload.timeoutMs || 45000);
    });
    socket.on('answer:resolved', (result) => {
      if (!selected || (result.code && result.code !== selected.code)) return;
      lastResolved = result;
      stopAdminTimer();
      if (result.roundComplete && !result.gameComplete && selected) {
        const newRound = selected.rounds[result.currentRoundIndex];
        showRoundBanner(
          'Раунд ' + result.currentRoundIndex + ' завершено!',
          'Починається раунд ' + (result.currentRoundIndex + 1) + (newRound ? ': ' + newRound.name : '')
        );
      }
      render();
    });
    socket.on('answer:corrected', (payload) => { lastResolved = { ...lastResolved, wasCorrect: payload.corrected.wasCorrect, delta: payload.corrected.delta }; render(); });
    // dima's point 5: a team bought a hint mid-question -- the clock just
    // got 15s longer. The questionKey hasn't changed so syncAdminTimerFromState
    // would no-op; force-restart the bar against the new remaining time
    // (same "fresh bar from msRemaining" simplification the reconnect path uses).
    socket.on('hint:used', (payload) => {
      if (!selected || payload.code !== selected.code) return;
      toast('Команда «' + teamName(selected, payload.teamId) + '» купила підказку (−' + payload.cost + '), +15с на таймер');
      adminTimerQuestionKey = null;
      startAdminTimer(payload.themeId + ':' + payload.price, Math.max(1000, payload.msRemaining || 15000));
    });
  }

  function startAdminTimer(questionKey, totalMs) {
    if (adminTimerQuestionKey === questionKey && adminTimerHandle) return; // already ticking for this exact question
    stopAdminTimer();
    adminTimerQuestionKey = questionKey;
    adminTimerEnd = Date.now() + totalMs;
    adminTimerHandle = setInterval(() => {
      const fill = document.getElementById('adminTimerFill');
      const label = document.getElementById('adminTimerLabel');
      const remaining = Math.max(0, adminTimerEnd - Date.now());
      if (fill) { fill.style.width = Math.round((remaining / totalMs) * 100) + '%'; fill.classList.toggle('low', remaining / totalMs <= 0.25); }
      if (label) label.textContent = 'Залишилось: ' + Math.ceil(remaining / 1000) + ' с';
      if (remaining <= 0) stopAdminTimer();
    }, 250);
  }
  function stopAdminTimer() {
    if (adminTimerHandle) clearInterval(adminTimerHandle);
    adminTimerHandle = null;
    adminTimerQuestionKey = null;
  }
  // Resume path for an admin who selects/re-selects a room that already has
  // a question open (e.g. switching tabs mid-question, or a reconnect) --
  // mirrors player.js's syncActiveQuestion() fallback using msRemaining
  // instead of the exact question:opened timeoutMs.
  function syncAdminTimerFromState(r) {
    if (!r.activeQuestion) { stopAdminTimer(); return; }
    const key = r.activeQuestion.themeId + ':' + r.activeQuestion.price;
    if (key === adminTimerQuestionKey) return; // already tracking this one
    startAdminTimer(key, Math.max(1000, r.activeQuestion.msRemaining || 45000));
  }

  // ---------------- boot / actions ----------------
  function boot() {
    const cabinetAuth = getAuth();
    if (cabinetAuth && cabinetAuth.token) {
      token = cabinetAuth.token;
      connectSocket();
    } else {
      authStatus = 'need-login';
      render();
    }
  }

  function createRoom() {
    socket.emit('admin:create_room', {}, (res) => {
      if (res.error) return toast(res.error, true);
      selectRoom(res.room.code);
    });
  }

  function selectRoom(code) {
    socket.emit('admin:watch_room', { roomCode: code }, (res) => {
      if (res.error) return toast(res.error, true);
      selected = res.room;
      lastResolved = null;
      stopAdminTimer();
      syncAdminTimerFromState(selected);
      refreshPlayerStats();
      refreshBankStats();
      render();
    });
  }

  function refreshPlayerStats() {
    socket.emit('admin:player_stats', {}, (res) => { playerStats = (res && res.players) || []; render(); });
  }
  function refreshBankStats() {
    socket.emit('admin:bank_stats', {}, (res) => { bankStats = res && res.stats; render(); });
  }

  // ---------------- rendering ----------------
  function render() {
    clear(app);
    if (!authed) return renderLogin();
    renderDashboard();
  }

  function pageShellStart(narrow) {
    return el('div', { class: 'ds-page' }, [
      el('div', { class: 'hub-bg-spheres', 'aria-hidden': 'true' }, [
        el('span', { class: 'hub-sphere s1' }, []),
        el('span', { class: 'hub-sphere s2' }, []),
        el('span', { class: 'hub-sphere s3' }, [])
      ]),
      el('div', { class: 'ds-shell' + (narrow ? ' ds-shell-narrow' : '') }, [
        el('div', { class: 'ds-topbar' }, [
          el('a', { href: '/', class: 'back-link ds-back-link' }, ['← На головну']),
          el('span', { class: 'ds-brand-mark' }, [el('b', {}, ['DSLAND']), ' · ADMIN'])
        ])
      ])
    ]);
  }

  function renderLogin() {
    const checking = authStatus === 'checking';
    const message = checking
      ? 'Перевірка прав доступу…'
      : authStatus === 'not-admin'
        ? 'Цей акаунт не має прав адміністратора.'
        : 'Увійдіть у свій акаунт в особистому кабінеті, щоб відкрити адмін-панель.';
    const page = pageShellStart(true);
    const shell = page.children[1];
    shell.appendChild(el('div', { class: 'center-screen', style: 'min-height:60vh;' }, [
      el('div', { class: 'ds-panel', style: 'max-width:380px; width:100%; text-align:center;' }, [
        el('img', { src: '/img/logo.jpg', alt: 'DSLand', style: 'display:block; width:80px; height:auto; margin:0 auto 14px; border-radius:14px;' }),
        el('h2', { style: 'margin-bottom:10px;' }, ['Адмін-панель DSLand']),
        el('p', { style: 'color:var(--ds-text-dim); font-size:14px; line-height:1.5;' }, [message]),
        !checking ? el('a', { href: '/profile.html', class: 'btn-small', style: 'display:inline-block; margin-top:14px; text-decoration:none;' }, ['Особистий кабінет →']) : null
      ])
    ]));
    app.appendChild(page);
  }

  function renderDashboard() {
    const page = pageShellStart(false);
    const shell = page.children[1];

    shell.appendChild(el('div', { style: 'display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; margin-bottom:24px;' }, [
      el('div', {}, [
        el('div', { class: 'ds-eyebrow' }, ['/ Керування вікториною']),
        el('h1', { class: 'ds-heading', style: 'font-size:32px; margin-bottom:0;' }, ['Адмін-панель'])
      ]),
      el('button', { class: 'btn-small', onclick: createRoom }, ['+ Нова кімната'])
    ]));

    shell.appendChild(el('div', { class: 'row', style: 'margin-bottom:6px;' }, rooms.map(r =>
      el('button', { class: 'btn-small' + ((selected && selected.code === r.code) ? '' : ' btn-outline'), onclick: () => selectRoom(r.code) },
        [r.code + ' · ' + r.players.length + ' гравців · ' + statusLabel(r.status)])
    )));

    if (selected) shell.appendChild(renderRoomManager());
    app.appendChild(page);
  }

  function statusLabel(s) {
    return { lobby: 'лобі', ready_check: 'очікування готовності', in_progress: 'йде гра', finished: 'завершено' }[s] || s;
  }

  function renderRoomManager() {
    const r = selected;
    const sections = [];

    // ---- room header strip: code + live status ----
    sections.push(el('div', { class: 'ds-panel', style: 'display:flex; justify-content:space-between; align-items:center; gap:14px; flex-wrap:wrap; padding:18px 24px;' }, [
      el('span', { class: 'room-code', style: 'font-size:30px;' }, [r.code]),
      el('span', { class: 'badge outline' }, [statusLabel(r.status)])
    ]));

    // Soft (non-blocking) headcount hint -- dima's spec targets 6-14 players.
    // This never stops the host from starting anyway, it's just a nudge.
    if (r.status === 'lobby' && r.players.length > 0 && (r.players.length < 6 || r.players.length > 14)) {
      sections.push(el('div', { class: 'warn-banner' }, [
        r.players.length < 6
          ? ('Зараз лише ' + r.players.length + ' гравців(я) -- гра розрахована на 6-14. Можна почати й так, це просто підказка.')
          : ('Зараз ' + r.players.length + ' гравців -- більше за рекомендовані 14. Можна почати й так, але подумайте про 4-5 команд і перевірте зручність екрану.')
      ]));
    }

    // Ready-check panel (dima's spec: game only actually starts once every
    // teamed player has pressed "Я готовий(ва)"). r.readyCheck comes from
    // roomManager.getReadyStatus() via publicState/adminState -- the host
    // gets a force-start override (nobody has to wait on an AFK player
    // forever) and a cancel-back-to-lobby escape hatch.
    if (r.status === 'ready_check') {
      const rc = r.readyCheck || { readyCount: 0, totalCount: 0, pendingNicknames: [] };
      sections.push(el('div', { class: 'ds-panel', style: 'border-color:var(--orange);' }, [
        el('div', { class: 'ds-panel-label' }, ['⏳ Очікування готовності гравців']),
        el('div', { style: 'font-size:20px; font-weight:800; color:var(--ds-mint); margin-bottom:8px;' }, [rc.readyCount + ' / ' + rc.totalCount + ' готові']),
        rc.pendingNicknames.length ? el('p', { style: 'font-size:13px; color:var(--ds-text-dim);' }, ['Очікуємо: ' + rc.pendingNicknames.join(', ')]) : el('p', { style: 'font-size:13px; color:var(--ds-text-dim);' }, ['Всі готові -- гра ось-ось почнеться автоматично.']),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn-small', onclick: () => socket.emit('admin:force_start_game', { roomCode: r.code }, (res) => { if (res.error) toast(res.error, true); }) }, ['Форсувати старт (не чекати на всіх)']),
          el('button', { class: 'btn-small btn-outline crimson', onclick: () => socket.emit('admin:cancel_ready_check', { roomCode: r.code }, (res) => { if (res.error) toast(res.error, true); }) }, ['Скасувати, повернутись у лобі'])
        ])
      ]));
    }

    sections.push(el('div', { class: 'grid-2' }, [
      renderRosterPanel(r),
      renderControlsPanel(r)
    ]));

    if (r.teams.length) sections.push(renderTeamScorePanel(r));

    if (r.rounds.length) {
      sections.push(el('div', { class: 'ds-panel' }, [
        el('div', { class: 'ds-panel-label' }, ['📊 Дошка (раунд ' + (r.currentRoundIndex + 1) + '/' + r.rounds.length + ': ' + (r.rounds[r.currentRoundIndex] || {}).name + ')']),
        renderBoardMonitor(r)
      ]));
      sections.push(renderAnswerKeyPanel(r));
    }

    if (r.activeQuestion) {
      const activeRound = r.rounds[r.currentRoundIndex];
      const activeTheme = activeRound && activeRound.themes.find(t => t.id === r.activeQuestion.themeId);
      const activeQ = activeTheme && activeTheme.questions.find(q => q.price === r.activeQuestion.price);
      const parts = [
        el('strong', {}, ['Відкрите питання: ' + (activeTheme ? activeTheme.name : r.activeQuestion.themeId) + ' / ' + r.activeQuestion.price]),
        el('div', { class: 'timer-bar', style: 'margin-top:10px;' }, [el('div', { class: 'timer-bar-fill', id: 'adminTimerFill' })]),
        el('div', { id: 'adminTimerLabel', style: 'font-size:13px; font-weight:700; color:var(--turquoise-dark);' }, ['Залишилось: —'])
      ];
      // "зарання бачив правильну відповідь" (point 8): show the answer key
      // for the CURRENTLY open question right here too, not just buried in
      // the collapsible per-round panel below.
      if (activeQ) {
        parts.push(el('div', { style: 'margin-top:8px; padding:8px 10px; background:var(--turquoise-light); border-radius:8px;' }, [
          el('strong', {}, ['Правильна відповідь: ']), activeQ.display,
          activeQ.accepted ? el('div', { style: 'font-size:12px; margin-top:4px; color:var(--turquoise-dark);' }, ['Також приймається: ' + activeQ.accepted.join(', ')]) : null
        ]));
      }
      // Host sees the same picture/audio clue the players are looking at
      // (real .siq-imported questions carry these) -- openedPayload.clue is
      // the same forwarded whitelist player.js reads from.
      const openedClue = r.activeQuestion.openedPayload && r.activeQuestion.openedPayload.clue;
      if (openedClue && openedClue.imageUrl) {
        parts.push(el('div', { class: 'clue-image-wrap' }, [
          el('img', { class: 'clue-image', src: openedClue.imageUrl, alt: 'Підказка', style: 'max-height:220px;' })
        ]));
      }
      if (openedClue && openedClue.audioUrl) {
        parts.push(el('div', { class: 'clue-audio-wrap' }, [
          el('audio', { class: 'clue-audio', src: openedClue.audioUrl, controls: 'controls', preload: 'auto' })
        ]));
      }
      parts.push(el('div', { style: 'margin-top:10px;' }, [
        el('button', { class: 'btn-crimson', onclick: () => socket.emit('admin:force_resolve_stuck', { roomCode: r.code }, (res) => { if (res.error) toast(res.error, true); }) }, ['Форсувати завершення (зависло)'])
      ]));
      sections.push(el('div', { class: 'clue-panel' }, parts));
    }

    if (lastResolved) {
      sections.push(el('div', { class: 'ds-panel' }, [
        el('div', { class: 'ds-panel-label' }, [lastResolved.timedOut ? 'Остання відповідь: час вийшов' : (lastResolved.wasCorrect ? 'Остання відповідь: зараховано правильною' : 'Остання відповідь: зараховано неправильною')]),
        el('div', { style: 'margin:8px 0; color:var(--ds-text-dim);' }, ['Правильна відповідь: ' + lastResolved.correctDisplay]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn-small btn-outline', disabled: lastResolved.wasCorrect ? 'disabled' : null, onclick: () => socket.emit('admin:override_answer', { roomCode: r.code, correct: true }, (res) => { if (res.error) toast(res.error, true); }) }, ['Позначити ПРАВИЛЬНОЮ']),
          el('button', { class: 'btn-small btn-outline crimson', disabled: !lastResolved.wasCorrect ? 'disabled' : null, onclick: () => socket.emit('admin:override_answer', { roomCode: r.code, correct: false }, (res) => { if (res.error) toast(res.error, true); }) }, ['Позначити НЕПРАВИЛЬНОЮ'])
        ])
      ]));
    }

    // MVP + KKoin summary (dima's spec) -- same room.mvp/kkoinAward fields
    // player.js's renderFinished() reads, just also surfaced to the host.
    if (r.status === 'finished' && r.mvp && r.mvp.nicknames && r.mvp.nicknames.length) {
      sections.push(el('div', { class: 'ds-panel', style: 'border-color:var(--orange);' }, [
        el('strong', { style: 'color:var(--orange);' }, ['\u{1F31F} MVP вікторини: ' + r.mvp.nicknames.join(', ') + ' (' + r.mvp.correctCount + ' правильних)'])
      ]));
    }
    if (r.status === 'finished' && r.kkoinAward && r.kkoinAward.perPlayer > 0) {
      sections.push(el('div', { class: 'kkoin-panel' }, [
        el('div', { class: 'kkoin-emoji' }, ['\u{1FA99}']),
        el('div', {}, [
          el('div', { class: 'kkoin-amount' }, ['+' + r.kkoinAward.perPlayer + ' KKrampus coin кожному']),
          el('div', { class: 'kkoin-label' }, ['Команда-переможець: ' + r.kkoinAward.teamNames.join(', ')])
        ])
      ]));
    }

    sections.push(el('div', { class: 'row' }, [
      el('button', { class: 'btn-crimson', onclick: () => { if (confirm('Завершити гру достроково?')) socket.emit('admin:end_game', { roomCode: r.code }, () => {}); } }, ['Завершити гру'])
    ]));

    sections.push(renderPlayerStatsPanel());

    return el('div', { class: 'stack', style: 'gap:20px; margin-top:22px;' }, sections);
  }

  // Host tool: nudge one player's personal bonus counter. Separate from team
  // score -- see roomManager.adjustPlayerScore doc comment for why. Fixed
  // +/-100 step per dima's request -- no more typed arbitrary amount.
  const SCORE_STEP = 100;
  function adjustPlayerScore(roomCode, nicknameKey, sign) {
    socket.emit('admin:adjust_player_score', { roomCode, nicknameKey, delta: sign * SCORE_STEP }, (res) => { if (res && res.error) toast(res.error, true); });
  }

  function renderRosterPanel(r) {
    const parts = [
      el('div', { class: 'ds-panel-label' }, ['👥 Гравці (' + r.players.length + ')']),
      el('div', { class: 'stack roster-list' }, r.players.map(p => {
        const nicknameKey = p.nickname.toLowerCase();
        // Manual team-move (point 5): on top of the balanced snake-draft
        // button in renderControlsPanel, dima wanted to be able to hand-move
        // one player at a time (e.g. two friends who want to be together).
        // Same lobby-only restriction as the snake draft itself -- moving
        // someone mid-game could orphan the turn queue or double-count a
        // score, so this dropdown only appears before the game starts.
        let moveSelect = null;
        if (r.status === 'lobby' && r.teams.length) {
          moveSelect = el('select', {
            class: 'team-move-select',
            onchange: (e) => socket.emit('admin:move_player_to_team', { roomCode: r.code, nicknameKey, teamId: e.target.value }, (res) => { if (res && res.error) toast(res.error, true); })
          }, r.teams.map(t => el('option', { value: t.id }, [t.name])));
          moveSelect.value = p.teamId || (r.teams[0] && r.teams[0].id) || '';
        }
        return el('div', { class: 'stack', style: 'border-bottom:1px solid var(--ds-border); padding-bottom:8px; margin-bottom:4px;' }, [
          el('div', { class: 'row between' }, [
            el('span', { class: 'roster-row' }, [avatarEl(p, 28), el('span', { class: 'dot ' + (p.connected ? 'on' : 'off') }, []), p.nickname + (p.teamId ? ' — ' + teamName(r, p.teamId) : '')]),
            el('button', { class: 'btn-small btn-outline crimson', onclick: () => { if (confirm('Прибрати ' + p.nickname + '?')) socket.emit('admin:kick_player', { roomCode: r.code, nicknameKey }, () => {}); } }, ['✕'])
          ]),
          el('div', { class: 'player-row-controls' }, [
            el('span', { class: 'badge outline', title: 'Особистий бонус-рахунок (не впливає на рахунок команди)' }, ['бонус: ' + (p.personalScore > 0 ? '+' : '') + p.personalScore]),
            el('button', { class: 'btn-small btn-outline', title: '+100', onclick: () => adjustPlayerScore(r.code, nicknameKey, +1) }, ['+100']),
            el('button', { class: 'btn-small btn-outline crimson', title: '-100', onclick: () => adjustPlayerScore(r.code, nicknameKey, -1) }, ['−100']),
            moveSelect ? el('span', { title: 'Перекинути гравця в іншу команду вручну' }, ['→', moveSelect]) : null
          ])
        ]);
      }))
    ];
    if (r.teams.length) {
      parts.push(el('div', { class: 'ds-panel-label', style: 'margin-top:16px;' }, ['Назви команд']));
      parts.push(el('div', { class: 'stack' }, r.teams.map(t => {
        // Same re-render-resets-draft issue as the numTeams/numRounds fields
        // (see controlsDraft above): seed from any in-flight typed value the
        // admin already has for this team, falling back to the server name.
        if (!(t.id in teamNameDrafts)) teamNameDrafts[t.id] = t.name;
        const nameInput = el('input', {
          type: 'text', value: teamNameDrafts[t.id], maxlength: '40', style: 'flex:1;',
          oninput: (e) => { teamNameDrafts[t.id] = e.target.value; }
        });
        return el('div', { class: 'row' }, [
          nameInput,
          el('button', { class: 'btn-small btn-outline', onclick: () => socket.emit('admin:rename_team', { roomCode: r.code, teamId: t.id, name: nameInput.value }, (res) => { if (res && res.error) toast(res.error, true); }) }, ['Перейменувати'])
        ]);
      })));
    }
    return el('div', { class: 'ds-panel' }, parts);
  }

  function teamName(r, teamId) {
    const t = r.teams.find(t => t.id === teamId);
    return t ? t.name : '';
  }

  // ---------------- answer key (point 8: see every answer ahead of time) ----------------
  function renderAnswerKeyPanel(r) {
    const round = r.rounds[r.currentRoundIndex];
    if (!round) return el('div', {}, []);
    const prices = [100, 200, 300, 400, 500];
    const rows = round.themes.map(t => el('tr', {}, [
      el('td', { style: 'font-weight:700;' }, [t.name]),
      ...prices.map(price => {
        const q = t.questions.find(q => q.price === price);
        if (!q) return el('td', {}, ['—']);
        return el('td', { style: q.used ? 'opacity:.55; text-decoration:line-through;' : '' }, [String(price) + ': ' + q.display]);
      })
    ]));
    return el('div', { class: 'ds-panel' }, [
      el('details', {}, [
        el('summary', { style: 'cursor:pointer; color:var(--ds-mint); font-weight:700;' }, ['\u{1F441}\u{FE0F} Показати всі відповіді цього раунду (заздалегідь)']),
        el('div', { style: 'overflow-x:auto; margin-top:8px;' }, [
          el('table', {}, [el('tbody', {}, rows)])
        ])
      ])
    ]);
  }

  function renderControlsPanel(r) {
    const numTeamsInput = el('input', {
      type: 'number', min: '2', max: '6', value: String(controlsDraft.numTeams), style: 'width:70px;',
      oninput: (e) => { controlsDraft.numTeams = e.target.value; }
    });
    const numRoundsInput = el('input', {
      type: 'number', min: '1', max: '4', value: String(controlsDraft.numRounds), style: 'width:70px;',
      oninput: (e) => { controlsDraft.numRounds = e.target.value; }
    });
    const perRoundInput = el('input', {
      type: 'number', min: '2', max: '10', value: String(controlsDraft.perRound), style: 'width:70px;',
      oninput: (e) => { controlsDraft.perRound = e.target.value; }
    });

    const panel = el('div', { class: 'ds-panel' }, [
      el('div', { class: 'ds-panel-label' }, ['⚙️ Керування']),
      el('div', { class: 'field' }, [
        el('label', {}, ['Кількість команд']),
        el('div', { class: 'row' }, [numTeamsInput, el('button', { class: 'btn-small', onclick: () => socket.emit('admin:assign_teams', { roomCode: r.code, numTeams: parseInt(numTeamsInput.value, 10) }, (res) => { if (res.error) toast(res.error, true); }) }, ['Сформувати / перебалансувати команди'])])
      ]),
      el('div', { class: 'field' }, [
        el('label', {}, ['Раундів × тем на раунд']),
        el('div', { class: 'row' }, [numRoundsInput, perRoundInput, el('button', { class: 'btn-small', onclick: () => socket.emit('admin:generate_board', { roomCode: r.code, numRounds: parseInt(numRoundsInput.value, 10), themesPerRound: parseInt(perRoundInput.value, 10) }, (res) => {
          if (res.error) return toast(res.error, true);
          bankStats = res.bankStats;
          if (res.reusedCount > 0) toast('Банк тем майже вичерпано: ' + res.reusedCount + ' тем взято повторно (найдавніше використані)', true);
          else toast('Теми згенеровано!');
          render();
        }) }, ['Згенерувати теми'])])
      ]),
      bankStats ? el('p', { style: 'font-size:13px; color:var(--ds-text-dim);' }, ['Банк тем: ' + bankStats.freshRemaining + ' свіжих / ' + bankStats.totalThemes + ' всього']) : null,
      r.status === 'lobby'
        ? el('div', { class: 'row' }, [
            el('button', { class: 'btn-small', onclick: () => socket.emit('admin:start_game', { roomCode: r.code }, (res) => { if (res.error) toast(res.error, true); }) }, ['Почати гру'])
          ])
        : el('p', { style: 'font-size:13px; color:var(--ds-text-dim);' }, ['Гру вже розпочато (' + statusLabel(r.status) + ').']),
      el('details', { style: 'margin-top:10px;' }, [
        el('summary', { style: 'cursor:pointer; color:var(--ds-text-dim); font-size:13px;' }, ['Додатково']),
        el('button', { class: 'btn-small btn-outline', style: 'margin-top:8px;', onclick: () => { if (confirm('Скинути трекер використаних тем? Наступна генерація зможе повторно видати вже бачені теми з цього моменту.')) socket.emit('admin:reset_used_themes', {}, (res) => { bankStats = res.stats; toast('Скинуто'); render(); }); } }, ['Скинути лічильник використаних тем'])
      ])
    ]);
    return panel;
  }

  // Host tool: arbitrary +/- to a TEAM's real score, at any moment -- this is
  // the actual "SIGame host" power dima asked for (broader than
  // admin:override_answer, which only flips the single most recent answer).
  function adjustTeamScore(roomCode, teamId, sign) {
    socket.emit('admin:adjust_team_score', { roomCode, teamId, delta: sign * SCORE_STEP }, (res) => { if (res && res.error) toast(res.error, true); });
  }

  function renderTeamScorePanel(r) {
    const rows = r.teams.map(t => {
      return el('div', { class: 'row between', style: 'padding:8px 0; border-bottom:1px solid var(--ds-border);' }, [
        el('span', { class: 'badge ' + (t.color === 'crimson' || t.color === 'crimson-dark' ? 'crimson' : t.color === 'orange' || t.color === 'orange-dark' ? 'orange' : '') }, [t.name]),
        el('strong', { style: 'font-size:18px;' }, [String(t.score)]),
        el('div', { class: 'team-score-adjust' }, [
          el('button', { class: 'btn-small btn-outline', onclick: () => adjustTeamScore(r.code, t.id, +1) }, ['+100']),
          el('button', { class: 'btn-small btn-outline crimson', onclick: () => adjustTeamScore(r.code, t.id, -1) }, ['−100'])
        ])
      ]);
    });
    return el('div', { class: 'ds-panel' }, [
      el('div', { class: 'ds-panel-label' }, ['🏆 Рахунок команд (ведучий може коригувати вручну в будь-який момент)']),
      el('div', { class: 'stack' }, rows)
    ]);
  }

  function renderBoardMonitor(r) {
    const round = r.rounds[r.currentRoundIndex];
    if (!round) return el('p', {}, []);
    const prices = [100, 200, 300, 400, 500];
    // minmax(0, 1fr) -- see style.css .board comment / PROGRESS.md item 12.
    const board = el('div', { class: 'board', style: 'grid-template-columns: repeat(' + round.themes.length + ', minmax(0, 1fr));' }, []);
    round.themes.forEach(t => board.appendChild(el('div', { class: 'theme-header' }, [t.name])));
    prices.forEach(price => {
      round.themes.forEach(theme => {
        const q = theme.questions.find(q => q.price === price);
        // muted checkmark instead of fully-invisible text -- see PROGRESS.md item 6
        board.appendChild(el('div', { class: 'cell' + (q && q.used ? ' used' : '') }, [q && q.used ? '✓' : String(price)]));
      });
    });
    return el('div', { class: 'board-wrap' }, [board]);
  }

  function renderPlayerStatsPanel() {
    const sorted = [...playerStats].sort((a, b) => (b.correct - b.incorrect) - (a.correct - a.incorrect));
    return el('div', { class: 'ds-panel' }, [
      el('div', { class: 'row between' }, [
        el('div', { class: 'ds-panel-label', style: 'margin:0;' }, ['📈 Статистика гравців (для розподілу команд)']),
        el('button', { class: 'btn-small btn-outline', onclick: refreshPlayerStats }, ['Оновити'])
      ]),
      el('table', { style: 'margin-top:10px;' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, ['Нікнейм']), el('th', {}, ['✓']), el('th', {}, ['✗']), el('th', {}, ['Точність'])])]),
        el('tbody', {}, sorted.map(p => {
          const total = p.correct + p.incorrect;
          const acc = total ? Math.round((p.correct / total) * 100) + '%' : '—';
          return el('tr', {}, [el('td', {}, [p.nickname]), el('td', {}, [String(p.correct)]), el('td', {}, [String(p.incorrect)]), el('td', {}, [acc])]);
        }))
      ])
    ]);
  }

  boot();
})();
