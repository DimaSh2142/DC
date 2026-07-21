// quiz.html landing page logic (2026-07-21 accounts expansion). Only job:
// hide the "Адмін-панель" button for everyone except an admin-role account
// (dima: "Щоб у звичайних гравців навіть не було кнопки Адмін панель у
// Вікторині"). This is a UI convenience, NOT the security boundary --
// admin.html has its own separate, server-checked password gate (see
// adminAuth.js / adminRoutes.js) that stays in place no matter what this
// script does. Hiding the button just avoids dangling a link in front of
// players who could never get past that gate anyway. Defaults to VISIBLE
// (matches the button's static HTML) so if this script fails to load for
// any reason, behavior just falls back to how it always worked before.
(function () {
  const link = document.getElementById('admin-panel-link');
  if (!link) return;

  function applyRole(role) {
    link.style.display = role === 'admin' ? '' : 'none';
  }

  const cached = getAuth();
  if (cached) applyRole(cached.role);

  // Re-verify against the server in the background so a stale cached role
  // (e.g. logged out elsewhere, or a hand-edited localStorage value) can't
  // leave the button visible/hidden incorrectly for long -- see
  // authSessions.requireSession for what's actually checked server-side.
  if (cached && cached.token) {
    fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + cached.token } })
      .then((r) => r.json().then((data) => ({ status: r.status, data })))
      .then(({ status, data }) => {
        if (status !== 200) { clearAuth(); applyRole(null); return; }
        applyRole(data.role);
      })
      .catch(() => {});
  }
})();
