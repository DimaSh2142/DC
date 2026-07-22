// Шашки (Checkers) client. All rules (mandatory capture, multi-jump
// chaining, king promotion) are enforced server-side (see
// src/games/checkers.js) -- the client never computes legality itself, it
// just renders whatever mg:room_state.gameState.legalMoves says is
// currently legal and lets the player click among those. Board is visually
// flipped for playerIdx 1 so BOTH players always see their own pieces at
// the bottom of the screen, matching how a real physical board would sit
// between two people.
//
// Piece rendering (2026-07-22 texture pass): the pieces are rendered from
// dima's "boardgames-vox" MagicaVoxel pack (Pieces/Man/man-v2-{white,red}.vox)
// instead of a flat CSS background color -- see app/scripts/renderVoxToPng.py
// for the top-down voxel->PNG renderer that produced
// public/img/checkers/man-{white,red}.png (these are simple flat-colored
// rounded tokens in the source pack, no engraved surface detail, so this is
// real texture-sourced art with the pack's own palette colors, just not a
// dramatic visual upgrade beyond that). The .checkers-piece div keeps its
// existing circular border/box-shadow frame and border-radius+overflow
// clip (see style.css) -- same "<img> tag the same way as chess.js's Phase 5
// swap" approach, with the king crown now an overlay span instead of the
// only content.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const GAME_TYPE = 'checkers';
  const PIECE_IMG = { 0: '/img/checkers/man-white.png', 1: '/img/checkers/man-red.png' };
  // Matches minigames.html's .ds-card--crimson hue -- see minigame-common.js's
  // mgAccentStyle header comment for the full per-game color mapping.
  const ACCENT = '#D7263D';

  let roomCode = null;
  let playerIdx = null;
  let roomState = null;
  let selected = null; // [r,c] in ACTUAL (server) board coordinates, or null

  // playerIdx 1 sees the board rotated 180 degrees -- this transform is its
  // own inverse, so the same function converts display<->actual coords.
  function flip(r, c) { return playerIdx === 1 ? [7 - r, 7 - c] : [r, c]; }

  function render() {
    clear(app);
    if (!roomState) return;
    if (roomState.status === 'waiting') return mgRenderWaitingForOpponent(app, roomCode, { stake: roomState.stake, accent: ACCENT });
    if (roomState.status === 'finished') return renderFinishedScreen();
    renderGame();
  }

  function renderGame() {
    const gs = roomState.gameState; // { board, turn, winnerIdx, mustContinueFrom, legalMoves }
    const myTurn = gs.turn === playerIdx && gs.winnerIdx === null;
    const wrap = el('div', {}, []);
    wrap.appendChild(el('div', { class: 'row between' }, [
      el('h2', {}, ['🔴 Шашки']),
      el('span', { class: 'badge outline' }, ['Кімната ' + roomCode])
    ]));
    wrap.appendChild(mgResignBar(socket, myTurn ? 'Ваш хід!' + (gs.mustContinueFrom ? ' (обовʼязкове продовження взяття)' : '') : 'Хід суперника…', roomState.stake));

    const selectableFromSet = new Set(gs.legalMoves.map(m => m.from.join(',')));
    const destsFromSelected = selected ? gs.legalMoves.filter(m => m.from[0] === selected[0] && m.from[1] === selected[1]) : [];
    const destSet = new Set(destsFromSelected.map(m => m.to.join(',')));

    const grid = el('div', { class: 'checkers-grid' }, []);
    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const [ar, ac] = flip(dr, dc);
        const dark = (ar + ac) % 2 === 1;
        const piece = gs.board[ar][ac];
        const key = ar + ',' + ac;
        const isSelected = !!(selected && selected[0] === ar && selected[1] === ac);
        const isDest = !!(selected && destSet.has(key));
        const isSelectable = myTurn && !!piece && piece.owner === playerIdx && selectableFromSet.has(key);
        let cls = 'checkers-cell ' + (dark ? 'dark' : 'light');
        if (isSelected) cls += ' selected';
        else if (isDest) cls += ' selectable';

        const children = piece ? [el('div', { class: 'checkers-piece p' + piece.owner }, [
          el('img', { src: PIECE_IMG[piece.owner], alt: '', class: 'checkers-piece-img' }),
          piece.king ? el('span', { class: 'checkers-king-badge' }, ['♛']) : null
        ])] : [];
        grid.appendChild(el('button', {
          class: cls,
          onclick: (e) => {
            if (isDest) {
              // captured synchronously (while the clicked button is still a
              // real attached node) since render() below rebuilds the whole
              // grid from scratch -- e.currentTarget itself won't exist
              // anymore by the time the socket response comes back, but the
              // on-screen position it was at is still exactly where the
              // piece landed, so a plain rect works fine as playEffect's anchor.
              const clickRect = e.currentTarget.getBoundingClientRect();
              socket.emit('mg:checkers_move', { from: selected, to: [ar, ac] }, (res) => {
                if (res.error) { toast(res.error, true); return; }
                playSfx(res.captured ? 'impact' : 'move');
                selected = res.continueJump ? [ar, ac] : null;
                render();
                if (res.captured && typeof playEffect === 'function') playEffect('impact', clickRect);
              });
            } else if (isSelectable) {
              selected = isSelected ? null : [ar, ac];
              render();
            } else if (!gs.mustContinueFrom) {
              // clicking any other square deselects -- but never while a
              // multi-jump continuation is mandatory (selected must stay
              // locked to the jumping piece until the chain is resolved).
              selected = null;
              render();
            }
          }
        }, children));
      }
    }
    wrap.appendChild(el('div', { style: 'display:flex; justify-content:center; margin-top:8px;' }, [grid]));
    wrap.appendChild(el('p', { style: 'text-align:center; font-size:12px; color:var(--turquoise-dark); margin-top:10px;' },
      ['⚪ ' + (roomState.players[playerIdx] || {}).nickname + ' (ви) — 🔴 ' + (roomState.players[1 - playerIdx] || {}).nickname]));
    app.appendChild(wrap);
  }

  function renderFinishedScreen() {
    const wrap = el('div', {}, [el('h2', { style: 'text-align:center;' }, ['🔴 Шашки'])]);
    wrap.appendChild(mgFinishedBanner(playerIdx, roomState.gameState.winnerIdx, roomState.resignedIdx, null, () => {
      socket.emit('mg:rematch', { gameType: GAME_TYPE, roomCode }, (res) => { if (res && res.error) { toast(res.error, true); render(); } });
    }, roomState.stake));
    app.appendChild(wrap);
  }

  function showJoinScreen() {
    mgRenderJoinScreen(socket, app, {
      gameType: GAME_TYPE, gameLabel: 'Шашки', emoji: '🔴', accent: ACCENT,
      tagline: 'Класична гра на 2 гравці',
      onJoined: ({ roomCode: rc, playerIdx: pi, room }) => { roomCode = rc; playerIdx = pi; roomState = room; selected = null; render(); }
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
