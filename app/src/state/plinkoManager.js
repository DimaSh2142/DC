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

// dima 2026-07-22 "додай можливість запускати одночасно 1, 5, 10 та 25
// куль" -- a fixed allow-list (not any 1-25 count) matching the exact 4
// buttons the client shows, same "explicit presets, not a free-for-all
// number field" spirit as the KKoin stake presets already use.
const ALLOWED_BALL_COUNTS = [1, 5, 10, 25];

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

  // Drops `count` balls (each an independent, fully-server-decided
  // simulatePath()) at the same per-ball stake, in one round trip. Just a
  // thin loop around the already-tested drop() above -- reused as-is
  // rather than duplicating its validate/deduct/simulate/pay logic, so
  // every individual ball goes through the exact same code path (and gets
  // the exact same activity-log entry) as an ordinary single drop.
  //
  // The upfront stake*count affordability check exists purely so a request
  // that can never fully succeed fails with ONE clear error up front,
  // instead of silently succeeding for the first few balls and then erroring
  // out mid-sequence on ball N. It's provably sufficient on its own (not
  // just a nicer error message): each ball's payout is >= 0, so the
  // player's balance after i balls is always >= starting_balance - i*stake,
  // meaning if starting_balance >= count*stake, every individual drop()
  // call below is guaranteed to still pass ITS OWN affordability check too.
  dropMany(nickname, stake, count) {
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    const stakeAmt = Math.max(1, Math.floor(Number(stake) || 0));
    const n = Math.floor(Number(count) || 0);
    if (!ALLOWED_BALL_COUNTS.includes(n)) return { error: 'Кількість куль має бути 1, 5, 10 або 25' };
    const profile = playersStore.getOrCreatePlayer(nickname);
    const totalCost = stakeAmt * n;
    if ((profile.kkoin || 0) < totalCost) {
      return { error: 'Недостатньо KKoin для ' + n + ' куль по ' + stakeAmt + ' (потрібно ' + totalCost + ', у вас ' + (profile.kkoin || 0) + ')' };
    }
    const results = [];
    for (let i = 0; i < n; i++) {
      const res = this.drop(nickname, stakeAmt);
      // Shouldn't happen given the upfront check above, but never silently
      // swallow a failure mid-batch -- surface it and stop immediately.
      if (res.error) return { error: res.error, results };
      results.push(res);
    }
    const totalStake = results.reduce((sum, r) => sum + r.stake, 0);
    const totalPayout = results.reduce((sum, r) => sum + r.payout, 0);
    return {
      ok: true,
      results,
      count: n,
      stake: stakeAmt,
      totalStake,
      totalPayout,
      totalNet: totalPayout - totalStake,
      balance: results[results.length - 1].balance
    };
  }
}

module.exports = { PlinkoManager };
