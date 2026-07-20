// One-off content build script: merges hand-authored themes with
// procedurally-generated "correct logo" themes into data/themesBank.json.
// Run manually with `node scripts/buildThemeBank.js` whenever the bank
// needs to be regenerated/extended -- NOT required for normal app startup
// (the bank is a static data file the server reads).

const fs = require('fs');
const path = require('path');
const { generateLogoChallenge } = require('../src/logo/logoGenerator');
const part1 = require('../data/handAuthoredThemes.part1.js');
const part2 = require('../data/handAuthoredThemes.part2.js');
const part3 = require('../data/handAuthoredThemes.part3.js');
const part4 = require('../data/handAuthoredThemes.part4.js');

const LOGO_THEME_DEFS = [
  { id: 'logo-1', name: 'Правильний логотип' },
  { id: 'logo-2', name: 'Знайди оригінал' },
  { id: 'logo-3', name: 'Один із чотирьох' },
  { id: 'logo-4', name: 'Бренд без підробки' },
  { id: 'logo-5', name: 'Справжній чи підробка' },
  { id: 'logo-6', name: 'Логотип без обману' }
];
const PRICES = [100, 200, 300, 400, 500];

function buildLogoThemes() {
  return LOGO_THEME_DEFS.map(def => {
    const questions = PRICES.map((price, idx) => {
      const difficulty = idx + 1; // 1..5, matches price ladder easy->hard
      const seed = def.id + '-q' + idx;
      const challenge = generateLogoChallenge(seed, difficulty);
      return {
        price,
        type: 'select',
        clue: {
          kind: 'logo',
          text: 'Три з цих чотирьох логотипів — підробки з дрібними відмінностями. Який справжній?',
          options: challenge.options
        },
        correctOptionId: challenge.correctOptionId,
        display: 'Бренд "' + challenge.brand + '"'
      };
    });
    return { id: def.id, name: def.name, category: 'logo', questions };
  });
}

function main() {
  const allHandAuthored = [
    ...part1.movieVibeThemes,
    ...part1.gameVibeThemes,
    ...part1.unusualGamesThemes,
    ...part2.emojiMovieThemes,
    ...part2.languageThemes,
    ...part2.geographyThemes,
    ...part2.animeRoomThemes,
    ...part2.musicThemes,
    ...part2.marketplaceThemes,
    ...part2.memeThemes,
    ...part3.movieVibeThemes2,
    ...part3.gameVibeThemes2,
    ...part3.emojiMovieThemes2,
    ...part3.languageThemes2,
    ...part3.geographyThemes2,
    ...part3.musicThemes2,
    ...part3.marketplaceThemes2,
    ...part3.memeThemes2,
    ...part3.unusualGamesThemes2,
    ...part3.animeRoomThemes2,
    ...part4.movieVibeThemes3,
    ...part4.gameVibeThemes3,
    ...part4.unusualGamesThemes3,
    ...part4.emojiMovieThemes3,
    ...part4.languageThemes3,
    ...part4.geographyThemes3,
    ...part4.animeRoomThemes3,
    ...part4.musicThemes3,
    ...part4.marketplaceThemes3,
    ...part4.memeThemes3,
    ...part4.sportVibeThemes,
    ...part4.historyVibeThemes,
    ...part4.cartoonVibeThemes,
    ...part4.foodVibeThemes,
    ...part4.flagVibeThemes,
    ...part4.sloganThemes
  ];
  const logoThemes = buildLogoThemes();
  const bank = [...allHandAuthored, ...logoThemes];

  // sanity checks
  const ids = new Set();
  for (const t of bank) {
    if (ids.has(t.id)) throw new Error('Duplicate theme id: ' + t.id);
    ids.add(t.id);
    if (t.questions.length !== 5) throw new Error('Theme ' + t.id + ' does not have exactly 5 questions');
    t.questions.forEach((q, i) => {
      if (q.price !== PRICES[i]) throw new Error('Theme ' + t.id + ' question ' + i + ' has wrong price ' + q.price);
      if (q.type === 'text' && (!q.accepted || q.accepted.length === 0)) {
        throw new Error('Theme ' + t.id + ' question ' + i + ' missing accepted answers');
      }
      if (q.type === 'select' && !q.correctOptionId) {
        throw new Error('Theme ' + t.id + ' question ' + i + ' missing correctOptionId');
      }
    });
  }

  const outPath = path.join(__dirname, '..', 'data', 'themesBank.json');
  fs.writeFileSync(outPath, JSON.stringify(bank, null, 2), 'utf8');
  console.log('Wrote', bank.length, 'themes (', bank.reduce((s, t) => s + t.questions.length, 0), 'questions ) to', outPath);

  // category breakdown
  const byCategory = {};
  for (const t of bank) byCategory[t.category] = (byCategory[t.category] || 0) + 1;
  console.log('By category:', byCategory);
}

main();
