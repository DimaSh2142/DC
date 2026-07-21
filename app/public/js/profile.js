// "Особистий кабінет" (personal cabinet) page logic. Plain REST against
// /api/profile/:nickname (see src/routes/profileRoutes.js) -- deliberately no
// socket.io connection here at all, unlike player.js/admin.js, since this
// page has no room context (see that file's header comment for why).
(function () {
  const NICK_KEY = 'sigame_nickname';

  let currentNickname = (localStorage.getItem(NICK_KEY) || '').trim();
  let profile = null; // { nickname, correct, incorrect, gamesPlayed, lastSeen, avatar, kkoin }
  let locked = false;
  let avatarSaveInFlight = false; // guards double-submit while a PATCH is in flight

  const gateSection = document.getElementById('gate-section');
  const gateForm = document.getElementById('gate-form');
  const gateInput = document.getElementById('gate-nickname');
  const gatePasswordInput = document.getElementById('gate-password');
  const cabinetBackLink = document.getElementById('cabinet-back-link');
  const profileSection = document.getElementById('profile-section');
  const lockedBanner = document.getElementById('locked-banner');
  const avatarPreviewWrap = document.getElementById('avatar-preview-wrap');
  const avatarPicker = document.getElementById('avatar-picker');
  const avatarPickerLabel = document.getElementById('avatar-picker-label');
  const avatarFileInput = document.getElementById('avatar-file-input');
  const avatarPresetBtn = document.getElementById('avatar-preset-btn');
  const nicknameInput = document.getElementById('nickname-input');
  const saveNicknameBtn = document.getElementById('save-nickname-btn');
  const switchProfileBtn = document.getElementById('switch-profile-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const accountBadge = document.getElementById('account-badge');
  const adminGrantPanel = document.getElementById('admin-grant-panel');
  const grantNicknameInput = document.getElementById('grant-nickname');
  const grantAmountInput = document.getElementById('grant-amount');
  const grantKkoinBtn = document.getElementById('grant-kkoin-btn');
  const statCorrect = document.getElementById('stat-correct');
  const statIncorrect = document.getElementById('stat-incorrect');
  const statGames = document.getElementById('stat-games');
  const kkoinAmount = document.getElementById('kkoin-amount');
  const kkoinAddBtn = document.getElementById('kkoin-add-btn');
  const itemsEmpty = document.getElementById('items-empty');
  const itemsList = document.getElementById('items-list');
  const themeTabs = document.getElementById('theme-tabs');
  const musicVolumeEl = document.getElementById('music-volume');
  const musicVolumeValue = document.getElementById('music-volume-value');
  const micVolumeEl = document.getElementById('mic-volume');
  const micVolumeValue = document.getElementById('mic-volume-value');

  // Local copy of the same resize helper player.js uses for avatar uploads.
  // player.js can't be reused directly here -- it's wrapped in its own IIFE
  // and opens a socket.io connection the instant it loads, which this
  // no-room, plain-REST page has no business doing.
  // Raw-bytes file reader (as opposed to readAndResizeImage below, which
  // decodes+recompresses as an image) -- used for the "Закинь українізовану
  // SiGame" .siq upload, since a .siq is an arbitrary zip archive, not
  // something a <canvas> can touch. Strips the "data:...;base64," prefix
  // FileReader.readAsDataURL adds, leaving just the base64 payload the
  // server expects (see submit-pack route in profileRoutes.js).
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(file);
    });
  }

  function readAndResizeImage(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) return reject(new Error('Файл має бути зображенням'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Не вдалося розпізнати зображення'));
        img.onload = () => {
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = maxSize; canvas.height = maxSize;
          canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function api(path, options) {
    return fetch(path, options).then((r) => r.json().then((data) => ({ status: r.status, data })));
  }

  function renderAvatarPreview() {
    clear(avatarPreviewWrap);
    avatarPreviewWrap.appendChild(avatarEl(profile, 72));
  }

  function renderProfile() {
    renderAvatarPreview();
    nicknameInput.value = profile.nickname;
    nicknameInput.disabled = locked;
    saveNicknameBtn.disabled = locked;
    avatarPicker.style.opacity = locked ? '.5' : '1';
    avatarPicker.style.pointerEvents = locked ? 'none' : 'auto';
    avatarPickerLabel.textContent = locked ? 'Заблоковано' : 'Змінити фото';
    avatarPresetBtn.disabled = locked;
    lockedBanner.style.display = locked ? '' : 'none';

    statCorrect.textContent = profile.correct || 0;
    statIncorrect.textContent = profile.incorrect || 0;
    statGames.textContent = profile.gamesPlayed || 0;
    kkoinAmount.textContent = profile.kkoin || 0;
    renderItems();
    renderAccountBadge();
    applyAdminPanelVisibility();
  }

  // ---- accounts (2026-07-21 "система реєстрації + логін" expansion) ----
  // See common.js's getAuth/setAuth/clearAuth and src/routes/authRoutes.js.
  // "🔑 Акаунт" only shows when the CACHED session actually matches the
  // profile currently open (same device could have an old admin session
  // cached from an earlier nickname -- see the gate-submit handler's
  // clearAuth() on the no-password path, which exists specifically to avoid
  // that leaking into someone else's guest view on a shared computer).
  function sessionMatchesOpenProfile(auth) {
    return !!(auth && auth.login && currentNickname && auth.login.trim().toLowerCase() === currentNickname.trim().toLowerCase());
  }

  function renderAccountBadge() {
    const auth = getAuth();
    if (sessionMatchesOpenProfile(auth)) {
      accountBadge.textContent = auth.role === 'admin' ? '🛡️ Акаунт (адмін)' : '🔑 Акаунт';
    } else {
      accountBadge.textContent = '👤 Гість (без пароля)';
    }
    logoutBtn.style.display = sessionMatchesOpenProfile(auth) ? '' : 'none';
  }

  function applyAdminPanelVisibility() {
    const auth = getAuth();
    adminGrantPanel.style.display = (sessionMatchesOpenProfile(auth) && auth.role === 'admin') ? '' : 'none';
  }

  function setBackLinkToHome() {
    cabinetBackLink.textContent = '← На головну';
    cabinetBackLink.href = '/';
    cabinetBackLink.onclick = null;
  }

  // dima 2026-07-21 screenshot 1: "щоб повернення було назад в кабінет а не
  // на головну" -- only relevant in the one moment the gate is shown WHILE a
  // cabinet was already open (i.e. mid "Інший нікнейм"): "back" there should
  // cancel that and return to the cabinet you already had open, not bounce
  // you out to the homepage. On a fresh page load (no cabinet opened yet)
  // the link stays the ordinary home link -- there's nothing to "go back" to.
  function setBackLinkToCabinet() {
    cabinetBackLink.textContent = '← Назад у кабінет';
    cabinetBackLink.href = '#';
    cabinetBackLink.onclick = (e) => {
      e.preventDefault();
      gateSection.style.display = 'none';
      profileSection.style.display = '';
      setBackLinkToHome();
    };
  }

  // Tries logging in with whatever password was typed; if this nickname has
  // no account yet, treats typing a password at all as "create one for me"
  // (dima: "щоб звичайні гравці могли створити акаунт... Робимо систему
  // реєстрації... або log in") -- no separate register screen needed, one
  // field does both jobs.
  function authenticateAndOpen(nickname, password) {
    api('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: nickname, password })
    }).then(({ status, data }) => {
      if (status === 200) {
        setAuth({ token: data.token, login: data.login, role: data.role });
        return loadProfile(data.login);
      }
      if (data && data.code === 'ACCOUNT_NOT_FOUND') {
        return api('/api/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login: nickname, password })
        }).then(({ status: regStatus, data: regData }) => {
          if (regStatus !== 200) return toast((regData && regData.error) || 'Не вдалося створити акаунт', true);
          setAuth({ token: regData.token, login: regData.login, role: regData.role });
          toast('Акаунт створено!');
          loadProfile(regData.login);
        });
      }
      toast((data && data.error) || 'Невірний пароль', true);
    }).catch(() => toast('Не вдалося з’єднатися із сервером', true));
  }

  // "Речі на вивід" -- forward-looking scaffolding for future Казино
  // lootbox winnings (see task header comment in playersStore.js). Almost
  // always the empty state today since case-opening doesn't exist yet, but
  // already renders real entries the instant profile.items has any.
  function renderItems() {
    const items = (profile && Array.isArray(profile.items)) ? profile.items : [];
    itemsEmpty.style.display = items.length ? 'none' : '';
    clear(itemsList);
    items.forEach((item) => {
      itemsList.appendChild(el('div', { class: 'item-card' }, [
        el('div', { class: 'item-card-emoji' }, [item.emoji || '🎁']),
        el('div', {}, [item.name || 'Річ'])
      ]));
    });
  }

  function loadProfile(nickname) {
    api('/api/profile/' + encodeURIComponent(nickname)).then(({ status, data }) => {
      if (status !== 200 || data.error) { toast((data && data.error) || 'Не вдалося завантажити профіль', true); return; }
      profile = data.profile;
      locked = !!data.locked;
      currentNickname = profile.nickname;
      localStorage.setItem(NICK_KEY, currentNickname);
      gateSection.style.display = 'none';
      profileSection.style.display = '';
      setBackLinkToHome();
      renderProfile();
    }).catch(() => toast('Не вдалося з’єднатися із сервером', true));
  }

  gateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = gateInput.value.trim();
    const password = gatePasswordInput.value;
    if (!nickname) return toast('Введіть нікнейм', true);
    if (!password) {
      // Guest path, unchanged from before accounts existed -- also drops any
      // previously-cached session so a shared device can't leak an earlier
      // person's admin panel/account badge into this nickname's guest view.
      clearAuth();
      return loadProfile(nickname);
    }
    authenticateAndOpen(nickname, password);
  });

  switchProfileBtn.addEventListener('click', () => {
    profileSection.style.display = 'none';
    gateSection.style.display = '';
    gateInput.value = '';
    gatePasswordInput.value = '';
    setBackLinkToCabinet();
    gateInput.focus();
  });

  logoutBtn.addEventListener('click', () => {
    const auth = getAuth();
    if (auth && auth.token) {
      api('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token } }).catch(() => {});
    }
    clearAuth();
    toast('Вийшли з акаунту');
    renderAccountBadge();
    applyAdminPanelVisibility();
  });

  grantKkoinBtn.addEventListener('click', () => {
    const auth = getAuth();
    if (!auth || !auth.token) return toast('Спочатку увійди в акаунт адміністратора', true);
    const targetNickname = grantNicknameInput.value.trim();
    const amount = Number(grantAmountInput.value);
    if (!targetNickname) return toast('Вкажи нікнейм гравця', true);
    if (!Number.isFinite(amount) || amount === 0) return toast('Вкажи кількість (не нуль)', true);
    api('/api/auth/grant-kkoin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
      body: JSON.stringify({ nickname: targetNickname, amount })
    }).then(({ status, data }) => {
      if (status !== 200) return toast((data && data.error) || 'Не вдалося видати KKrampus coin', true);
      toast('Видано ' + amount + ' KKrampus coin гравцю ' + targetNickname + ' (баланс: ' + data.profile.kkoin + ')');
      grantNicknameInput.value = '';
      grantAmountInput.value = '';
      // Granting to yourself should show up on your own visible balance too.
      if (targetNickname.trim().toLowerCase() === currentNickname.trim().toLowerCase()) {
        profile = data.profile;
        renderProfile();
      }
    }).catch(() => toast('Не вдалося з’єднатися із сервером', true));
  });

  avatarPicker.addEventListener('click', () => { if (!locked) avatarFileInput.click(); });
  avatarFileInput.addEventListener('change', () => {
    const file = avatarFileInput.files && avatarFileInput.files[0];
    avatarFileInput.value = '';
    if (!file || locked || avatarSaveInFlight) return;
    avatarSaveInFlight = true;
    readAndResizeImage(file, 128, 0.75).then((dataUrl) => api('/api/profile/' + encodeURIComponent(currentNickname), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: dataUrl })
    })).then(({ status, data }) => {
      avatarSaveInFlight = false;
      if (status !== 200 || data.error) return toast((data && data.error) || 'Не вдалося оновити фото', true);
      profile = data.profile;
      localStorage.setItem('sigame_avatar', profile.avatar || '');
      renderProfile();
      toast('Аватарку оновлено!');
    }).catch((err) => { avatarSaveInFlight = false; toast(err.message || 'Не вдалося оновити фото', true); });
  });

  // ---- "Готові аватарки" (2026-07-21 asset expansion) -- 20 flat character
  // badges cut from Kay Lousberg's CC0 "KayKit: Board Game Bits" pack (see
  // README.md "Готові аватарки та інші нові текстури" for the attribution
  // this pack doesn't legally require but is nice to give anyway). Static
  // files under /img/avatar-presets/ are only 112x112 already, but still get
  // pushed through the exact same canvas round-trip as an uploaded photo (via
  // PNG this time, not JPEG -- these have a transparent background a lossy
  // JPEG would flatten to a black/white square) so the server sees the same
  // kind of self-contained data: URL either path produces, and
  // roomManager.normalizeAvatar doesn't need a second code path to trust it.
  const AVATAR_PRESETS = [
    'blue_knight', 'blue_mage', 'blue_rogue', 'blue_barbarian',
    'red_knight', 'red_mage', 'red_rogue', 'red_barbarian',
    'green_knight', 'green_mage', 'green_rogue', 'green_barbarian',
    'yellow_knight', 'yellow_mage', 'yellow_rogue', 'yellow_barbarian',
    'skeleton_brute', 'skeleton_mage', 'skeleton_rogue', 'skeleton_minion'
  ];

  function presetLabel(id) {
    return id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  function presetUrlToDataUrl(url) {
    return fetch(url).then((r) => r.blob()).then((blob) => new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Не вдалося завантажити аватарку')); };
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(objectUrl);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = objectUrl;
    }));
  }

  function choosePresetAvatar(id) {
    if (locked || avatarSaveInFlight) return;
    avatarSaveInFlight = true;
    presetUrlToDataUrl('/img/avatar-presets/' + id + '.png').then((dataUrl) => api('/api/profile/' + encodeURIComponent(currentNickname), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: dataUrl })
    })).then(({ status, data }) => {
      avatarSaveInFlight = false;
      if (status !== 200 || data.error) return toast((data && data.error) || 'Не вдалося оновити фото', true);
      profile = data.profile;
      localStorage.setItem('sigame_avatar', profile.avatar || '');
      renderProfile();
      closeModal();
      toast('Аватарку оновлено!');
    }).catch((err) => { avatarSaveInFlight = false; toast(err.message || 'Не вдалося оновити фото', true); });
  }

  avatarPresetBtn.addEventListener('click', () => {
    if (locked) return;
    const grid = el('div', { class: 'avatar-preset-grid' }, AVATAR_PRESETS.map((id) => el('button', {
      type: 'button', class: 'avatar-preset-item', title: presetLabel(id), onclick: () => choosePresetAvatar(id)
    }, [el('img', { src: '/img/avatar-presets/' + id + '.png', alt: presetLabel(id), width: '56', height: '56' })])));
    openModal('Готові аватарки', [grid]);
  });

  saveNicknameBtn.addEventListener('click', () => {
    if (locked) return;
    const newNickname = nicknameInput.value.trim();
    if (!newNickname) return toast('Нікнейм не може бути порожнім', true);
    if (newNickname === profile.nickname) return toast('Нікнейм не змінився');
    api('/api/profile/' + encodeURIComponent(currentNickname), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: newNickname })
    }).then(({ status, data }) => {
      if (status !== 200 || data.error) return toast((data && data.error) || 'Не вдалося змінити нікнейм', true);
      profile = data.profile;
      currentNickname = profile.nickname;
      localStorage.setItem(NICK_KEY, currentNickname);
      renderProfile();
      toast('Нікнейм оновлено!');
    }).catch(() => toast('Не вдалося з’єднатися із сервером', true));
  });

  // ---- "Як отримати більше KKrampus coin" (2026-07-21, dima's "+" button) ----
  kkoinAddBtn.addEventListener('click', openEarnMenu);

  function openEarnMenu() {
    const level = (profile && profile.bubbleLevel) || 1;
    openModal('Як отримати більше KKrampus coin', [
      el('div', { class: 'stack' }, [
        el('button', { type: 'button', class: 'earn-menu-btn', onclick: openSubmitPackModal }, [
          el('span', { class: 'earn-menu-btn-title' }, ['📦 Закинь українізовану SiGame']),
          el('span', { class: 'earn-menu-btn-sub' }, ['Надішли свій .siq файл — одразу +20 KKrampus coin на баланс'])
        ]),
        el('button', { type: 'button', class: 'earn-menu-btn btn-outline', onclick: () => { window.location.href = '/bubbles.html'; } }, [
          el('span', { class: 'earn-menu-btn-title' }, ['🫧 Пройти міні-гру «Бульбашки»']),
          el('span', { class: 'earn-menu-btn-sub' }, ['Твій рівень: ' + level + ' — +2 KKrampus coin за кожен пройдений рівень, далі складніше'])
        ]),
        el('button', { type: 'button', class: 'earn-menu-btn btn-outline orange', onclick: openTopupModal }, [
          el('span', { class: 'earn-menu-btn-title' }, ['⚡ Поповнити моментально']),
          el('span', { class: 'earn-menu-btn-sub' }, ['Напряму через Telegram'])
        ])
      ])
    ]);
  }

  function openTopupModal() {
    openModal('Поповнити моментально', [
      el('p', {}, ['Просто напишіть сюди:']),
      el('p', { style: 'text-align:center; margin:14px 0;' }, [
        el('a', { href: 'https://t.me/Traym', target: '_blank', rel: 'noopener', style: 'font-size:20px; font-weight:800;' }, ['@Traym'])
      ])
    ]);
  }

  function openSubmitPackModal() {
    let pendingFile = null;
    const fileLabel = el('div', { class: 'kkoin-label', style: 'margin-bottom:10px;' }, ['Файл не обрано']);
    const fileInput = el('input', {
      type: 'file', accept: '.siq', style: 'display:none;',
      onchange: (e) => {
        pendingFile = (e.target.files && e.target.files[0]) || null;
        fileLabel.textContent = pendingFile ? pendingFile.name : 'Файл не обрано';
      }
    });
    const pickBtn = el('button', { type: 'button', class: 'btn-outline', onclick: () => fileInput.click() }, ['Обрати .siq файл']);
    const submitBtn = el('button', { type: 'button', onclick: () => submitPack(pendingFile, submitBtn) }, ['Надіслати й отримати +20 KKrampus coin']);
    openModal('Закинь українізовану SiGame', [
      el('p', {}, ['Обери свій українізований .siq файл (пак SiGame). Дима перегляне його й додасть у банк тем — а тобі одразу нарахується 20 KKrampus coin на баланс.']),
      pickBtn, fileInput, fileLabel,
      el('div', { class: 'stack', style: 'margin-top:14px;' }, [submitBtn])
    ]);
  }

  function submitPack(file, submitBtn) {
    if (!file) return toast('Спочатку обери .siq файл', true);
    if (!/\.siq$/i.test(file.name)) return toast('Очікується файл з розширенням .siq', true);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Надсилаємо...';
    readFileAsBase64(file).then((dataBase64) => api('/api/profile/' + encodeURIComponent(currentNickname) + '/submit-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, dataBase64 })
    })).then(({ status, data }) => {
      if (status !== 200 || data.error) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Надіслати й отримати +20 KKrampus coin';
        return toast((data && data.error) || 'Не вдалося надіслати файл', true);
      }
      profile = data.profile;
      renderProfile();
      closeModal();
      toast('Дякуємо! Нараховано +' + data.awarded + ' KKrampus coin 🪙');
    }).catch(() => {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Надіслати й отримати +20 KKrampus coin';
      toast('Не вдалося з’єднатися із сервером', true);
    });
  }

  // ---- settings (pure client-side localStorage prefs, see common.js) ----
  function renderThemeTabs() {
    const current = getTheme();
    Array.from(themeTabs.children).forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-theme') === current);
    });
  }
  themeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    setTheme(btn.getAttribute('data-theme'));
    renderThemeTabs();
  });

  musicVolumeEl.addEventListener('input', () => {
    musicVolumeValue.textContent = musicVolumeEl.value;
    setMusicVolume(musicVolumeEl.value);
  });
  micVolumeEl.addEventListener('input', () => {
    micVolumeValue.textContent = micVolumeEl.value;
    setMicVolume(micVolumeEl.value);
  });

  function initSettingsControls() {
    renderThemeTabs();
    musicVolumeEl.value = getMusicVolume();
    musicVolumeValue.textContent = musicVolumeEl.value;
    micVolumeEl.value = getMicVolume();
    micVolumeValue.textContent = micVolumeEl.value;
  }

  initSettingsControls();
  if (currentNickname) loadProfile(currentNickname);
  else gateInput.focus();
})();
