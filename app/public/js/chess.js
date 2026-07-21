// Шахи (Chess) client. All rules (legality, check/checkmate/stalemate,
// castling, en passant, promotion) are enforced server-side via chess.js
// (see src/games/chess.js) -- the client never computes legality itself, it
// just filters gameState.legalMoves by the selected square, same pattern as
// checkers.js. playerIdx 0 is always White, playerIdx 1 always Black (fixed
// at room creation); Black's board is visually rotated 180 degrees so both
// players see their own back rank at the bottom of their own screen.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const GAME_TYPE = 'chess';
  const FILES = 'abcdefgh';
  const PIECE_GLYPHS = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
  };
  const PROMOTION_CHOICES = [['q', 'Ферзь ♛'], ['r', 'Тура ♜'], ['b', 'Слон ♝'], ['n', 'Кінь ♞']];

  let roomCode = null;
  let playerIdx = null;
  let roomState = null;
  let selected = null; // algebraic square string, e.g. 'e4', or null

  function squareName(col, row) { return FILES[col] + (8 - row); } // row/col are chess.js board() array indices
  // Black's client shows the board rotated 180 degrees -- own inverse, same
  // transform idea as checkers.js's flip().
  function flip(r, c) { return playerIdx === 1 ? [7 - r, 7 - c] : [r, c]; }

  function render() {
    clear(app);
    if (!roomState) return;
    if (roomState.status === 'waiting') return mgRenderWaitingForOpponent(app, roomCode);
    if (roomState.status === 'finished') return renderFinishedScreen();
    renderGame();
  }

  function doMove(from, to, promotion) {
    socket.emit('mg:chess_move', { from, to, promotion }, (res) => {
      if (res.error) { toast(res.error, true); return; }
      selected = null;
      render();
    });
  }

  function promptPromotion(cb) {
    openModal('Оберіть фігуру для перетворення пішака', [
      el('div', { class: 'row', style: 'justify-content:center; gap:10px; flex-wrap:wrap;' },
        PROMOTION_CHOICES.map(([code, label]) => el('button', { onclick: () => { closeModal(); cb(code); } }, [label])))
    ]);
  }

  function renderGame() {
    const gs = roomState.gameState; // { fen, board, turn, inCheck, winnerIdx, drawReason, lastMove, legalMoves }
    const myTurn = gs.turn === playerIdx && gs.winnerIdx === null && !gs.drawReason;
    const wrap = el('div', {}, []);
    wrap.appendChild(el('div', { class: 'row between' }, [
      el('h2', {}, ['♟️ Шахи']),
      el('span', { class: 'badge outline' }, ['Кімната ' + roomCode])
    ]));
    let statusText = myTurn ? 'Ваш хід!' : 'Хід суперника…';
    if (gs.inCheck && (gs.winnerIdx === null && !gs.drawReason)) statusText += ' Шах!';
    wrap.appendChild(mgResignBar(socket, statusText));

    const destsFromSelected = selected ? gs.legalMoves.filter(m => m.from === selected) : [];
    const destToSet = new Set(destsFromSelected.map(m => m.to));
    const selectableFromSet = new Set(gs.legalMoves.map(m => m.from));

    const grid = el('div', { class: 'chess-grid' }, []);
    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const [ar, ac] = flip(dr, dc);
        const sq = squareName(ac, ar);
        const cellPiece = gs.board[ar][ac]; // {square,type,color} | null
        const dark = (ar + ac) % 2 === 1; // a1 (row7,col0) -> odd -> dark, matches a real board
        const isSelected = selected === sq;
        const isDest = destToSet.has(sq);
        const isLastMove = !!(gs.lastMove && (gs.lastMove.from === sq || gs.lastMove.to === sq));
        let cls = 'chess-cell ' + (dark ? 'dark' : 'light');
        if (isSelected) cls += ' selected';
        else if (isDest) cls += ' selectable';
        else if (isLastMove) cls += ' last-move';

        const isMine = !!cellPiece && ((cellPiece.color === 'w' && playerIdx === 0) || (cellPiece.color === 'b' && playerIdx === 1));
        const isSelectableOrigin = myTurn && isMine && selectableFromSet.has(sq);
        const glyph = cellPiece ? PIECE_GLYPHS[cellPiece.color][cellPiece.type] : '';

        grid.appendChild(el('button', {
          class: cls,
          onclick: () => {
            if (isDest) {
              const matches = destsFromSelected.filter(m => m.to === sq);
              if (matches.length > 1) promptPromotion((piece) => doMove(selected, sq, piece));
              else doMove(selected, sq, matches[0].promotion || null);
            } else if (isSelectableOrigin) {
              selected = isSelected ? null : sq;
              render();
            } else {
              selected = null;
              render();
            }
          }
        }, [glyph]));
      }
    }
    wrap.appendChild(el('div', { style: 'display:flex; justify-content:center; margin-top:8px;' }, [grid]));
    wrap.appendChild(el('p', { style: 'text-align:center; font-size:12px; color:var(--turquoise-dark); margin-top:10px;' }, [
      (playerIdx === 0 ? '♔ ' : '♚ ') + 'Ви граєте ' + (playerIdx === 0 ? 'білими' : 'чорними')
    ]));
    app.appendChild(wrap);
  }

  function renderFinishedScreen() {
    const gs = roomState.gameState;
    const wrap = el('div', {}, [el('h2', { style: 'text-align:center;' }, ['♟️ Шахи'])]);
    wrap.appendChild(mgFinishedBanner(playerIdx, gs.winnerIdx, roomState.resignedIdx, gs.drawReason));
    app.appendChild(wrap);
  }

  function showJoinScreen() {
    mgRenderJoinScreen(socket, app, {
      gameType: GAME_TYPE, gameLabel: 'Шахи', emoji: '♟️',
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
