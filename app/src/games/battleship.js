// Морський бій (Battleship) -- pure game-logic module, no sockets/rooms here
// (see src/state/miniGameManager.js for the room plumbing that calls into
// this). Standard classic rules: 10x10 grid, 5 ships (sizes 5/4/3/3/2), each
// player privately places their fleet, then players alternate firing one
// shot per turn regardless of hit/miss (the official Milton Bradley/Hasbro
// rule -- some house variants give an extra shot on a hit, deliberately NOT
// used here so "standard rules" means the same thing to everyone).

const GRID_SIZE = 10;
const SHIP_SIZES = [5, 4, 3, 3, 2]; // Carrier, Battleship, Cruiser, Submarine, Destroyer

function inBounds(x, y) { return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE; }

function shipCellsFor(x, y, size, dir) {
  const cells = [];
  for (let i = 0; i < size; i++) cells.push(dir === 'H' ? [x + i, y] : [x, y + i]);
  return cells;
}

function emptyBoard() {
  return {
    ships: [],       // [{ cells:[[x,y],...], size, hits }] -- set once the player submits a layout
    shotsAgainst: []  // [{x,y,hit}] shots the OPPONENT has fired at this board
  };
}

function createInitialState() {
  return {
    phase: 'placing', // 'placing' -> 'battle' -> 'finished'
    boards: [emptyBoard(), emptyBoard()],
    ready: [false, false],
    turn: 0, // playerIdx to move once phase==='battle' -- room creator fires first
    winnerIdx: null
  };
}

// placements: [{x,y,dir:'H'|'V',size}] -- must be exactly one of each SHIP_SIZES,
// in-bounds, and non-overlapping (official rules allow ships touching edge-to-edge).
function validateLayout(placements) {
  if (!Array.isArray(placements) || placements.length !== SHIP_SIZES.length) {
    return { error: 'Потрібно розмістити рівно 5 кораблів' };
  }
  const gotSizes = placements.map(p => p.size).slice().sort((a, b) => b - a);
  const wantSizes = SHIP_SIZES.slice().sort((a, b) => b - a);
  if (JSON.stringify(gotSizes) !== JSON.stringify(wantSizes)) {
    return { error: 'Невірний набір кораблів (потрібні розміри 5,4,3,3,2)' };
  }
  const occupied = new Set();
  const allCells = [];
  for (const p of placements) {
    if (p.dir !== 'H' && p.dir !== 'V') return { error: 'Невірний напрямок корабля' };
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) return { error: 'Невірні координати' };
    const cells = shipCellsFor(p.x, p.y, p.size, p.dir);
    for (const [cx, cy] of cells) {
      if (!inBounds(cx, cy)) return { error: 'Корабель виходить за межі поля' };
      const key = cx + ',' + cy;
      if (occupied.has(key)) return { error: 'Кораблі не можуть перетинатись' };
      occupied.add(key);
    }
    allCells.push(cells);
  }
  return { ok: true, allCells };
}

function submitLayout(state, playerIdx, placements) {
  if (state.phase !== 'placing') return { error: 'Розміщення кораблів вже завершено' };
  if (state.ready[playerIdx]) return { error: 'Ви вже розмістили кораблі' };
  const v = validateLayout(placements);
  if (v.error) return { error: v.error };
  state.boards[playerIdx].ships = v.allCells.map(cells => ({ cells, size: cells.length, hits: 0 }));
  state.ready[playerIdx] = true;
  if (state.ready[0] && state.ready[1]) state.phase = 'battle';
  return { ok: true, bothReady: state.phase === 'battle' };
}

function fireShot(state, playerIdx, x, y) {
  if (state.phase !== 'battle') return { error: 'Бій ще не почався -- очікуємо розміщення кораблів' };
  if (state.turn !== playerIdx) return { error: 'Зараз не ваш хід' };
  if (!inBounds(x, y)) return { error: 'Постріл за межі поля' };
  const targetBoard = state.boards[1 - playerIdx];
  if (targetBoard.shotsAgainst.some(s => s.x === x && s.y === y)) return { error: 'Ви вже стріляли в цю клітину' };

  let hit = false;
  let sunkSize = null;
  for (const ship of targetBoard.ships) {
    if (ship.cells.some(([cx, cy]) => cx === x && cy === y)) {
      hit = true;
      ship.hits += 1;
      if (ship.hits === ship.size) sunkSize = ship.size;
      break;
    }
  }
  targetBoard.shotsAgainst.push({ x, y, hit });

  const allSunk = targetBoard.ships.length > 0 && targetBoard.ships.every(s => s.hits === s.size);
  if (allSunk) {
    state.phase = 'finished';
    state.winnerIdx = playerIdx;
  } else {
    state.turn = 1 - playerIdx; // strict alternation, hit or miss -- see header comment
  }
  return { ok: true, hit, sunk: sunkSize, gameOver: allSunk, winnerIdx: state.winnerIdx };
}

// Per-viewer redaction: NEVER reveal the opponent's unsunk ship cells. Only
// once a ship is fully sunk does its full outline become visible (matches
// familiar Battleship UX of a revealed sunk-ship silhouette).
function getPublicView(state, viewerIdx) {
  const oppIdx = 1 - viewerIdx;
  const myBoard = state.boards[viewerIdx];
  const oppBoard = state.boards[oppIdx];
  return {
    phase: state.phase,
    ready: state.ready.slice(),
    turn: state.turn,
    winnerIdx: state.winnerIdx,
    myShips: myBoard.ships.map(s => ({ cells: s.cells, size: s.size, hits: s.hits, sunk: s.hits === s.size })),
    shotsOnMe: myBoard.shotsAgainst,
    shotsIFired: oppBoard.shotsAgainst,
    opponentSunkShips: oppBoard.ships.filter(s => s.hits === s.size).map(s => ({ cells: s.cells, size: s.size }))
  };
}

module.exports = { GRID_SIZE, SHIP_SIZES, createInitialState, validateLayout, submitLayout, fireShot, getPublicView };
