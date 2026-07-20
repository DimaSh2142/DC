// Pure, dependency-free team balancing. Snake-draft players across teams by
// accuracy so strong players are spread out rather than stacked.

/**
 * Laplace-smoothed accuracy so brand-new players (0/0) sit at a neutral 0.5
 * instead of 0, and a single early answer doesn't swing them to 0 or 1.
 */
function accuracyOf(player) {
  const correct = player.correct || 0;
  const incorrect = player.incorrect || 0;
  return (correct + 1) / (correct + incorrect + 2);
}

/**
 * Deterministic-ish tiebreak so repeated calls with identical stats produce
 * stable team assignments (sorted by name) rather than reshuffling randomly.
 */
function sortByAccuracyDesc(players) {
  return [...players].sort((a, b) => {
    const diff = accuracyOf(b) - accuracyOf(a);
    if (Math.abs(diff) > 1e-9) return diff;
    return String(a.nickname).localeCompare(String(b.nickname));
  });
}

/**
 * Snake / boustrophedon draft: strongest player goes to team 0, next to
 * team 1, ... last team, then reverses direction back to team 0, etc.
 * This spreads strong and weak players evenly instead of stacking the top
 * N players onto the first N/teams slots.
 *
 * @param {Array<{nickname:string, correct:number, incorrect:number}>} players
 * @param {number} numTeams
 * @returns {Array<Array<object>>} array of numTeams arrays of player objects
 */
function snakeAssignTeams(players, numTeams) {
  const k = Math.max(1, Math.min(numTeams, players.length || 1));
  const teams = Array.from({ length: k }, () => []);
  const sorted = sortByAccuracyDesc(players);

  let teamIndex = 0;
  let direction = 1;
  for (const player of sorted) {
    teams[teamIndex].push(player);
    if (k > 1) {
      const next = teamIndex + direction;
      if (next < 0 || next >= k) {
        direction *= -1;
        // stay on same team index for this "bounce" step (classic snake
        // draft: the same slot picks twice at the turn of the row)
      } else {
        teamIndex = next;
      }
    }
  }
  return teams;
}

module.exports = { accuracyOf, sortByAccuracyDesc, snakeAssignTeams };
