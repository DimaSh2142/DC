// Real achievement conditions for the "Особистий кабінет" rebuild
// (2026-07-22). dima's base44 reference (components/cabinet/Achievements.jsx)
// hardcodes 6 fake unlocked/locked badges with invented numbers ("Виграв
// 5 000 ₴", "Топ-10 рейтингу") -- rather than copy fake unlock states into a
// real app, every condition below is computed from data this app actually
// persists (playersStore.js fields + activityStore.js's real per-player
// activity log). No badge here can ever be unlocked by a number nobody
// actually reached.
//
// Pure function, no store access of its own (same "logic module takes a
// plain data object, has zero I/O" shape as src/logic/teamBalancer.js and
// answerMatcher.js) -- the caller (profileRoutes.js) is responsible for
// assembling `ctx` from playersStore/activityStore, which also makes this
// trivially unit-testable without faking any store.
//
// ctx shape: {
//   correct, incorrect, gamesPlayed, kkoin, items (array), bubbleLevel,
//   recentActivity: [{ label, win, ts }, ...] -- newest first, same order
//   activityStore.getRecentActivity() already returns them in.
// }

const ACHIEVEMENTS = [
  {
    id: 'erudite',
    title: 'Ерудит',
    desc: '50 правильних відповідей',
    emoji: '\u{1F9E0}', // 🧠
    accent: '#20B2AA',
    test: (ctx) => (ctx.correct || 0) >= 50
  },
  {
    id: 'veteran',
    title: 'Завсідник',
    desc: '10 зіграних вікторин',
    emoji: '\u{1F3AE}', // 🎮
    accent: '#3B82F6',
    test: (ctx) => (ctx.gamesPlayed || 0) >= 10
  },
  {
    id: 'rich',
    title: 'Багатій',
    desc: '500 KKoin на балансі',
    emoji: '\u{1F451}', // 👑
    accent: '#DAA520',
    test: (ctx) => (ctx.kkoin || 0) >= 500
  },
  {
    id: 'gambler',
    title: 'Азартний гравець',
    desc: 'Зіграв у Казино',
    emoji: '\u{1F3B2}', // 🎲
    accent: '#C71585',
    test: (ctx) => (ctx.recentActivity || []).some((a) => String(a.label || '').indexOf('Казино') === 0)
  },
  {
    id: 'streak',
    title: 'На хвилі',
    desc: '3 перемоги поспіль (за останніми подіями)',
    emoji: '\u{1F525}', // 🔥
    accent: '#C71585',
    test: (ctx) => {
      const list = ctx.recentActivity || [];
      if (list.length < 3) return false;
      return list[0].win && list[1].win && list[2].win;
    }
  },
  {
    id: 'team_player',
    title: 'Командний гравець',
    desc: 'Переміг у вікторині в складі команди',
    emoji: '\u{1F91D}', // 🤝
    accent: '#00FFD1',
    test: (ctx) => (ctx.recentActivity || []).some((a) => String(a.label || '').indexOf('Вікторина') === 0 && a.win)
  },
  {
    id: 'collector',
    title: 'Колекціонер',
    desc: 'Отримав першу річ на вивід',
    emoji: '\u{1F392}', // 🎒
    accent: '#DAA520',
    test: (ctx) => (ctx.items || []).length >= 1
  },
  {
    id: 'bubble_master',
    title: 'Бульбашковий майстер',
    desc: 'Досягнув 10-го рівня Бульбашок',
    emoji: '\u{1FAE7}', // 🫧
    accent: '#3B82F6',
    test: (ctx) => (ctx.bubbleLevel || 1) >= 10
  }
];

function computeAchievements(ctx) {
  const safeCtx = ctx || {};
  return ACHIEVEMENTS.map((a) => ({
    id: a.id,
    title: a.title,
    desc: a.desc,
    emoji: a.emoji,
    accent: a.accent,
    unlocked: !!a.test(safeCtx)
  }));
}

module.exports = { ACHIEVEMENTS, computeAchievements };
