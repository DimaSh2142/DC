// One-off content build script: merges hand-authored themes with
// procedurally-generated "correct logo" themes into data/themesBank.json.
// Run manually with `node scripts/buildThemeBank.js` whenever the bank
// needs to be regenerated/extended -- NOT required for normal app startup
// (the bank is a static data file the server reads).

const fs = require('fs');
const path = require('path');
const { generateLogoChallenge } = require('../src/logo/logoGenerator');
// Real .siq packs dima provided (4 Ukrainian + 3 Russian, kept untranslated
// per his instruction) -- see PROGRESS.md for the extraction pipeline. This
// REPLACES the old hand-authored text-vibe placeholder bank (part1-4),
// which existed only as a stopgap for when no real quiz packs were
// available yet (dima's instruction: "Видали старі теми та запитання").
const importedSiqThemes = require('../data/importedSiqThemes.json');

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
  const logoThemes = buildLogoThemes();
  const bank = [...importedSiqThemes, ...logoThemes];

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
