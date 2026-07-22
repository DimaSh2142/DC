// Казино hub page. Rebuilt 2026-07-22 to match dima's base44 reference
// (CasinoHero.jsx/GamePanel.jsx) -- the old "coming soon" snow+coin stub is
// retired now that Blackjack is a real, playable game (see blackjack.html/
// blackjack.js); this file just pulls the KKoin balance to display.
(function () {
  const NICK_KEY = 'sigame_nickname';
  const kkoinValue = document.getElementById('casino-kkoin-value');

  // Same nickname-is-the-key identity as everywhere else (see
  // profileRoutes.js) -- if the visitor has never played/opened their
  // cabinet on this device, there's simply no balance to show yet.
  const nickname = (localStorage.getItem(NICK_KEY) || '').trim();
  if (nickname && kkoinValue) {
    fetch('/api/profile/' + encodeURIComponent(nickname))
      .then((r) => r.json())
      .then((data) => { if (data && data.profile) kkoinValue.textContent = data.profile.kkoin || 0; })
      .catch(() => { kkoinValue.textContent = '0'; });
  } else if (kkoinValue) {
    kkoinValue.textContent = '0';
  }
})();
