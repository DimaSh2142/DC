// Хрестики-нулики (Tic-Tac-Toe) client. 4th mini-game (2026-07-22), built
// to mirror checkers.js's structure closely (same mg:reconnect/join-screen/
// resign-bar/finished-banner wiring from minigame-common.js) -- all rules
// are enforced server-side (src/games/tictactoe.js) via the same
// miniGameManager room lifecycle checkers/chess/battleship already use, so
// this file only renders gameState.board and lets the player click among
// gameState.legalMoves, never computing legality itself. playerIdx 0 is
// always X, playerIdx 1 always O.
//
// 2026-07-22 visual refresh #2: dima sent a base44 reference zip (XOMark.jsx/
// WinLine.jsx) asking marks to look like that mockup. Swapped the old voxel
// PNG sprites (public/img/tictactoe/{x,o}.png) for inline SVG -- a glowing
// pink X, teal O, both matching minigame-common.js's mgAccentStyle idea of
// reusing minigames.html's established .ds-card--* hues -- plus a glowing
// strike-through line across the winning triple. Board/legal-move logic
// below is completely untouched, only the mark markup changed.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const GAME_TYPE = 'tictactoe';
  // Matches minigames.html's .ds-card--gold hue -- see minigame-common.js's
  // mgAccentStyle header comment for the full per-game color mapping.
  const ACCENT = '#DAA520';
  const MARK_LABEL = { 0: 'X', 1: 'O' };

  let roomCode = null;
  let playerIdx = null;
  let roomState = null;

  // Inline SVG marks (see el()'s `html` key in common.js -- innerHTML is the
  // only way to get real SVG nodes without createElementNS). Styling (stroke
  // color/glow/pop-in animation) lives entirely in style.css's .ttt-mark-svg
  // rules, keyed off the mark-x/mark-o class -- these two functions only emit
  // bare geometry.
  function markSvg(mark) {
    if (mark === 0) {
      return el('div', { class: 'ttt-mark-svg mark-x', html:
        '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
          '<line x1="20" y1="20" x2="80" y2="80" stroke-width="10" stroke-linecap="round"/>' +
          '<line x1="80" y1="20" x2="20" y2="80" stroke-width="10" stroke-linecap="round"/>' +
        '</svg>' });
    }
    return el('div', { class: 'ttt-mark-svg mark-o', html:
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
        '<circle cx="50" cy="50" r="32" fill="none" stroke-width="10"/>' +
      '</svg>' });
  }

  // Straight line through the 3 winning cells' centers, extended a bit past
  // each end (matches the reference's WinLine.jsx). Coordinate math assumes
  // the desktop 100px-cell/10px-gap grid (see .ttt-grid in style.css); the
  // SVG's own viewBox scaling handles the mobile 84px breakpoint closely
  // enough for a decorative glow line -- not worth measuring real DOM rects
  // for this.
  function winLineSvg(winningLine) {
    if (!winningLine || winningLine.length !== 3) return null;
    const sorted = winningLine.slice().sort((a, b) => a - b);
    const centerOf = (i) => ({ x: (i % 3) * 110 + 50, y: Math.floor(i / 3) * 110 + 50 });
    const p1 = centerOf(sorted[0]), p2 = centerOf(sorted[2]);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, ext = 26;
    const x1 = (p1.x - ux * ext).toFixed(1), y1 = (p1.y - uy * ext).toFixed(1);
    const x2 = (p2.x + ux * ext).toFixed(1), y2 = (p2.y + uy * ext).toFixed(1);
    return el('div', { class: 'ttt-winline-svg', html:
      '<svg viewBox="0 0 320 320" width="100%" height="100%"><line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/></svg>' });
  }

  function render() {
    clear(app);
    if (!roomState) return;
    if (roomState.status === 'waiting') return mgRenderWaitingForOpponent(app, roomCode, { stake: roomState.stake, accent: ACCENT });
    if (roomState.status === 'finished') return renderFinishedScreen();
    renderGame();
  }

  function renderGame() {
    const gs = roomState.gameState; // { board, turn, winnerIdx, drawReason, winningLine, legalMoves }
    const myTurn = gs.turn === playerIdx && gs.winnerIdx === null && !gs.drawReason;
    const wrap = el('div', {}, []);
    wrap.appendChild(el('div', { class: 'row between' }, [
      el('h2', {}, ['❌⭕ Хрестики-нулики']),
      el('span', { class: 'badge outline' }, ['Кімната ' + roomCode])
    ]));
    wrap.appendChild(mgResignBar(socket, myTurn ? 'Ваш хід! (' + MARK_LABEL[playerIdx] + ')' : 'Хід суперника…', roomState.stake));

    const legalSet = new Set(gs.legalMoves.map(m => m.index));
    const winSet = new Set(gs.winningLine || []);

    const grid = el('div', { class: 'ttt-grid' }, []);
    for (let i = 0; i < 9; i++) {
      const mark = gs.board[i]; // null | 0 | 1
      const isSelectable = myTurn && legalSet.has(i);
      let cls = 'ttt-cell';
      if (isSelectable) cls += ' selectable';
      if (winSet.has(i)) cls += ' win-line';
      const children = mark !== null ? [markSvg(mark)] : [];
      grid.appendChild(el('button', {
        class: cls,
        disabled: isSelectable ? null : 'disabled',
        onclick: () => {
          if (!isSelectable) return;
          socket.emit('mg:tictactoe_move', { index: i }, (res) => {
            if (res.error) { toast(res.error, true); return; }
            playSfx('move');
            render();
          });
        }
      }, children));
    }
    const winLine = winLineSvg(gs.winningLine);
    if (winLine) grid.appendChild(winLine);
    wrap.appendChild(el('div', { style: 'display:flex; justify-content:center; margin-top:8px;' }, [grid]));
    wrap.appendChild(el('p', { style: 'text-align:center; font-size:12px; color:var(--turquoise-dark); margin-top:10px;' },
      [MARK_LABEL[playerIdx] + ' ' + (roomState.players[playerIdx] || {}).nickname + ' (ви) — ' + MARK_LABEL[1 - playerIdx] + ' ' + (roomState.players[1 - playerIdx] || {}).nickname]));
    app.appendChild(wrap);
  }

  function renderFinishedScreen() {
    const gs = roomState.gameState;
    const wrap = el('div', {}, [el('h2', { style: 'text-align:center;' }, ['❌⭕ Хрестики-нулики'])]);
    if (gs.winnerIdx !== null) playSfx(gs.winnerIdx === playerIdx ? 'impact' : 'wrong');
    wrap.appendChild(mgFinishedBanner(playerIdx, gs.winnerIdx, roomState.resignedIdx, gs.drawReason, () => {
      socket.emit('mg:rematch', { gameType: GAME_TYPE, roomCode }, (res) => { if (res && res.error) { toast(res.error, true); render(); } });
    }, roomState.stake));
    app.appendChild(wrap);
  }

  function showJoinScreen() {
    mgRenderJoinScreen(socket, app, {
      gameType: GAME_TYPE, gameLabel: 'Хрестики-нулики', emoji: '❌⭕', accent: ACCENT, vsAI: true,
      tagline: 'Класична гра на 2 гравці — або проти ШІ',
      onJoined: ({ roomCode: rc, playerIdx: pi, room }) => { roomCode = rc; playerIdx = pi; roomState = room; render(); }
    });
  }

  mgTryReconnect(socket, GAME_TYPE, (ok, res) => {
    if (ok) { roomCode = res.room.code; playerIdx = res.playerIdx; roomState = res.room; render(); }
    else showJoinScreen();
  });

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
