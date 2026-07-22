require('./loadEnv').loadEnv();

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  SESSION_SECRET: process.env.SESSION_SECRET || 'change-me',

  // Optional durability backup for the 4 gitignored "runtime state" files
  // (players/accounts/activity/usedThemes -- see src/state/remoteBackup.js
  // header for the full story). Both blank = feature is completely off, app
  // behaves exactly as before. Get these from a free Upstash Redis database
  // (console.upstash.com, no credit card) -- see README.md "Чому зникають
  // акаунти на Render" for the 5-step setup.
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || '',
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || '',

  // Gameplay tuning -- safe to tweak without touching game logic.
  NEGATIVE_ON_WRONG: true,     // classic "Своя Гра" style: wrong/timeout subtracts price
  ANSWER_TIMEOUT_MS: 45000,    // time a team gets to answer once a question is opened
  HINT_COST_RATIO: 0.5,        // "купити підказку у адміна" costs this fraction of the question price
  HINT_EXTRA_MS: 15000,        // extra answer time granted when a hint is bought (dima's "гра зупинялась на 15 секунд")
  DEFAULT_THEMES_PER_ROUND: 5,
  DEFAULT_NUM_ROUNDS: 2,
  DEFAULT_NUM_TEAMS: 2, // dima 2026-07-21: "Зроби щоб по базі стояло 2 команди, а не 3"
  ADMIN_TOKEN_TTL_MS: 24 * 60 * 60 * 1000, // 24h

  // dima 2026-07-22 "коли один гравець виходить з лобі - другому автоматом
  // зараховували перемогу в любій грі" -- how long a mini-game (Battleship/
  // Checkers/Chess/Хрестики-нулики) opponent can stay disconnected before
  // the other player is auto-awarded the win (see miniGameManager.js's
  // scheduleDisconnectForfeit). Long enough that an ordinary page-refresh
  // reconnect (mgTryReconnect already handles this instantly and shouldn't
  // ever trip this) never gets punished, short enough nobody's stuck
  // waiting on a genuinely abandoned match. Same 45s as ANSWER_TIMEOUT_MS.
  MINIGAME_DISCONNECT_FORFEIT_MS: 45000,

  // KKoin economy (2026-07-21 "глобальний проект" expansion). Awarded to the
  // WINNING team in the quiz, split evenly across that team's members --
  // spendable later in Казино / мінi-ігри. Kept as a single tunable pool
  // rather than per-question payouts so the quiz's existing scoring math
  // (team.score, prices, hints) stays completely untouched -- KKoin is a
  // separate currency layered on top, not a replacement for the score.
  KKOIN_WIN_POOL: 100,

  // "Як отримати більше Крампус коїнів" menu (2026-07-21, dima's "+" button
  // next to the KKoin balance in Особистий кабінет) -- two more ways to earn
  // besides winning a quiz, both instant/honor-system (no admin approval gate
  // exists yet, matching the trust-based tone of the rest of this friend-group
  // app): submitting a Ukrainianized SiGame pack for dima to review later, and
  // clearing a level of the single-player "Бульбашки" (Bubble Spinner) game.
  SIQ_SUBMIT_KKOIN_REWARD: 20,
  BUBBLE_LEVEL_KKOIN_REWARD: 2,

  // "Поповнити моментально" button -- purely informational (opens a modal
  // pointing at dima's Telegram), never a real payment flow: this app must
  // never execute financial transactions itself.
  TOPUP_TELEGRAM_HANDLE: '@Traym',

  // Ready-check gate (dima: "вікторина починалась... тільки після того як
  // кожен учасник нажме кнопку Я готовий"). No timeout by default -- the
  // room just waits; the admin can still force-start if someone vanishes
  // (see roomManager.forceStartFromReadyCheck).
  READY_CHECK_ENABLED: true,

  ROUND_NAME_PAIRS: [
    ['Раунд перший, для розігріву', 'Раунд другий, вже серйозно'],
    ['Раунд 1: легка прогулянка', 'Раунд 2: тепер без пощади'],
    ['Спочатку м\'яко', 'А тепер по-справжньому'],
    ['Розминка мізків', 'Битва не на життя'],
    ['Раунд перший, любі друзі', 'А ось і раунд другий'],
    ['Перше коло', 'Друге коло, ставки ростуть']
  ]
};
