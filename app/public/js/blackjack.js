// Блекджек (Blackjack) client -- TWO modes now (2026-07-22, dima: "зроби щоб
// блек джек можна було грати з іншими учасниками"):
//   - solo: single player vs the house (the "dealer"). Unchanged since first
//     ship -- see src/games/blackjack.js + src/state/blackjackManager.js.
//   - table: a shared table, 2-6 human seats, one shared dealer sequence.
//     See src/games/blackjackTable.js + src/state/blackjackTableManager.js.
// Both are entered from the same mode-select screen below; nothing about the
// solo screen's markup/classes/copy changed, it's just now reached via a
// click instead of being the only thing this page could ever show.
//
// All rules/shuffle/dealer-play happen server-side either way -- this file
// only renders whatever the server's `view`/`table` state says and never
// computes hand values or dealer behavior itself, same "server is truth"
// discipline as the rest of the app (and doubly important here since real
// KKoin is at stake).
//
// Solo visual design ported 1:1 from dima's base44 reference
// (src/pages/Blackjack.jsx + components/blackjack/{PlayingCard,DealerAvatar}.jsx
// in the "6a5fd3917e81c2e03dba4d9a (1).zip" export, 2026-07-22) -- exact
// colors/copy/layout. The table mode has no reference design (the base44
// export never had a multiplayer table) -- it reuses the same bj-* visual
// language (cards, dealer ring, coin chip) plus new bjt-* classes for the
// seats row, kept in the same dark casino aesthetic.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const TABLE_STORAGE_KEY = 'bj_table_code';

  const DEALER_STATUS = {
    idle: { label: 'Очікую гравця', color: '#666666' },
    dealing: { label: 'Роздаю карти…', color: '#00FFD1' },
    player: { label: 'Твій хід', color: '#DAA520' },
    thinking: { label: 'Думаю…', color: '#3B82F6' },
    win: { label: 'Дилер переміг', color: '#C71585' },
    lose: { label: 'Гравець переміг', color: '#00FFD1' },
    push: { label: 'Нічия', color: '#666666' }
  };
  const RESULT_TEXT = {
    win: { text: 'Перемога!', color: '#00FFD1' },
    lose: { text: 'Програш', color: '#C71585' },
    push: { text: 'Нічия', color: '#DAA520' },
    bust: { text: 'Перебір', color: '#C71585' }
  };
  const SUIT_COLOR = { '♠': 'var(--hub-text, #E5E5E5)', '♣': 'var(--hub-text, #E5E5E5)', '♥': '#FF3B5C', '♦': '#FF3B5C' };

  let nickname = null;
  let mode = null; // null (mode-select) | 'solo' | 'table'

  // ---- solo mode state ----
  let view = null; // latest server view, or null if no active hand
  let balance = 0;
  let customBet = '';

  // ---- table mode state ----
  let tableCode = null;
  let tableState = null; // latest casino:table_state broadcast (or the table returned by create/join)
  let tableBetDraft = '';

  function computeDealerState() {
    if (!view) return 'idle';
    if (view.phase === 'player') return 'player';
    if (view.phase === 'dealer') return 'thinking';
    if (view.phase === 'result') {
      if (view.result === 'win') return 'lose';   // player won -> dealer lost
      if (view.result === 'push') return 'push';
      return 'win'; // player 'lose' or 'bust' -> dealer won
    }
    return 'idle';
  }

  function refreshBalance(cb) {
    fetch('/api/profile/' + encodeURIComponent(nickname)).then((r) => r.json()).then((data) => {
      balance = (data && data.profile && data.profile.kkoin) || 0;
      if (cb) cb();
    }).catch(() => { if (cb) cb(); });
  }

  // extraClass lets the table view reuse the exact same card visuals at a
  // smaller size (bj-card-sm, see style.css) for a row of up to 6 hands.
  function cardNode(card, hidden, delayIndex, extraClass) {
    const cls = 'bj-card' + (extraClass ? ' ' + extraClass : '');
    if (hidden) {
      return el('div', { class: cls + ' bj-card-back', style: 'animation-delay:' + (delayIndex * 0.12) + 's;' }, [
        el('span', { class: 'bj-card-back-mark' }, ['DS'])
      ]);
    }
    const color = SUIT_COLOR[card.suit] || 'var(--hub-text, #E5E5E5)';
    return el('div', { class: cls, style: 'animation-delay:' + (delayIndex * 0.12) + 's;' }, [
      el('div', { class: 'bj-card-corner bj-card-corner-tl', style: 'color:' + color + ';' }, [card.rank, el('span', {}, [card.suit])]),
      el('div', { class: 'bj-card-corner bj-card-corner-br', style: 'color:' + color + ';' }, [card.rank, el('span', {}, [card.suit])]),
      el('div', { class: 'bj-card-center', style: 'color:' + color + ';' }, [card.suit])
    ]);
  }

  function topBarNode(showModeSwitch) {
    const left = [el('a', { href: '/casino.html', class: 'back-link' }, ['← Казино'])];
    if (showModeSwitch) {
      left.push(el('button', {
        class: 'btn-small btn-outline', style: 'margin-left:10px; padding:6px 12px; font-size:10px;',
        onclick: () => { mode = null; tableState = null; render(); }
      }, ['🔁 Інший режим']));
    }
    return el('div', { class: 'bj-topbar', style: 'display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;' }, [
      el('div', { style: 'display:flex; align-items:center;' }, left),
      el('div', { class: 'bj-coin-chip' }, [
        el('span', { class: 'bj-coin-icon' }, ['\u{1FA99}']),
        el('span', { class: 'bj-coin-value' }, [String(balance)]),
        el('span', { class: 'bj-coin-label' }, ['KKoin'])
      ])
    ]);
  }

  function titleBlockNode(subtitle) {
    return el('div', { class: 'bj-title-block' }, [
      el('div', { class: 'bj-eyebrow' }, ['/ Казино · 21']),
      el('h1', { class: 'bj-title' }, ['Блекджек' + (subtitle ? ' — ' + subtitle : '')])
    ]);
  }

  function render() {
    clear(app);
    if (mode === 'table') return renderTableScreen();
    if (mode === 'solo') return renderSoloScreen();
    renderModeSelect();
  }

  // ================= mode select =================
  function renderModeSelect() {
    const grid = el('div', { class: 'bj-mode-grid' }, [
      el('div', { class: 'bj-mode-card', onclick: enterSolo }, [
        el('div', { class: 'bj-mode-card-icon' }, ['♠️']),
        el('div', { class: 'bj-mode-card-title' }, ['Проти дилера']),
        el('div', { class: 'bj-mode-card-desc' }, ['Класичний соло-раунд 1 на 1 проти дилера будинку.'])
      ]),
      el('div', { class: 'bj-mode-card', onclick: enterTableMode }, [
        el('div', { class: 'bj-mode-card-icon' }, ['👥']),
        el('div', { class: 'bj-mode-card-title' }, ['За столом з друзями']),
        el('div', { class: 'bj-mode-card-desc' }, ['Спільний стіл на 2-6 гравців, одна колода, один дилер на всіх, черга ходів.'])
      ])
    ]);
    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBarNode(false), titleBlockNode(null), grid])
    ]));
  }

  // ================= solo mode (unchanged behavior) =================
  function enterSolo() {
    mode = 'solo';
    socket.emit('casino:blackjack_state', { nickname }, (res) => {
      if (res && res.ok && res.view) view = res.view;
      render();
    });
  }

  function renderSoloScreen() {
    const dState = computeDealerState();
    const dInfo = DEALER_STATUS[dState] || DEALER_STATUS.idle;

    const dealerCards = view ? view.dealer.map((c, i) => cardNode(c, false, i)) : [];
    if (view && view.dealerHasHiddenCard) {
      dealerCards.push(cardNode(null, true, dealerCards.length));
    }
    const dealerBlock = el('div', { class: 'bj-side' }, [
      el('div', { class: 'bj-dealer' }, [
        el('div', { class: 'bj-dealer-ring' + (dState === 'thinking' || dState === 'dealing' ? ' bj-spin' : ''), style: 'border-color:' + dInfo.color + ';' }, [
          el('div', { class: 'bj-dealer-core', style: 'border-color:' + dInfo.color + '; box-shadow:0 0 30px ' + dInfo.color + '30;' }, [
            el('span', { class: 'bj-dealer-spade', style: 'color:' + dInfo.color + ';' }, ['♠'])
          ])
        ]),
        el('div', { class: 'bj-dealer-status' }, [
          el('span', { class: 'bj-dealer-dot', style: 'background:' + dInfo.color + '; box-shadow:0 0 8px ' + dInfo.color + ';' }),
          el('span', { style: 'color:' + dInfo.color + ';' }, ['Дилер · ' + dInfo.label])
        ])
      ]),
      el('div', { class: 'bj-cards-row' }, dealerCards),
      view && view.dealer.length ? el('div', { class: 'bj-hand-label' }, ['Дилер: ', el('span', { class: 'bj-hand-value' }, [view.dealerHasHiddenCard ? '?' : String(view.dealerValue)])]) : null
    ]);

    const playerCards = view ? view.player.map((c, i) => cardNode(c, false, i)) : [];
    const playerExtra = [];
    if (view && view.playerValue > 21) playerExtra.push(el('span', { style: 'margin-left:8px; color:#C71585;' }, ['Перебір']));
    else if (view && view.playerValue === 21) playerExtra.push(el('span', { style: 'margin-left:8px; color:#00FFD1;' }, ['21!']));
    const playerBlock = el('div', { class: 'bj-side' }, [
      el('div', { class: 'bj-cards-row' }, playerCards),
      view && view.player.length ? el('div', { class: 'bj-hand-label' }, ['Ти: ', el('span', { class: 'bj-hand-value' }, [String(view.playerValue)]), ...playerExtra]) : null
    ]);

    const resultBanner = (view && view.phase === 'result' && view.result) ? el('div', { class: 'bj-result-wrap' }, [
      el('span', { class: 'bj-result-banner', style: 'color:' + RESULT_TEXT[view.result].color + '; border-color:' + RESULT_TEXT[view.result].color + ';' }, [RESULT_TEXT[view.result].text])
    ]) : null;

    const table = el('div', { class: 'bj-table' }, [
      el('div', { class: 'bj-felt-glow' }),
      dealerBlock,
      el('div', { class: 'bj-divider' }, [
        el('span', { class: 'bj-divider-line' }), el('span', { class: 'bj-divider-label' }, ['VS']), el('span', { class: 'bj-divider-line' })
      ]),
      playerBlock,
      resultBanner
    ]);

    const controls = el('div', { class: 'bj-controls' }, [renderSoloControls()]);

    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBarNode(true), titleBlockNode('соло'), table, controls])
    ]));
  }

  function renderSoloControls() {
    if (!view) {
      // bet screen. dima 2026-07-22: "по базі ще хай буде ставка 1, 5, 10" --
      // fixed round presets (not %-of-balance like before, which produced
      // ugly numbers depending on the player's exact balance) that deal
      // instantly on click, PLUS a genuinely independent custom-amount field
      // (its own "Здати" button, not folded into a shared button whose label
      // could look stale) so any amount the player types always works.
      const raw = Math.max(0, Math.floor(balance));
      const presets = [1, 5, 10].filter((n) => n <= raw);
      const doDeal = (amount) => {
        const stake = Math.max(1, Math.floor(Number(amount) || 0));
        if (stake > balance) return toast('Недостатньо KKoin для такої ставки', true);
        socket.emit('casino:blackjack_deal', { nickname, stake }, (res) => {
          if (res.error) return toast(res.error, true);
          view = res.view;
          refreshBalance(render);
        });
      };
      const dealCustom = () => {
        if (!customBet) return toast('Впиши суму ставки', true);
        doDeal(customBet);
      };
      const stakeInput = el('input', {
        type: 'number', min: '1', max: String(raw), placeholder: 'Своя сума', value: customBet, style: 'max-width:120px;',
        oninput: (e) => { customBet = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') dealCustom(); }
      });
      return el('div', { class: 'bj-bet-block' }, [
        raw < 1 ? el('p', { style: 'text-align:center; color:#C71585;' }, ['Недостатньо KKoin, щоб зробити ставку.']) : null,
        el('div', { class: 'bj-bet-row' }, [
          el('span', { class: 'bj-bet-label' }, ['Ставка:']),
          ...presets.map((p) => el('button', { class: 'btn-small btn-outline bj-bet-preset', onclick: () => doDeal(p) }, [String(p)])),
          stakeInput,
          el('button', { class: 'bj-deal-btn', style: 'padding:10px 20px; font-size:11px;', disabled: raw < 1 ? 'disabled' : null, onclick: dealCustom }, ['Здати'])
        ])
      ]);
    }

    if (view.phase === 'player') {
      return el('div', { class: 'bj-action-row' }, [
        el('button', { class: 'bj-action-btn bj-action-hit', onclick: () => {
          socket.emit('casino:blackjack_hit', { nickname }, (res) => {
            if (res.error) return toast(res.error, true);
            view = res.view;
            playSfx(res.view.phase !== 'player' ? 'impact' : 'move');
            if (res.view.phase === 'result') refreshBalance(render); else render();
          });
        }}, ['Ще карту']),
        el('button', { class: 'bj-action-btn bj-action-stand', onclick: () => {
          socket.emit('casino:blackjack_stand', { nickname }, (res) => {
            if (res.error) return toast(res.error, true);
            view = res.view;
            refreshBalance(render);
          });
        }}, ['Стоп'])
      ]);
    }

    if (view.phase === 'dealer') {
      return el('div', { class: 'bj-waiting-label' }, ['Дилер грає…']);
    }

    // result
    return el('div', { class: 'bj-newround-block' }, [
      el('button', { class: 'bj-deal-btn', onclick: () => { view = null; customBet = ''; render(); } }, ['\u{1F501} Нова гра']),
      balance < 1 ? el('p', { style: 'color:#C71585; margin-top:8px;' }, ['Недостатньо KKoin для нової ставки']) : null
    ]);
  }

  // ================= table mode =================
  function enterTableMode() {
    mode = 'table';
    tableState = null;
    render();
  }

  function doCreateTable() {
    socket.emit('casino:table_create', { nickname }, (res) => {
      if (res.error) return toast(res.error, true);
      tableCode = res.table.code;
      tableState = res.table;
      localStorage.setItem(TABLE_STORAGE_KEY, tableCode);
      render();
    });
  }

  function doJoinTable(code) {
    socket.emit('casino:table_join', { roomCode: code, nickname }, (res) => {
      if (res.error) return toast(res.error, true);
      tableCode = res.table.code;
      tableState = res.table;
      localStorage.setItem(TABLE_STORAGE_KEY, tableCode);
      render();
    });
  }

  function renderTableScreen() {
    if (!tableState) return renderTableJoinScreen();
    if (tableState.status === 'lobby') return renderTableLobby();
    return renderTablePlayOrResult();
  }

  function renderTableJoinScreen() {
    const codeInput = el('input', { type: 'text', placeholder: 'Код столу', maxlength: '8', style: 'text-transform:uppercase; letter-spacing:3px; font-weight:700;' });
    const panel = el('div', { class: 'ds-panel', style: 'max-width:440px; margin:18px auto 0;' }, [
      el('p', { style: 'color:var(--ds-text-dim); font-size:13px; line-height:1.6; margin-top:0;' }, [
        'Грайте Блекджек за одним столом із друзями (2-6 гравців) — спільна колода, один дилер на всіх, кожен ходить по черзі.'
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
      el('div', { class: 'ds-shell' }, [topBarNode(true), titleBlockNode('за столом'), panel])
    ]));
  }

  function mySeat() {
    if (!tableState) return null;
    return tableState.seats.find(s => s.nickname.trim().toLowerCase() === (nickname || '').trim().toLowerCase()) || null;
  }

  function renderTableLobby() {
    const seatRows = tableState.seats.map((s) => {
      const isMe = mySeat() === s;
      return el('div', { class: 'bjt-lobby-row' + (isMe ? ' me' : '') + (s.connected ? '' : ' offline') }, [
        avatarEl(s, 30),
        el('span', { class: 'bjt-lobby-row-name' }, [s.nickname + (isMe ? ' (ти)' : '') + (s.connected ? '' : ' · офлайн')]),
        el('span', { class: 'bjt-lobby-row-bet' + (s.pendingBet > 0 ? '' : ' none') }, [s.pendingBet > 0 ? ('\u{1FA99} ' + s.pendingBet) : 'без ставки']),
      ]);
    });

    const me = mySeat();
    const betInput = el('input', { type: 'number', min: '1', max: String(Math.max(0, Math.floor(balance))), placeholder: 'Ставка', value: tableBetDraft, style: 'max-width:110px;',
      oninput: (e) => { tableBetDraft = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') doPlaceBet(); }
    });
    function doPlaceBet() {
      const stake = Math.max(1, Math.floor(Number(tableBetDraft) || 0));
      if (stake > balance) return toast('Недостатньо KKoin для такої ставки', true);
      socket.emit('casino:table_bet', { stake }, (res) => { if (res && res.error) toast(res.error, true); else tableBetDraft = ''; });
    }
    function doClearBet() {
      socket.emit('casino:table_bet', { stake: 0 }, (res) => { if (res && res.error) toast(res.error, true); });
    }
    const bettingCount = tableState.seats.filter(s => s.pendingBet > 0).length;
    const canDeal = bettingCount >= 2;

    const panel = el('div', { class: 'ds-panel', style: 'max-width:520px; margin:18px auto 0;' }, [
      el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;' }, [
        el('div', { class: 'ds-panel-label', style: 'margin:0;' }, ['Стіл ', el('span', { class: 'room-code', style: 'font-size:16px; padding:2px 10px;' }, [tableState.code])]),
        el('button', { class: 'btn-small btn-outline crimson', style: 'padding:6px 12px; font-size:10px;', onclick: () => {
          socket.emit('casino:table_leave', {}, (res) => {
            if (res && res.error) return toast(res.error, true);
            localStorage.removeItem(TABLE_STORAGE_KEY);
            tableCode = null; tableState = null; mode = null;
            render();
          });
        } }, ['Вийти'])
      ]),
      el('p', { style: 'font-size:12px; color:var(--ds-text-dim);' }, ['Надішли цей код друзям, щоб вони приєдналися. Кожен ставить свою суму, потім будь-хто тисне «Здати карти».']),
      el('div', { class: 'bjt-lobby-players' }, seatRows),
      me ? el('div', { class: 'bjt-bet-row' }, [
        betInput,
        el('button', { class: 'btn-small', onclick: doPlaceBet }, [me.pendingBet > 0 ? 'Змінити ставку' : 'Поставити']),
        me.pendingBet > 0 ? el('button', { class: 'btn-small btn-outline', onclick: doClearBet }, ['Не грати цю роздачу']) : null
      ]) : null,
      el('div', { style: 'text-align:center; margin-top:18px;' }, [
        el('button', {
          class: 'bj-deal-btn', disabled: canDeal ? null : 'disabled',
          onclick: () => { socket.emit('casino:table_start', {}, (res) => { if (res && res.error) toast(res.error, true); }); }
        }, ['Здати карти' + (canDeal ? '' : ' (потрібно ≥2 ставки)')])
      ])
    ]);
    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBarNode(true), titleBlockNode('за столом · лобі'), panel])
    ]));
  }

  function renderTablePlayOrResult() {
    const isResult = tableState.status === 'result';
    const dealerCards = tableState.dealer.map((c, i) => cardNode(c, false, i, 'bj-card-sm'));
    if (tableState.dealerHasHiddenCard) dealerCards.push(cardNode(null, true, dealerCards.length, 'bj-card-sm'));
    const dealerColor = isResult ? '#00FFD1' : '#DAA520';
    const dealerBlock = el('div', { class: 'bj-side' }, [
      el('div', { class: 'bj-dealer' }, [
        el('div', { class: 'bj-dealer-ring', style: 'width:64px; height:64px; border-color:' + dealerColor + ';' }, [
          el('div', { class: 'bj-dealer-core', style: 'width:52px; height:52px; border-color:' + dealerColor + ';' }, [
            el('span', { class: 'bj-dealer-spade', style: 'font-size:22px; color:' + dealerColor + ';' }, ['♠'])
          ])
        ]),
        el('div', { class: 'bj-dealer-status' }, [
          el('span', { class: 'bj-dealer-dot', style: 'background:' + dealerColor + ';' }),
          el('span', { style: 'color:' + dealerColor + ';' }, ['Дилер' + (isResult ? '' : ' · грає стіл')])
        ])
      ]),
      el('div', { class: 'bj-cards-row', style: 'min-height:90px;' }, dealerCards),
      tableState.dealer.length ? el('div', { class: 'bj-hand-label' }, ['Дилер: ', el('span', { class: 'bj-hand-value' }, [tableState.dealerHasHiddenCard ? '?' : String(tableState.dealerValue)])]) : null
    ]);

    const turnSeat = tableState.status === 'playing' ? tableState.seats[tableState.turnIdx] : null;
    const seatNodes = tableState.seats.filter(s => s.inRound).map((s) => {
      const isMe = mySeat() === s;
      const isTurn = turnSeat === s;
      const cards = s.hand.map((c, i) => cardNode(c, false, i, 'bj-card-sm'));
      let statusText = '';
      let statusCls = '';
      if (s.result) {
        statusText = s.result === 'win' ? 'Перемога' : s.result === 'lose' ? 'Програш' : s.result === 'push' ? 'Нічия' : 'Перебір';
        statusCls = s.result;
      } else if (isTurn) statusText = 'Хід…';
      else if (s.done) statusText = 'Стоп';
      else statusText = 'Очікує';
      return el('div', { class: 'bjt-seat' + (isTurn ? ' active-turn' : '') + (isMe ? ' is-me' : '') + (s.connected ? '' : ' offline') }, [
        avatarEl(s, 34),
        el('div', { class: 'bjt-seat-name' }, [s.nickname + (isMe ? ' (ти)' : '')]),
        el('div', { class: 'bjt-seat-cards' }, cards),
        el('div', { class: 'bjt-seat-value' }, [s.hand.length ? String(s.handValue) : '']),
        el('div', { class: 'bjt-seat-bet' }, ['\u{1FA99} ' + s.pendingBet]),
        el('div', { class: 'bjt-seat-status' + (statusCls ? ' ' + statusCls : '') }, [statusText])
      ]);
    });

    const me = mySeat();
    const myTurn = !!(turnSeat && me && turnSeat === me);
    let controls;
    if (isResult) {
      controls = el('div', { class: 'bj-newround-block' }, [
        el('button', { class: 'bj-deal-btn', onclick: () => { socket.emit('casino:table_new_round', {}, (res) => { if (res && res.error) toast(res.error, true); refreshBalance(); }); } }, ['\u{1F501} Нова роздача'])
      ]);
    } else if (myTurn) {
      controls = el('div', { class: 'bj-action-row' }, [
        el('button', { class: 'bj-action-btn bj-action-hit', onclick: () => {
          socket.emit('casino:table_hit', {}, (res) => { if (res && res.error) toast(res.error, true); else playSfx('move'); });
        } }, ['Ще карту']),
        el('button', { class: 'bj-action-btn bj-action-stand', onclick: () => {
          socket.emit('casino:table_stand', {}, (res) => { if (res && res.error) toast(res.error, true); });
        } }, ['Стоп'])
      ]);
    } else {
      controls = el('div', { class: 'bj-waiting-label' }, [turnSeat ? ('Хід гравця: ' + turnSeat.nickname + '…') : 'Дилер грає…']);
    }

    const panel = [
      dealerBlock,
      el('div', { class: 'bjt-seats-row' }, seatNodes),
      el('div', { class: 'bj-controls' }, [controls])
    ];
    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBarNode(false), titleBlockNode('стіл · ' + tableState.code), ...panel])
    ]));

    // refresh the coin chip once a round pays out -- balance itself lives in
    // playersStore, not the table broadcast, so it needs its own fetch.
    if (isResult && !renderTablePlayOrResult._settledOnce) {
      renderTablePlayOrResult._settledOnce = true;
      refreshBalance(() => { const chip = app.querySelector('.bj-coin-value'); if (chip) chip.textContent = String(balance); });
    }
    if (!isResult) renderTablePlayOrResult._settledOnce = false;
  }

  socket.on('casino:table_state', (state) => {
    if (!tableCode || state.code !== tableCode) return;
    tableState = state;
    if (mode === 'table') render();
  });

  socket.on('connect', () => {
    if (mode === 'table' && tableCode) {
      socket.emit('casino:table_reconnect', { roomCode: tableCode, nickname }, (res) => {
        if (res && res.ok) { tableState = res.table; render(); }
      });
    }
  });

  requireAccount(app, { title: 'Блекджек', emoji: '♠️' }, (login) => {
    nickname = login;
    refreshBalance(() => {
      const storedTable = localStorage.getItem(TABLE_STORAGE_KEY);
      if (storedTable) {
        socket.emit('casino:table_reconnect', { roomCode: storedTable, nickname }, (res) => {
          if (res && res.ok) { mode = 'table'; tableCode = res.table.code; tableState = res.table; }
          else localStorage.removeItem(TABLE_STORAGE_KEY);
          render();
        });
      } else {
        render();
      }
    });
  });
})();
