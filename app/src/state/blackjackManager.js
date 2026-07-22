// Blackjack table manager -- one active hand per nickname, the same
// nickname-is-identity model as everywhere else in this app (see
// playersStore.js). Deliberately NOT built on MiniGameManager: that class's
// whole design (players[0]/players[1], a shared room two humans join) is for
// 2-player-vs-each-other games. Blackjack is 1-player-vs-the-house, so there
// is no "room" to create/join at all -- just a per-nickname hand, and the
// house's play (src/games/blackjack.js's resolveStand) is entirely
// server-side so nobody can peek at or influence the dealer's hidden card
// or the shuffle.
//
// Real KKoin is at stake here (unlike the reference design's fake local
// balance=1000 useState) -- the stake is deducted the instant a hand is
// dealt (deal()) and paid out the instant it resolves (settle(), guarded by
// state.settled the same way miniGameManager.js guards room.stakeSettled,
// so a duplicate call -- e.g. hit() landing on 21 and auto-resolving, then
// some other path also trying to settle -- can never double-pay).

const playersStore = require('./playersStore');
const blackjack = require('../games/blackjack');
// Optional-require + try/catch guard, same pattern as blackjackTableManager.js
// /rouletteTableManager.js/plinkoManager.js -- 2026-07-22 cabinet rebuild
// wiring real data into ActivityFeed/ActivityChart for solo Blackjack too.
let activityStore = null;
try { activityStore = require('./activityStore'); } catch (e) { /* optional, see logActivity() below */ }
function logActivity(nickname, entry) {
  if (!activityStore) return;
  try { activityStore.logActivity(nickname, entry); } catch (e) { /* best-effort only */ }
}

class BlackjackManager {
  constructor() {
    this.hands = new Map(); // nicknameKey -> { nickname, state }
  }

  deal(nickname, stake) {
    const key = playersStore.keyOf(nickname);
    if (!key) return { error: 'Порожній нікнейм' };
    const stakeAmt = Math.max(1, Math.floor(Number(stake) || 0));
    const profile = playersStore.getOrCreatePlayer(nickname);
    if ((profile.kkoin || 0) < stakeAmt) {
      return { error: 'Недостатньо KKoin для такої ставки (у вас ' + (profile.kkoin || 0) + ')' };
    }
    const existing = this.hands.get(key);
    if (existing && (existing.state.phase === 'player' || existing.state.phase === 'dealer')) {
      return { error: 'У вас вже є незавершена рука -- спершу заверши її' };
    }
    playersStore.addKkoin(nickname, -stakeAmt);
    const state = blackjack.dealInitial(stakeAmt);
    this.hands.set(key, { nickname: String(nickname).trim(), state });
    return { ok: true, view: blackjack.getPublicView(state) };
  }

  hit(nickname) {
    const key = playersStore.keyOf(nickname);
    const entry = key && this.hands.get(key);
    if (!entry) return { error: 'Немає активної руки -- спершу зроби ставку' };
    const res = blackjack.hit(entry.state);
    if (res.error) return res;
    if (entry.state.phase === 'result') this.settle(entry);
    return { ok: true, view: blackjack.getPublicView(entry.state) };
  }

  stand(nickname) {
    const key = playersStore.keyOf(nickname);
    const entry = key && this.hands.get(key);
    if (!entry) return { error: 'Немає активної руки -- спершу зроби ставку' };
    const res = blackjack.stand(entry.state);
    if (res.error) return res;
    this.settle(entry);
    return { ok: true, view: blackjack.getPublicView(entry.state) };
  }

  settle(entry) {
    if (entry.state.settled) return;
    entry.state.settled = true;
    const mult = blackjack.payoutMultiplier(entry.state.result);
    if (mult > 0) playersStore.addKkoin(entry.nickname, entry.state.stake * mult);
    // Same "win only true on mult>1" convention as blackjackTableManager.js's
    // identical logActivity call for the multiplayer table variant.
    const netLine = mult === 0 ? ('-' + entry.state.stake) : (mult === 1 ? '+0 (push)' : ('+' + entry.state.stake * (mult - 1)));
    logActivity(entry.nickname, {
      label: 'Казино · Блекджек',
      detail: (entry.state.result === 'win' ? 'Виграш' : entry.state.result === 'push' ? 'Нічия' : entry.state.result === 'bust' ? 'Перебір' : 'Програш') + ' · ' + netLine + ' KKoin',
      accent: mult > 1 ? '#00FFD1' : (mult === 1 ? '#666666' : '#C71585'),
      win: mult > 1
    });
  }

  currentView(nickname) {
    const key = playersStore.keyOf(nickname);
    const entry = key && this.hands.get(key);
    return entry ? blackjack.getPublicView(entry.state) : null;
  }
}

module.exports = { BlackjackManager };
