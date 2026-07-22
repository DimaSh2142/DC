// Хрестики-нулики (Tic-Tac-Toe) client. 4th mini-game (2026-07-22), built
// to mirror checkers.js's structure closely (same mg:reconnect/join-screen/
// resign-bar/finished-banner wiring from minigame-common.js) -- all rules
// are enforced server-side (src/games/tictactoe.js) via the same
// miniGameManager room lifecycle checkers/chess/battleship already use, so
// this file only renders gameState.board and lets the player click among
// gameState.legalMoves, never computing legality itself. playerIdx 0 is
// always X, playerIdx 1 always O. Marks are voxel-rendered tile sprites
// (public/img/tictactoe/{x,o}.png, see app/scripts/renderVoxToPng.py) --
// same texture-pass idea as checkers.js's own 2026-07-22 piece swap.
(function () {
  const socket = io();
  const app = document.getElementById('app');
  const GAME_TYPE = 'tictactoe';
  const MARK_IMG = { 0: '/img/tictactoe/x.png', 1: '/img/tictactoe/o.png' };
  const MARK_LABEL = { 0: 'X', 1: 'O' };

  let roomCode = null;
  let playerIdx = null;
  let roomState = null;

  function render() {
    clear(app);
    if (!roomState) return;
    if (roomState.status === 'waiting') return mgRenderWaitingForOpponent(app, roomCode, { stake: roomState.stake });
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
      const children = mark !== null ? [el('img', { src: MARK_IMG[mark], alt: MARK_LABEL[mark], class: 'ttt-mark-img' })] : [];
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
      gameType: GAME_TYPE, gameLabel: 'Хрестики-нулики', emoji: '❌⭕',
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
