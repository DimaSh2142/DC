require('./loadEnv').loadEnv();

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  SESSION_SECRET: process.env.SESSION_SECRET || 'change-me',

  // Gameplay tuning -- safe to tweak without touching game logic.
  NEGATIVE_ON_WRONG: true,     // classic "Своя Гра" style: wrong/timeout subtracts price
  ANSWER_TIMEOUT_MS: 45000,    // time a team gets to answer once a question is opened
  DEFAULT_THEMES_PER_ROUND: 5,
  DEFAULT_NUM_ROUNDS: 2,
  DEFAULT_NUM_TEAMS: 3,
  ADMIN_TOKEN_TTL_MS: 24 * 60 * 60 * 1000, // 24h

  ROUND_NAME_PAIRS: [
    ['Раунд перший, для розігріву', 'Раунд другий, вже серйозно'],
    ['Раунд 1: легка прогулянка', 'Раунд 2: тепер без пощади'],
    ['Спочатку м\'яко', 'А тепер по-справжньому'],
    ['Розминка мізків', 'Битва не на життя'],
    ['Раунд перший, любі друзі', 'А ось і раунд другий'],
    ['Перше коло', 'Друге коло, ставки ростуть']
  ]
};
