(function () {
  const socket = io();
  const app = document.getElementById('app');

  let me = { nickname: localStorage.getItem('sigame_nickname') || '', roomCode: (localStorage.getItem('sigame_roomcode') || '').toUpperCase() };
  let joined = false;
  let roomState = null;
  let activeClue = null;
  let lastResult = null;
  let timerEnd = null;
  let timerHandle = null;
  let resultClearHandle = null;
  let answerLocked = false; // guards against double-submit (e.g. two clicks on a logo option)
  let hintRequestPending = false; // guards against double-clicking "buy a hint" while awaiting the server's ack
  let scoreFlash = null; // { teamId, delta } -- briefly pulses a team pill + shows a floating +/-N after a score change
  let scoreFlashHandle = null;

  // ---- fun facts (fills otherwise-empty space, see PROGRESS.md item 10) ----
  // Neutral trivia only (science/nature/history/space) -- deliberately no
  // politics or anything divisive, this is a party-game filler, not content.
  const FUN_FACTS = [
    'Мед не псується — археологи знаходили їстівний мед у єгипетських гробницях віком понад 3000 років.',
    'Восьминоги мають три серця і кров блакитного кольору.',
    'Банан з ботанічної точки зору — це ягода, а полуниця — ні.',
    'Один день на Венері (період обертання навколо своєї осі) довший, ніж рік на Венері.',
    'Найкоротша війна в історії тривала близько 38 хвилин — англо-занзібарська війна 1896 року.',
    'Морські видри іноді сплять, тримаючись за лапи одна одної, щоб течія не рознесла їх у різні боки.',
    'Відбитки язика у людей такі ж унікальні, як і відбитки пальців.',
    'Гора Еверест щороку "підростає" приблизно на 4 мм через рух тектонічних плит.',
    'Найбільша пустеля світу за визначенням (мало опадів) — Антарктида, а не Сахара.',
    'Блискавка вдаряє в Землю близько 8 мільйонів разів на добу.',
    'Перша комп’ютерна "мишка" (1964 рік) була зроблена з дерева.',
    'У бджіл є п’ять очей: два великих і три маленьких.',
    'Наскільки відомо науці, не існує двох сніжинок з однаковою кристалічною структурою.',
    'Кава — друга за обсягом світової торгівлі сировина після нафти.',
    'Серце людини за певних умов може продовжувати битися навіть відокремленим від тіла, поки має кисень.',
    'Динозаври існували на Землі значно довше за людей — десятки мільйонів років проти сотень тисяч.',
    'У Стародавньому Римі сечу використовували як джерело аміаку для прання одягу.',
    'Ківі (птах) відкладає яйця, які відносно розміру його тіла є одними з найбільших серед птахів.',
    'Для зовнішнього спостерігача час біля горизонту подій чорної діри тече повільніше.',
    'Осьминоги та восьминоги (так, це те саме слово) можуть змінювати і колір, і текстуру шкіри за частки секунди.'
  ];
  function showRandomFact() {
    const fact = FUN_FACTS[Math.floor(Math.random() * FUN_FACTS.length)];
    openModal('\u{1F4A1} Цікавий факт', [el('p', {}, [fact])]);
  }
  function factButton() {
    return el('button', { type: 'button', class: 'fact-button', onclick: showRandomFact }, ['\u{1F4A1} Цікавий факт']);
  }

  // ---- "how does this work" rules popover (theme-header click, point 1) ----
  // General mechanics explanation, not a per-category hint (the data has no
  // such field) -- see PROGRESS.md item 1.
  function showRulesModal() {
    openModal('Як грати', [
      el('p', {}, ['Дошка — це теми (стовпці) на ціни (клітинки). Хід переходить командам по черзі.']),
      el('ol', {}, [
        el('li', {}, ['Команда, чия зараз черга, обирає ОДНУ клітинку — ціна одразу показує складність (чим дорожче, тим важче питання).']),
        el('li', {}, ['Питання бачать усі, але відповідає лише команда, чий зараз хід — це НЕ перегони "хто перший натисне", а команда з обмеженим часом на відповідь.']),
        el('li', {}, ['Правильна відповідь = команда отримує +ціна очок. Неправильна відповідь або вичерпаний час = −ціна (за замовчуванням).']),
        el('li', {}, ['Хід переходить до наступної команди по колу — незалежно від того, чи відповіли правильно.']),
        el('li', {}, ['Коли всі клітинки розкрито, починається наступний раунд (буде помітний банер), а після останнього раунду — підсумок гри.'])
      ])
    ]);
  }

  // ---- voice chat (team-scoped mesh WebRTC) ----
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // STUN only, no signup needed; see README for the TURN limitation
  let micEnabled = false;
  let voiceGroupTeamId = null; // which team's voice group we're currently joined to server-side
  let localStream = null;
  let peerConnections = {}; // remoteSocketId -> RTCPeerConnection
  let remoteAudioEls = {};  // remoteSocketId -> <audio>
  let voicePeerNames = {};  // remoteSocketId -> nickname, for the "on the line: ..." UI text

  const TEAM_COLOR_CLASS = {
    turquoise: 'team-turquoise', crimson: 'team-crimson', orange: 'team-orange',
    'turquoise-dark': 'team-turquoise-dark', 'crimson-dark': 'team-crimson-dark', 'orange-dark': 'team-orange-dark'
  };

  // ---- avatars ----
  // Persisted like sigame_nickname/sigame_roomcode so a returning player
  // doesn't have to re-upload every time they rejoin. This is a NEW key,
  // separate from the protected sigame_* identifiers used for auth/session.
  let pendingAvatar = localStorage.getItem('sigame_avatar') || null;

  /**
   * Reads an <input type=file> image, center-crops it to a square, downsizes
   * it to maxSize x maxSize, and re-encodes as JPEG at the given quality --
   * all client-side via <canvas>, so what actually goes over the socket is a
   * small (~5-20KB) data: URL instead of a multi-megabyte phone photo. This
   * is what keeps avatar broadcasts cheap and fast for every other player.
   */
  function readAndResizeImage(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) return reject(new Error('Файл має бути зображенням'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Не вдалося розпізнати зображення'));
        img.onload = () => {
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = maxSize; canvas.height = maxSize;
          canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function myPlayer() {
    if (!roomState) return null;
    return roomState.players.find(p => p.nickname.toLowerCase() === me.nickname.toLowerCase()) || null;
  }
  function myTeamId() {
    const p = myPlayer();
    return p ? p.teamId : null;
  }
  function isMyTurn() {
    return roomState && roomState.activeTeamId && myTeamId() === roomState.activeTeamId;
  }
  function teamById(id) {
    return roomState && roomState.teams.find(t => t.id === id);
  }

  // ---------------- rendering ----------------

  function render() {
    clear(app);
    if (!joined || !roomState) return renderJoin();
    if (roomState.status === 'lobby') return renderLobby();
    if (roomState.status === 'in_progress') return renderGame();
    if (roomState.status === 'finished') return renderFinished();
  }

  function renderJoin() {
    const nickInput = el('input', { type: 'text', id: 'nick', placeholder: 'Наприклад, Діма', value: me.nickname, maxlength: '24' });
    const codeInput = el('input', { type: 'text', id: 'code', placeholder: 'Наприклад, AB3K', value: me.roomCode, maxlength: '8', style: 'text-transform:uppercase; letter-spacing:3px; font-weight:700;' });

    // ---- avatar picker ----
    // avatarRemoveWrap is a persistent container whose contents refreshAvatarPreview()
    // rewrites in place (not a full render()), so picking/removing a photo never
    // wipes whatever the player has already typed into nickInput/codeInput.
    const avatarPreview = el('div', { class: 'avatar-picker-preview' }, []);
    const avatarRemoveWrap = el('div', {}, []);
    function refreshAvatarPreview() {
      clear(avatarPreview);
      avatarPreview.appendChild(avatarEl({ nickname: nickInput.value, avatar: pendingAvatar }, 76));
      clear(avatarRemoveWrap);
      if (pendingAvatar) {
        avatarRemoveWrap.appendChild(el('a', { href: '#', class: 'avatar-remove-link', onclick: (e) => {
          e.preventDefault();
          pendingAvatar = null;
          localStorage.removeItem('sigame_avatar');
          refreshAvatarPreview();
        }}, ['прибрати фото']));
      }
    }
    refreshAvatarPreview();
    nickInput.addEventListener('input', () => { if (!pendingAvatar) refreshAvatarPreview(); });

    const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none;', onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      readAndResizeImage(file, 96, 0.72).then((dataUrl) => {
        pendingAvatar = dataUrl;
        localStorage.setItem('sigame_avatar', dataUrl);
        refreshAvatarPreview();
      }).catch((err) => toast(err.message || 'Не вдалося завантажити фото', true));
    }});
    const avatarPicker = el('div', { class: 'avatar-picker', onclick: () => fileInput.click() }, [
      avatarPreview,
      el('div', { class: 'avatar-picker-label' }, ['Аватарка (необов’язково)']),
      fileInput
    ]);

    const form = el('form', { class: 'stack', onsubmit: (e) => {
      e.preventDefault();
      const nickname = nickInput.value.trim();
      const roomCode = codeInput.value.trim().toUpperCase();
      if (!nickname || !roomCode) return toast('Вкажіть нікнейм і код кімнати', true);
      socket.emit('player:join', { nickname, roomCode, avatar: pendingAvatar || undefined }, (res) => {
        if (res.error) return toast(res.error, true);
        if (res.avatarRejected) toast('Аватарку не вдалося застосувати (завеликий файл чи формат) -- решта пройшла нормально', true);
        me = { nickname, roomCode };
        localStorage.setItem('sigame_nickname', nickname);
        localStorage.setItem('sigame_roomcode', roomCode);
        joined = true;
        roomState = res.room;
        syncVoiceTeam();
        render();
      });
    }}, [
      el('div', { class: 'field', style: 'text-align:center;' }, [avatarPicker, avatarRemoveWrap]),
      el('div', { class: 'field' }, [el('label', {}, ['Нікнейм']), nickInput]),
      el('div', { class: 'field' }, [el('label', {}, ['Код кімнати']), codeInput]),
      el('button', { type: 'submit' }, ['Приєднатися до гри'])
    ]);

    app.appendChild(el('div', { class: 'center-screen', style: 'min-height:80vh;' }, [
      el('div', { class: 'card', style: 'max-width:420px; width:100%;' }, [
        el('img', { src: '/img/logo.jpg', alt: 'DSGame', class: 'brand-logo', style: 'display:block; width:110px; height:auto; margin:0 auto 10px;' }),
        el('h1', { class: 'brand-title', style: 'text-align:center; font-size:26px;' }, ['DS', el('span', { class: 'accent' }, ['Game'])]),
        form
      ])
    ]));
  }

  // File input + upload flow shared by the lobby's "змінити аватарку" link --
  // unlike the join-screen picker (which only stages pendingAvatar locally
  // until submit), this sends straight to the server via player:set_avatar
  // since the player already has a live session to attach the change to.
  function renderChangeAvatarButton() {
    const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none;', onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      readAndResizeImage(file, 96, 0.72).then((dataUrl) => {
        socket.emit('player:set_avatar', { avatar: dataUrl }, (res) => {
          if (res && res.error) return toast(res.error, true);
          pendingAvatar = dataUrl;
          localStorage.setItem('sigame_avatar', dataUrl);
        });
      }).catch((err) => toast(err.message || 'Не вдалося завантажити фото', true));
    }});
    return el('span', {}, [
      el('button', { type: 'button', class: 'btn-small btn-outline', onclick: () => fileInput.click() }, ['Змінити аватарку']),
      fileInput
    ]);
  }

  function rosterRow(p) {
    return el('div', { class: 'roster-row' }, [
      avatarEl(p, 32),
      el('span', {}, [(p.connected ? '' : '(офлайн) ') + p.nickname + (p.personalScore ? ' (' + (p.personalScore > 0 ? '+' : '') + p.personalScore + ')' : '')])
    ]);
  }

  function renderLobby() {
    const wrap = el('div', {}, []);
    wrap.appendChild(el('div', { class: 'row between' }, [
      el('h2', {}, ['Кімната ']),
      el('span', { class: 'badge outline' }, [roomState.code])
    ]));
    wrap.appendChild(el('div', { class: 'row between' }, [
      el('p', { style: 'margin:0;' }, ['Очікуємо, поки адмін сформує команди й почне гру...']),
      renderChangeAvatarButton()
    ]));

    if (roomState.teams.length === 0) {
      wrap.appendChild(el('h3', {}, ['Гравці в лобі (' + roomState.players.length + ')']));
      wrap.appendChild(el('div', { class: 'stack' }, roomState.players.map(rosterRow)));
    } else {
      wrap.appendChild(el('h3', {}, ['Команди']));
      wrap.appendChild(el('div', { class: 'teams-bar' }, roomState.teams.map(t => {
        const members = roomState.players.filter(p => p.teamId === t.id);
        return el('div', { class: 'team-pill ' + (TEAM_COLOR_CLASS[t.color] || '') }, [
          el('div', {}, [t.name]),
          el('div', { class: 'mini-roster' }, members.length ? members.map(p =>
            el('div', { class: 'mini-roster-row' }, [
              avatarEl(p, 22),
              el('span', {}, [p.nickname + (p.personalScore ? ' (' + (p.personalScore > 0 ? '+' : '') + p.personalScore + ')' : '')])
            ])
          ) : [el('div', { class: 'mini-roster-row' }, ['—'])])
        ]);
      })));
      const lobbyVoicePanel = renderVoicePanel();
      if (lobbyVoicePanel) wrap.appendChild(lobbyVoicePanel);
      const lobbyMusicPanel = renderTeamMusicPanel();
      if (lobbyMusicPanel) wrap.appendChild(lobbyMusicPanel);
      // Players who joined after teams were formed have no teamId yet --
      // call this out explicitly instead of silently omitting them from
      // every team pill above, which otherwise looks like a bug ("where did
      // I go?") rather than the expected "wait for the next reshuffle".
      const unassigned = roomState.players.filter(p => !p.teamId);
      if (unassigned.length) {
        wrap.appendChild(el('h3', { style: 'margin-top:10px;' }, ['Без команди (' + unassigned.length + ')']));
        wrap.appendChild(el('div', { class: 'stack' }, unassigned.map(rosterRow)));
        wrap.appendChild(el('p', { style: 'font-size:13px;' }, ['Ви приєднались після розподілу команд. Попросіть адміна перебалансувати команди перед початком гри.']));
      }
    }
    wrap.appendChild(factButton());
    app.appendChild(wrap);
  }

  function renderTeamsBar() {
    return el('div', { class: 'teams-bar' }, roomState.teams.map(t => {
      const flashHere = scoreFlash && scoreFlash.teamId === t.id;
      const pillChildren = [
        el('div', {}, [t.name + (t.id === roomState.activeTeamId ? ' ◀ хід' : '')]),
        el('div', { class: 'score' }, [String(t.score)])
      ];
      if (flashHere) {
        pillChildren.push(el('div', { class: 'score-float' }, [(scoreFlash.delta >= 0 ? '+' : '') + scoreFlash.delta]));
      }
      return el('div', { class: 'team-pill ' + (TEAM_COLOR_CLASS[t.color] || '') + (t.id === roomState.activeTeamId ? ' active' : '') + (flashHere ? ' score-pulse' : '') }, pillChildren);
    }));
  }

  // Briefly pulses the scoring team's pill and shows a floating +/-N, then
  // clears itself and re-renders back to normal.
  function triggerScoreFlash(teamId, delta) {
    scoreFlash = { teamId, delta };
    if (scoreFlashHandle) clearTimeout(scoreFlashHandle);
    scoreFlashHandle = setTimeout(() => { scoreFlash = null; render(); }, 1400);
  }

  function renderGame() {
    const wrap = el('div', {}, []);
    const round = roomState.rounds[roomState.currentRoundIndex];

    wrap.appendChild(el('div', { class: 'row between' }, [
      el('h2', {}, [round ? round.name : 'Гра']),
      el('span', { class: 'badge outline' }, ['Кімната ' + roomState.code])
    ]));
    wrap.appendChild(renderTeamsBar());
    const gameVoicePanel = renderVoicePanel();
    if (gameVoicePanel) wrap.appendChild(gameVoicePanel);
    const gameMusicPanel = renderTeamMusicPanel();
    if (gameMusicPanel) wrap.appendChild(gameMusicPanel);

    if (!myTeamId()) {
      // Joined after the admin formed teams (or reconnected after being
      // kicked) -- the board below will render fully "locked" for this
      // player since isMyTurn() can never be true without a teamId; without
      // this note that just looks broken instead of "wait for next game".
      wrap.appendChild(el('p', { style: 'color:var(--crimson-dark); font-weight:600;' },
        ['Ви ще без команди -- дошка нижче доступна лише для перегляду. Попросіть адміна перебалансувати команди перед наступною грою.']));
    }

    if (activeClue) {
      wrap.appendChild(renderCluePanel());
    } else if (lastResult) {
      wrap.appendChild(renderResultBanner());
      wrap.appendChild(renderBoard(round));
      wrap.appendChild(factButton());
    } else {
      wrap.appendChild(renderBoard(round));
      wrap.appendChild(factButton());
    }

    app.appendChild(wrap);
  }

  function renderBoard(round) {
    if (!round) return el('p', {}, ['Дошку ще не згенеровано.']);
    const prices = [100, 200, 300, 400, 500];
    // minmax(0, 1fr) (not a bare 1fr) is what actually lets grid columns
    // shrink below their content's natural width -- see style.css .board
    // comment / PROGRESS.md item 12 (a bare 1fr used to force a horizontal
    // scrollbar on ordinary window sizes because of the old min-width:640px).
    const board = el('div', { class: 'board', style: 'grid-template-columns: repeat(' + round.themes.length + ', minmax(0, 1fr));' }, []);
    round.themes.forEach(t => board.appendChild(el('div', {
      class: 'theme-header',
      // General "how do I play this" popover (point 1) -- explicitly NOT a
      // per-category hint. theme-header cells are siblings of the price-cell
      // buttons appended below (not their ancestor), so this click can never
      // bubble into/trigger a price cell's own onclick; stopPropagation()
      // here is extra insurance in case the DOM structure ever changes
      // (see PROGRESS.md item 7 on not creating stray-click bugs).
      onclick: (e) => { e.stopPropagation(); showRulesModal(); }
    }, [t.name])));
    prices.forEach(price => {
      round.themes.forEach(theme => {
        const q = theme.questions.find(q => q.price === price);
        const usable = q && !q.used && isMyTurn() && !activeClue;
        const btn = el('button', {
          class: 'cell' + (q && q.used ? ' used' : '') + (q && !q.used && !isMyTurn() ? ' locked' : ''),
          disabled: usable ? null : 'disabled',
          onclick: () => {
            if (!usable) return; // belt-and-suspenders: real browsers already ignore clicks on disabled buttons
            socket.emit('player:pick_question', { themeId: theme.id, price }, (res) => {
              if (res.error) toast(res.error, true);
            });
          }
          // "used" cells show a muted checkmark instead of the old fully
          // invisible (background===color) text -- see style.css .cell.used
          // and PROGRESS.md item 6.
        }, [q && q.used ? '✓' : String(price)]);
        board.appendChild(btn);
      });
    });
    return el('div', { class: 'board-wrap' }, [board]);
  }

  function renderCluePanel() {
    // Defensive guard (PROGRESS.md item 7 -- "block clicking/typing where it
    // shouldn't be possible"): don't rely on isMyTurn() alone. Also require
    // the server's OWN room state to still agree this exact question is the
    // open one before rendering anything interactive. In the extremely rare
    // case these ever disagree (e.g. a stale local copy right at the instant
    // a question resolves), we fail toward "can't answer yet" rather than
    // toward "accepts input" -- never the other way around.
    const stillOpenOnServer = !!(roomState.activeQuestion &&
      roomState.activeQuestion.themeId === activeClue.themeId &&
      roomState.activeQuestion.price === activeClue.price);
    const canAnswer = isMyTurn() && stillOpenOnServer && !answerLocked;

    const panel = el('div', { class: 'clue-panel' }, []);
    panel.appendChild(el('div', { class: 'row between' }, [
      el('strong', {}, [activeClue.themeName + ' — ' + activeClue.price]),
      el('span', {}, [isMyTurn() ? 'Ваш хід!' : 'Відповідає ' + (teamById(roomState.activeTeamId) || {}).name])
    ]));

    const timerFill = el('div', { class: 'timer-bar-fill', id: 'timerFill' });
    panel.appendChild(el('div', { class: 'timer-bar' }, [timerFill]));

    panel.appendChild(el('div', { class: 'clue-text' }, [activeClue.clue.text]));
    if (activeClue.clue.imageUrl) {
      panel.appendChild(el('div', { class: 'clue-image-wrap' }, [
        el('img', { class: 'clue-image', src: activeClue.clue.imageUrl, alt: 'Підказка' })
      ]));
    }
    if (activeClue.clue.audioUrl) {
      // autoplay is intentionally left off -- a sudden sound blast the
      // instant a question opens (esp. on a shared TV/speaker) is worse UX
      // than one extra tap; controls give players their own play/pause/seek.
      panel.appendChild(el('div', { class: 'clue-audio-wrap' }, [
        el('audio', { class: 'clue-audio', src: activeClue.clue.audioUrl, controls: 'controls', preload: 'auto' })
      ]));
    }

    // dima's point 5: the active team can spend half the question's price
    // (from their own team score) to buy 15 extra answer-clock seconds.
    // Only shown to the team currently answering, same scoping as the
    // answer form below -- and only before it's been spent once already.
    if (isMyTurn() && stillOpenOnServer) {
      const hintCost = Math.round(activeClue.price / 2);
      if (activeClue.hintUsed) {
        panel.appendChild(el('p', { class: 'hint-used-note', style: 'font-size:12px; opacity:.7; margin-top:8px;' }, ['Підказку для цього питання вже використано.']));
      } else {
        panel.appendChild(el('button', {
          class: 'btn-outline', style: 'margin-top:10px; width:100%;',
          disabled: hintRequestPending ? 'disabled' : null,
          onclick: () => {
            if (hintRequestPending || !activeClue) return;
            hintRequestPending = true;
            socket.emit('player:use_hint', { themeId: activeClue.themeId, price: activeClue.price }, (res) => {
              hintRequestPending = false;
              if (res && res.error) toast(res.error, true);
              render();
            });
          }
        }, ['\u{1F4A1} Підказка у адміна (−' + hintCost + ' команді, +15с)']));
      }
    }

    if (activeClue.type === 'select') {
      const grid = el('div', { class: 'logo-grid' }, activeClue.clue.options.map(opt =>
        el('div', { class: 'logo-option', html: opt.svg, onclick: (e) => {
          if (!canAnswer) return;
          answerLocked = true;
          socket.emit('player:submit_answer', { optionId: opt.optionId }, (res) => {
            if (res && res.error) { toast(res.error, true); answerLocked = false; }
          });
        }})
      ));
      panel.appendChild(canAnswer ? grid : el('div', { class: 'logo-grid' }, activeClue.clue.options.map(opt => el('div', { class: 'logo-option', html: opt.svg }))));
    } else {
      const input = el('input', { type: 'text', placeholder: 'Ваша відповідь...', autocomplete: 'off' });
      const form = el('form', { class: 'row', style: 'margin-top:14px;', onsubmit: (e) => {
        e.preventDefault();
        if (!canAnswer) return;
        const text = input.value.trim();
        if (!text) return;
        answerLocked = true;
        input.disabled = true;
        socket.emit('player:submit_answer', { text }, (res) => {
          if (res && res.error) { toast(res.error, true); input.disabled = false; answerLocked = false; }
        });
      }}, [
        el('div', { style: 'flex:1;' }, [input]),
        el('button', { type: 'submit' }, ['Відповісти'])
      ]);
      if (canAnswer) panel.appendChild(form);
      else panel.appendChild(el('p', {}, ['Очікуємо відповідь від команди суперників...']));
    }
    return panel;
  }

  function renderResultBanner() {
    const cls = lastResult.wasCorrect ? 'correct' : 'incorrect';
    const who = lastResult.timedOut ? 'Час вийшов!' : (lastResult.wasCorrect ? 'Правильно!' : 'Неправильно.');
    return el('div', { class: 'result-banner ' + cls }, [
      who + ' Правильна відповідь: ' + lastResult.correctDisplay + '. (' + (lastResult.delta >= 0 ? '+' : '') + lastResult.delta + ' очок)'
    ]);
  }

  let finishedConfettiFiredFor = null;
  function renderFinished() {
    const sorted = [...roomState.teams].sort((a, b) => b.score - a.score);
    if (finishedConfettiFiredFor !== roomState.code) {
      finishedConfettiFiredFor = roomState.code;
      confettiBurst(140);
    }
    app.appendChild(el('div', {}, [
      el('h2', {}, ['Гру завершено!']),
      el('div', { class: 'stack' }, sorted.map((t, i) =>
        el('div', { class: 'card', style: 'display:flex; justify-content:space-between; align-items:center;' }, [
          el('div', {}, [(i === 0 ? '\u{1F3C6} ' : (i + 1) + '. ') + t.name]),
          el('div', { style: 'font-size:22px; font-weight:800;' }, [String(t.score)])
        ])
      ))
    ]));
  }

  // ---------------- timer ----------------
  function startTimer(ms) {
    stopTimer();
    timerEnd = Date.now() + ms;
    timerHandle = setInterval(() => {
      const fill = document.getElementById('timerFill');
      if (!fill) return;
      const remaining = Math.max(0, timerEnd - Date.now());
      const pct = remaining / ms;
      fill.style.width = Math.round(pct * 100) + '%';
      fill.classList.toggle('low', pct <= 0.25);
      if (remaining <= 0) stopTimer();
    }, 250);
  }
  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }

  // ---------------- voice chat (WebRTC mesh, team-scoped) ----------------
  // Mesh: one RTCPeerConnection per teammate, audio flows directly
  // peer-to-peer after signaling (this server only ever relays SDP/ICE,
  // never audio). Convention to avoid offer/offer glare: whoever JOINS an
  // already-populated voice group always initiates the offer to each
  // existing member; existing members only ever answer. See
  // src/socket/socketHandlers.js for the server-side isolation guarantee.

  function attachRemoteAudio(remoteId, stream) {
    let audioEl = remoteAudioEls[remoteId];
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      remoteAudioEls[remoteId] = audioEl;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
  }

  function createVoicePeerConnection(remoteId, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections[remoteId] = pc;
    if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('voice:ice', { to: remoteId, candidate: e.candidate }, () => {}); };
    pc.ontrack = (e) => attachRemoteAudio(remoteId, e.streams[0]);
    if (isInitiator) {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => socket.emit('voice:offer', { to: remoteId, sdp: pc.localDescription }, () => {}))
        .catch(() => { /* best-effort: voice chat is a bonus feature, never blocks the game */ });
    }
    return pc;
  }

  function closeVoicePeer(remoteId) {
    const pc = peerConnections[remoteId];
    if (pc) { try { pc.close(); } catch (e) { /* already closed */ } delete peerConnections[remoteId]; }
    const audioEl = remoteAudioEls[remoteId];
    if (audioEl) { audioEl.srcObject = null; audioEl.remove(); delete remoteAudioEls[remoteId]; }
    delete voicePeerNames[remoteId];
  }

  function closeAllVoicePeers() { Object.keys(peerConnections).forEach(closeVoicePeer); }

  function joinVoiceGroup() {
    const teamId = myTeamId();
    if (!localStream || !teamId) return;
    socket.emit('voice:join', {}, (res) => {
      if (!res || res.error) { toast((res && res.error) || 'Не вдалося приєднатись до голосового чату', true); return; }
      voiceGroupTeamId = teamId;
      (res.peers || []).forEach(p => {
        voicePeerNames[p.socketId] = p.nickname;
        createVoicePeerConnection(p.socketId, true); // we're the new joiner -> we initiate
      });
      render();
    });
  }

  function leaveVoiceGroup() {
    if (voiceGroupTeamId !== null) socket.emit('voice:leave', {}, () => {});
    voiceGroupTeamId = null;
    closeAllVoicePeers();
  }

  async function enableMic() {
    if (!myTeamId()) return toast('Спочатку маєте бути в команді', true);
    if (!navigator.mediaDevices || !window.RTCPeerConnection) return toast('Цей браузер не підтримує голосовий чат', true);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast('Мікрофон недоступний: ' + ((err && err.message) || 'дозвіл відхилено'), true);
      return;
    }
    micEnabled = true;
    joinVoiceGroup();
    render();
  }

  function disableMic() {
    micEnabled = false;
    leaveVoiceGroup();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    render();
  }

  // Runs after every roomState refresh: if the mic is on but our team
  // changed (rebalance) or disappeared (kicked/unassigned), tear down the
  // old mesh and reconnect under the new team instead of silently staying
  // connected to the wrong group or leaking dead connections.
  function syncVoiceTeam() {
    if (!micEnabled) return;
    const currentTeam = myTeamId();
    if (currentTeam === voiceGroupTeamId) return;
    leaveVoiceGroup();
    if (currentTeam) {
      joinVoiceGroup();
    } else {
      micEnabled = false;
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      toast('Голосовий чат вимкнено -- ви зараз без команди', true);
    }
  }

  function renderVoicePanel() {
    if (!myTeamId()) return null;
    const peerNames = Object.values(voicePeerNames);
    return el('div', { class: 'card', style: 'margin:14px 0; padding:14px 18px;' }, [
      el('div', { class: 'row between' }, [
        el('strong', {}, ['\u{1F399} Голосовий чат команди']),
        el('button', { class: (micEnabled ? 'btn-crimson' : '') + ' btn-small', onclick: () => { micEnabled ? disableMic() : enableMic(); } },
          [micEnabled ? 'Вимкнути мікрофон' : 'Увімкнути мікрофон'])
      ]),
      el('p', { style: 'font-size:12px; margin:8px 0 0; color:var(--turquoise-dark);' }, [
        micEnabled
          ? ('На зв’язку: ' + (peerNames.length ? peerNames.join(', ') : 'поки тільки ви') + '. Чути тільки свою команду.')
          : 'Учасники вашої команди чують одне одного, коли мікрофон увімкнено. Іншу команду ви не чуєте ніколи.'
      ])
    ]);
  }

  // ---------------- team music (dima's ask: each team can play its own
  // background/thinking music, point 7 -- teammates on SEPARATE devices,
  // "навіть якщо грають на відстані", must hear the same track in sync) ----
  // The server (roomManager.setTeamMusic) holds one authoritative
  // {videoId, isPlaying, positionSec, updatedAt} per team; every team
  // member's own device still plays audio from ITS OWN speakers via its own
  // hidden YouTube iframe (so this genuinely plays out loud on each screen),
  // but all of them reconcile to the same track/position instead of only
  // whoever happens to have the panel open locally. lastKnownTeamMusicSignature
  // guards against reacting to every incidental room:state broadcast (any
  // player joining/answering triggers one) -- we only touch local playback
  // when the team's music actually changed.
  const teamYtHost = document.createElement('div');
  teamYtHost.id = 'ytTeamMusicPlayer';
  teamYtHost.style.cssText = 'position:absolute; width:1px; height:1px; visibility:hidden;';
  document.body.appendChild(teamYtHost);
  let teamMusicUrlDraft = '';
  let teamYtPlayer = null;
  let teamYtLoadedVideoId = null;
  let lastKnownTeamMusicSignature = null;
  startMusicProgressTicker(() => teamYtPlayer, 'teamMusicFill', 'teamMusicLabel');

  function currentTeamMusicState() {
    const teamId = myTeamId();
    return (teamId && roomState && roomState.teamMusic && roomState.teamMusic[teamId]) || null;
  }

  // Actions just ask the server to update the shared state -- actual local
  // playback always happens in applyTeamMusicState(), driven by the
  // team_music:state broadcast the actor receives back too (single code
  // path for everyone, including yourself; see socketHandlers.js).
  function playTeamMusicUrl(rawUrl) {
    const id = extractYouTubeId(rawUrl);
    if (!id) return toast('Не вдалося розпізнати посилання YouTube', true);
    socket.emit('player:team_music_play', { videoId: id, positionSec: 0 }, (res) => { if (res && res.error) toast(res.error, true); });
  }
  function pauseTeamMusic() {
    const posSec = (teamYtPlayer && teamYtPlayer.getCurrentTime && teamYtPlayer.getCurrentTime()) || 0;
    socket.emit('player:team_music_pause', { positionSec: posSec }, (res) => { if (res && res.error) toast(res.error, true); });
  }
  function stopTeamMusic() {
    socket.emit('player:team_music_stop', {}, (res) => { if (res && res.error) toast(res.error, true); });
  }

  function stopTeamMusicLocal() {
    if (teamYtPlayer && teamYtPlayer.stopVideo) teamYtPlayer.stopVideo();
    teamYtLoadedVideoId = null;
  }

  // Reconciles THIS device's hidden player against the server's shared
  // state. When isPlaying, positionSec is "as of updatedAt" -- add elapsed
  // wall-clock time so a late join/reconnect catches up mid-song instead of
  // restarting it from 0, same idea as activeQuestion's msRemaining.
  function applyTeamMusicState(musicState) {
    if (!musicState || !musicState.videoId) { stopTeamMusicLocal(); return; }
    const elapsedSec = musicState.isPlaying ? Math.max(0, (Date.now() - musicState.updatedAt) / 1000) : 0;
    const targetSec = musicState.positionSec + elapsedSec;
    ensureYouTubeApi(() => {
      if (!teamYtPlayer) {
        teamYtLoadedVideoId = musicState.videoId;
        teamYtPlayer = new YT.Player('ytTeamMusicPlayer', {
          height: '1', width: '1', videoId: musicState.videoId,
          playerVars: { autoplay: musicState.isPlaying ? 1 : 0, controls: 0, start: Math.floor(targetSec) },
          events: { onReady: (e) => { if (musicState.isPlaying) e.target.playVideo(); else e.target.pauseVideo(); } }
        });
        return;
      }
      if (musicState.videoId !== teamYtLoadedVideoId) {
        teamYtLoadedVideoId = musicState.videoId;
        teamYtPlayer.loadVideoById(musicState.videoId, targetSec);
      } else if (typeof teamYtPlayer.seekTo === 'function') {
        teamYtPlayer.seekTo(targetSec, true);
      }
      if (musicState.isPlaying) teamYtPlayer.playVideo(); else teamYtPlayer.pauseVideo();
    });
  }

  // Called from the same places syncActiveQuestion()/syncVoiceTeam() are --
  // initial rejoin and every room:state broadcast -- but only actually
  // touches playback when the signature (track + play/pause) changed.
  function syncTeamMusic(state) {
    const teamId = myTeamId();
    const musicState = teamId && state.teamMusic && state.teamMusic[teamId];
    const signature = musicState && musicState.videoId ? (musicState.videoId + ':' + musicState.isPlaying) : 'none';
    if (signature === lastKnownTeamMusicSignature) return;
    lastKnownTeamMusicSignature = signature;
    applyTeamMusicState(musicState);
  }

  function renderTeamMusicPanel() {
    if (!myTeamId()) return null;
    const musicState = currentTeamMusicState();
    const statusText = musicState && musicState.videoId ? (musicState.isPlaying ? '▶ Грає для всієї команди' : '⏸ На паузі (для всієї команди)') : 'Нічого не грає';
    const urlInput = el('input', {
      type: 'text', placeholder: 'Посилання на YouTube...', value: teamMusicUrlDraft,
      oninput: (e) => { teamMusicUrlDraft = e.target.value; }
    });
    return el('div', { class: 'card', style: 'margin:14px 0; padding:14px 18px;' }, [
      el('div', { class: 'row between' }, [el('strong', {}, ['\u{1F3B5} Музика команди']), el('span', { class: 'badge outline' }, [statusText])]),
      el('div', { class: 'field', style: 'margin-top:8px;' }, [urlInput]),
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'btn-small', onclick: () => playTeamMusicUrl(urlInput.value) }, ['▶ Грати']),
        el('button', { type: 'button', class: 'btn-small btn-outline', onclick: pauseTeamMusic }, ['⏸ Пауза']),
        el('button', { type: 'button', class: 'btn-small btn-outline crimson', onclick: stopTeamMusic }, ['■ Стоп'])
      ]),
      el('div', { class: 'timer-bar', style: 'margin-top:10px;' }, [el('div', { class: 'timer-bar-fill', id: 'teamMusicFill', style: 'background:var(--turquoise);' })]),
      el('div', { id: 'teamMusicLabel', style: 'font-size:12px; font-weight:700; color:var(--turquoise-dark);' }, ['0:00 / 0:00']),
      el('p', { style: 'font-size:12px; margin:6px 0 0; color:var(--turquoise-dark);' },
        ['Синхронізовано для всієї команди -- кожен чує зі своїх колонок, навіть якщо ви граєте на відстані. Пауза зберігає позицію для всіх.'])
    ]);
  }

  socket.on('voice:peer-joined', ({ socketId, nickname }) => {
    voicePeerNames[socketId] = nickname;
    // We never initiate here -- the joiner always offers to existing
    // members (see joinVoiceGroup), we just wait for their voice:offer.
    render();
  });

  socket.on('voice:peer-left', ({ socketId }) => { closeVoicePeer(socketId); render(); });

  socket.on('voice:offer', async ({ from, sdp }) => {
    let pc = peerConnections[from] || createVoicePeerConnection(from, false);
    try {
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voice:answer', { to: from, sdp: pc.localDescription }, () => {});
    } catch (err) { /* best-effort */ }
  });

  socket.on('voice:answer', async ({ from, sdp }) => {
    const pc = peerConnections[from];
    if (pc) { try { await pc.setRemoteDescription(sdp); } catch (err) { /* best-effort */ } }
  });

  socket.on('voice:ice', async ({ from, candidate }) => {
    const pc = peerConnections[from];
    if (pc && candidate) { try { await pc.addIceCandidate(candidate); } catch (err) { /* best-effort */ } }
  });

  // ---------------- socket events ----------------

  // Shared by the initial join, a page-refresh rejoin, and every room:state
  // broadcast: if the room currently has a question open, restore the clue
  // panel (with the correct remaining time) instead of leaving the player
  // stuck looking at a plain board with no way to answer until the 45s
  // server-side timeout eventually fires on its own.
  function syncActiveQuestion(state) {
    if (state.activeQuestion && state.activeQuestion.openedPayload) {
      const alreadyShowingThisQuestion = activeClue && activeClue.themeId === state.activeQuestion.themeId && activeClue.price === state.activeQuestion.price;
      if (!alreadyShowingThisQuestion) {
        activeClue = state.activeQuestion.openedPayload;
        answerLocked = false;
        lastResult = null;
        startTimer(Math.max(1000, state.activeQuestion.msRemaining || activeClue.timeoutMs || 45000));
      }
    } else if (!state.activeQuestion) {
      activeClue = null;
      stopTimer();
    }
  }

  socket.on('connect', () => {
    if (joined && me.nickname && me.roomCode) {
      socket.emit('player:join', { nickname: me.nickname, roomCode: me.roomCode }, (res) => {
        if (!res.error) { roomState = res.room; syncActiveQuestion(res.room); syncTeamMusic(res.room); syncVoiceTeam(); render(); }
      });
    }
  });

  socket.on('room:state', (state) => {
    if (!joined) return;
    if (state.code !== me.roomCode) return;
    roomState = state;
    syncActiveQuestion(state);
    syncTeamMusic(state);
    syncVoiceTeam();
    render();
  });

  // dima's point 7: the server only targets our own team's sockets (see
  // broadcastTeamMusic), so this always reflects OUR team's shared state.
  socket.on('team_music:state', (payload) => {
    if (!roomState || payload.code !== roomState.code) return;
    if (!roomState.teamMusic) roomState.teamMusic = {};
    roomState.teamMusic[payload.teamId] = payload.state;
    lastKnownTeamMusicSignature = payload.state && payload.state.videoId ? (payload.state.videoId + ':' + payload.state.isPlaying) : 'none';
    applyTeamMusicState(payload.state);
    render();
  });

  socket.on('question:opened', (payload) => {
    activeClue = payload;
    lastResult = null;
    answerLocked = false;
    if (resultClearHandle) clearTimeout(resultClearHandle);
    render();
    startTimer(payload.timeoutMs || 45000);
  });

  socket.on('answer:resolved', (result) => {
    activeClue = null;
    lastResult = result;
    stopTimer();
    if (result.scoringTeamId && typeof result.delta === 'number') triggerScoreFlash(result.scoringTeamId, result.delta);
    if (result.wasCorrect) confettiBurst(70);
    // Round transition used to be entirely invisible (turn just moved on) --
    // this is the "make it obvious a new round started" banner from
    // PROGRESS.md items 3/4. roomState.rounds itself doesn't change on a
    // round transition (only currentRoundIndex advances), so it's safe to
    // look up the new round's name here even though roomState is still the
    // PRE-transition object at this point (room:state with the bumped
    // currentRoundIndex arrives right after this event).
    if (result.roundComplete && !result.gameComplete && roomState) {
      const newRound = roomState.rounds[result.currentRoundIndex];
      showRoundBanner(
        'Раунд ' + result.currentRoundIndex + ' завершено!',
        'Починається раунд ' + (result.currentRoundIndex + 1) + (newRound ? ': ' + newRound.name : '')
      );
    }
    render();
    if (resultClearHandle) clearTimeout(resultClearHandle);
    resultClearHandle = setTimeout(() => { lastResult = null; render(); }, 5000);
  });

  socket.on('answer:corrected', () => { toast('Адмін скоригував останню відповідь'); });
  socket.on('game:started', () => { toast('Гру розпочато! Хід визначено.'); });
  socket.on('teams:rebalanced', () => { toast('Команди перебалансовано адміном'); });

  // dima's point 5: broadcast to the WHOLE room (both teams see the clock
  // change, not just the team that paid) -- mirrors admin.js's handling.
  socket.on('hint:used', (payload) => {
    if (!roomState || payload.code !== roomState.code) return;
    if (activeClue && activeClue.themeId === payload.themeId && activeClue.price === payload.price) {
      activeClue.hintUsed = true;
      startTimer(Math.max(1000, payload.msRemaining || 15000));
    }
    toast('Команда «' + ((teamById(payload.teamId) || {}).name || '') + '» купила підказку (−' + payload.cost + '), +15с на таймер');
    render();
  });

  render();
})();
