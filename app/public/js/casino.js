// Казино stub page (dima's spec: build the page now, real games later). Look
// and animations are modeled on the "Krampus Coin" reference dima linked
// (falling snow + a slow-spinning coin), recreated in plain CSS/JS since we
// have no React/Framer Motion here -- see style.css's .casino-* rules for the
// actual animation keyframes, this file just spawns the snowflakes and pulls
// the KKoin balance to display.
(function () {
  const NICK_KEY = 'sigame_nickname';
  const snowLayer = document.getElementById('casino-snow');
  const kkoinValue = document.getElementById('casino-kkoin-value');

  // Same randomized-inline-style technique as common.js's confettiBurst, but
  // a continuous ambient effect rather than a one-shot burst -- each flake
  // gets its own randomized horizontal position, fall duration, start delay
  // and size so the loop never looks mechanically uniform.
  function spawnSnow(count) {
    for (let i = 0; i < count; i++) {
      const flake = document.createElement('span');
      flake.className = 'casino-snowflake';
      flake.textContent = '❄';
      flake.style.left = (Math.random() * 100) + '%';
      flake.style.animationDuration = (7 + Math.random() * 7) + 's';
      flake.style.animationDelay = (Math.random() * 10) + 's';
      flake.style.fontSize = (10 + Math.random() * 12) + 'px';
      flake.style.opacity = String(0.3 + Math.random() * 0.5);
      snowLayer.appendChild(flake);
    }
  }
  if (snowLayer) spawnSnow(28);

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
