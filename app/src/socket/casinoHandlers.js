// Socket wiring for casino games. Currently just Blackjack (single-player
// vs the house) -- namespaced "casino:" the same way mini-games use "mg:".
// No room/broadcast concept needed here, unlike miniGameHandlers.js: it's
// always just this one socket's own hand, acknowledged directly back to it,
// never a shared state that needs to fan out to a second player.

function safe(handler) {
  return async function (...args) {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      await handler(...args);
    } catch (err) {
      console.error('[casino-socket] handler error:', err);
      if (cb) cb({ error: 'Внутрішня помилка сервера' });
    }
  };
}

function registerCasinoHandlers(io, { blackjackManager }) {
  io.on('connection', (socket) => {
    socket.on('casino:blackjack_deal', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const stake = payload && payload.stake;
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackManager.deal(nickname, stake);
      if (result.error) return cb && cb({ error: result.error });
      if (cb) cb({ ok: true, view: result.view });
    }));

    socket.on('casino:blackjack_hit', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackManager.hit(nickname);
      if (result.error) return cb && cb({ error: result.error });
      if (cb) cb({ ok: true, view: result.view });
    }));

    socket.on('casino:blackjack_stand', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      if (!nickname) return cb && cb({ error: 'Введіть нікнейм' });
      const result = blackjackManager.stand(nickname);
      if (result.error) return cb && cb({ error: result.error });
      if (cb) cb({ ok: true, view: result.view });
    }));

    // Used on page load/refresh to resume an in-progress hand (mirrors the
    // mini-games' mg:reconnect idea, just much simpler -- there's no seat/
    // room to re-attach to, only "is there a hand for this nickname").
    socket.on('casino:blackjack_state', safe(async (payload, cb) => {
      const nickname = (payload && payload.nickname || '').trim().slice(0, 24);
      const view = nickname ? blackjackManager.currentView(nickname) : null;
      if (cb) cb({ ok: true, view });
    }));
  });
}

module.exports = { registerCasinoHandlers };
