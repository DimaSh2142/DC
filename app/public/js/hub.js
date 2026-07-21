// Головна сторінка (2026-07-21, base44-натхненний темний редизайн, dima
// п.4: "скопіюй 1 в один"). Єдина крихта JS, яку цей новий дизайн потребує --
// живий UTC-годинник поруч із декоративним "● ONLINE" індикатором у футері
// (див. style.css .hub-footer-status/.hub-status-dot). Суто косметика, як і
// confetti/round-banner деінде на сайті -- НЕ пов'язано з реальним
// онлайн-статусом сервера чи кількістю гравців, просто той самий "живий"
// штрих, що був на скріні сайту від base44.
(function () {
  const clockEl = document.getElementById('hub-utc-clock');
  if (!clockEl) return;
  function tick() {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    clockEl.textContent = hh + ':' + mm;
  }
  tick();
  setInterval(tick, 15000);
})();
