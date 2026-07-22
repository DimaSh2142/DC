// Блекджек (Blackjack) client -- single player vs the house (the "dealer"),
// unlike battleship.js/checkers.js/chess.js which are 2-human-player mini-
// games. All rules/shuffle/dealer-play happen server-side (see
// src/games/blackjack.js + src/state/blackjackManager.js) -- this file only
// renders whatever the server's `view` says and never computes hand values
// or dealer behavior itself, same "server is truth" discipline as the rest
// of the app (and doubly important here since real KKoin is at stake).
//
// Visual design ported 1:1 from dima's base44 reference
// (src/pages/Blackjack.jsx + components/blackjack/{PlayingCard,DealerAvatar}.jsx
// in the "6a5fd3917e81c2e03dba4d9a (1).zip" export, 2026-07-22) -- exact
// colors/copy/layout, hand-translated from React+Tailwind+Framer Motion into
// this app's plain el()/CSS conventions. One deliberate deviation: the
// reference's fixed bet buttons (50/100/250 "монет") are replaced with
// presets computed from the player's REAL KKoin balance (this app's amounts
// are much smaller/more varied than the reference's placeholder economy),
// plus a custom-amount input.
(function () {
  const socket = io();
  const app = document.getElementById('app');

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
  let view = null; // latest server view, or null if no active hand
  let balance = 0;
  let customBet = '';

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

  function cardNode(card, hidden, delayIndex) {
    if (hidden) {
      return el('div', { class: 'bj-card bj-card-back', style: 'animation-delay:' + (delayIndex * 0.12) + 's;' }, [
        el('span', { class: 'bj-card-back-mark' }, ['DS'])
      ]);
    }
    const color = SUIT_COLOR[card.suit] || 'var(--hub-text, #E5E5E5)';
    return el('div', { class: 'bj-card', style: 'animation-delay:' + (delayIndex * 0.12) + 's;' }, [
      el('div', { class: 'bj-card-corner bj-card-corner-tl', style: 'color:' + color + ';' }, [card.rank, el('span', {}, [card.suit])]),
      el('div', { class: 'bj-card-corner bj-card-corner-br', style: 'color:' + color + ';' }, [card.rank, el('span', {}, [card.suit])]),
      el('div', { class: 'bj-card-center', style: 'color:' + color + ';' }, [card.suit])
    ]);
  }

  function render() {
    clear(app);
    const dState = computeDealerState();
    const dInfo = DEALER_STATUS[dState] || DEALER_STATUS.idle;

    const topBar = el('div', { class: 'bj-topbar' }, [
      el('a', { href: '/casino.html', class: 'back-link' }, ['← Казино']),
      el('div', { class: 'bj-coin-chip' }, [
        el('span', { class: 'bj-coin-icon' }, ['\u{1FA99}']),
        el('span', { class: 'bj-coin-value' }, [String(balance)]),
        el('span', { class: 'bj-coin-label' }, ['KKoin'])
      ])
    ]);

    const titleBlock = el('div', { class: 'bj-title-block' }, [
      el('div', { class: 'bj-eyebrow' }, ['/ Казино · 21']),
      el('h1', { class: 'bj-title' }, ['Блекджек'])
    ]);

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

    const controls = el('div', { class: 'bj-controls' }, [renderControls()]);

    app.appendChild(el('div', { class: 'ds-page bj-page' }, [
      el('div', { class: 'ds-shell' }, [topBar, titleBlock, table, controls])
    ]));
  }

  function renderControls() {
    if (!view) {
      // bet screen
      const raw = Math.max(0, Math.floor(balance));
      const presets = [Math.round(raw * 0.05), Math.round(raw * 0.1), Math.round(raw * 0.25)]
        .map((n) => Math.max(1, n))
        .filter((n, i, arr) => n <= raw && arr.indexOf(n) === i);
      const stakeInput = el('input', { type: 'number', min: '1', max: String(raw), placeholder: 'Своя сума', value: customBet, style: 'max-width:120px;', oninput: (e) => { customBet = e.target.value; } });
      const doDeal = (amount) => {
        const stake = Math.max(1, Math.floor(Number(amount) || 0));
        if (stake > balance) return toast('Недостатньо KKoin для такої ставки', true);
        socket.emit('casino:blackjack_deal', { nickname, stake }, (res) => {
          if (res.error) return toast(res.error, true);
          view = res.view;
          refreshBalance(render);
        });
      };
      return el('div', { class: 'bj-bet-block' }, [
        raw < 1 ? el('p', { style: 'text-align:center; color:#C71585;' }, ['Недостатньо KKoin, щоб зробити ставку.']) : null,
        el('div', { class: 'bj-bet-row' }, [
          el('span', { class: 'bj-bet-label' }, ['Ставка:']),
          ...presets.map((p) => el('button', { class: 'btn-small btn-outline bj-bet-preset', onclick: () => doDeal(p) }, [String(p)])),
          stakeInput
        ]),
        el('button', { class: 'bj-deal-btn', disabled: raw < 1 ? 'disabled' : null, onclick: () => doDeal(customBet || presets[0] || 1) }, ['Роздати · ' + (customBet || presets[0] || 1) + ' KKoin'])
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

  requireAccount(app, { title: 'Блекджек', emoji: '♠️' }, (login) => {
    nickname = login;
    refreshBalance(() => {
      socket.emit('casino:blackjack_state', { nickname }, (res) => {
        if (res && res.ok && res.view) view = res.view;
        render();
      });
    });
  });
})();
