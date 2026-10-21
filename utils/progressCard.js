function formatSpeed(speed) {
  if (typeof speed === 'string' && speed.trim()) return speed.trim();
  const value = Number(speed);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${(value / (1024 * 1024)).toFixed(1)} MB/s`;
}

function createProgress(sock, chatId, quotedMsg, {
  label = 'Downloading',
  delayMs = 8000,
  intervalMs = 4000,
} = {}) {
  const delay = Math.max(0, Number(delayMs) || 0);
  const interval = Math.max(0, Number(intervalMs) || 0);
  let state = {};
  let key = null;
  let ended = false;
  let sent = false;
  let lastEditAt = 0;
  let sendPromise = null;

  const text = () => {
    if (state.stage === 'uploading') return '⬆️ Uploading…';
    const pct = Number(state.pct);
    const percent = Number.isFinite(pct) ? ` ${Math.round(pct)}%` : '';
    const speed = formatSpeed(state.speed);
    return `⬇️ ${label}${percent}${speed ? ` · ${speed}` : ''}`;
  };

  const removeCard = async () => {
    if (!key) return;
    try { await sock.sendMessage(chatId, { delete: key }); } catch { /* ignore */ }
    key = null;
  };

  const timer = setTimeout(() => {
    if (ended || sent) return;
    sendPromise = (async () => {
      try {
        const message = await sock.sendMessage(chatId, { text: text() }, { quoted: quotedMsg });
        key = message?.key || null;
        sent = Boolean(key);
        lastEditAt = Date.now();
        if (ended) await removeCard();
      } catch { /* progress is best-effort */ }
    })();
  }, delay);
  timer.unref?.();

  return {
    update(next = {}) {
      if (ended) return;
      state = { ...state, ...next };
      if (!sent || !key || Date.now() - lastEditAt < interval) return;
      lastEditAt = Date.now();
      try {
        Promise.resolve(sock.sendMessage(chatId, { text: text(), edit: key })).catch(() => {});
      } catch { /* ignore */ }
    },
    async done() {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (sendPromise) await sendPromise;
      await removeCard();
    },
  };
}

module.exports = { createProgress };
