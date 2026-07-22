// Plinko manager -- thin by design (the task's own framing: "simple
// request/response"). Unlike Blackjack/Roulette there is no table/room/seat
// concept at all here -- Plinko is solo, so this is just stake validation +
// KKoin deduct-then-pay, the same playersStore.addKkoin pattern every other
// casino game in this app uses, wrapped around the pure simulation in
// games/plinko.js. Kept as a small class (rather than free functions) only
// for consistency with BlackjackManager/BlackjackTableManager/
// RouletteTableManager's shape -- there's genuinely no per-instance state
// to hold, drop() would work identically as a module-level function.

const playersStore = require('./playersStore');
const plinko = require('../games/plinko');
let activityStore = null;
try { activityStore = require('./activityStore'); } catch (e) { /* optional, see blackjackTableManager.js's identical guard */ }

function logActivity(nickname, entry) {
  if (!activityStore) return;
  try { activityStore.logActivity(nickname, entry); } catch (e) { /* best-effort only */ }
}

class PlinkoManager {
  drop(nickname, stake) {
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    const stakeAmt = Math.max(1, Math.floor(Number(stake) || 0));
    const profile = playersStore.getOrCreatePlayer(nickname);
    if ((profile.kkoin || 0) < stakeAmt) {
      return { error: 'Недостатньо KKoin для такої ставки (у вас ' + (profile.kkoin || 0) + ')' };
    }
    playersStore.addKkoin(nickname, -stakeAmt);
    const { path, slotIndex } = plinko.simulatePath(plinko.ROWS);
    const multiplier = plinko.multiplierForSlot(slotIndex);
    const won = plinko.payout(stakeAmt, slotIndex);
    if (won > 0) playersStore.addKkoin(nickname, won);
    const net = won - stakeAmt;
    logActivity(nickname, {
      label: 'Казино · Plinko',
      detail: (net >= 0 ? 'Виграш +' : 'Програш ') + net + ' KKoin · ×' + multiplier,
      accent: multiplier >= 2 ? '#00FFD1' : (multiplier === 0 ? '#C71585' : '#DAA520'),
      win: net > 0
    });
    return {
      ok: true,
      path,
      slotIndex,
      multiplier,
      stake: stakeAmt,
      payout: won,
      net,
      balance: playersStore.getOrCreatePlayer(nickname).kkoin
    };
  }
}

module.exports = { PlinkoManager };
